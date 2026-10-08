use super::protocol::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
};
use uuid::Uuid;

const SOURCE_ARGUMENT_BYTES: usize = 64 * 1024;
const SOURCE_LOADER: &str = "await import('data:text/javascript;base64,' + process.argv.splice(2).join(''));";

fn source_arguments(encoded: &str) -> impl Iterator<Item = &str> {
    (0..encoded.len()).step_by(SOURCE_ARGUMENT_BYTES).map(|start| {
        &encoded[start..encoded.len().min(start + SOURCE_ARGUMENT_BYTES)]
    })
}

pub(super) trait Events: Send + Sync {
    fn event(&self, packet: Value);
}

struct QuietEvents;

impl Events for QuietEvents {
    fn event(&self, _packet: Value) {}
}

pub(crate) async fn resolve_provider_auth(executable: String, provider_id: &str) -> Result<Value> {
    let sdk = Sdk::new(executable, Arc::new(QuietEvents));
    let result = tokio::time::timeout(Duration::from_secs(30), sdk.request(json!({"method":"auth","providerId":provider_id})))
        .await.map_err(|_| "Pi provider credential resolution timed out".to_owned());
    sdk.shutdown().await;
    result?
}

pub(super) struct Sdk {
    executable: String,
    plugin: Option<&'static str>,
    events: Arc<dyn Events>,
    connection: AsyncMutex<Option<Arc<Connection>>>,
    stopped: AtomicBool,
}

struct Connection {
    stdin: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>,
    closed: AtomicBool,
    stop: mpsc::UnboundedSender<()>,
}

impl Drop for Sdk {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.get_mut().take() {
            let _ = connection.stop.send(());
        }
    }
}

struct PendingRequest<'a> {
    connection: &'a Connection,
    id: &'a str,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        self.connection
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(self.id);
    }
}

impl Sdk {
    pub fn new(executable: String, events: Arc<dyn Events>) -> Self {
        Self {
            executable,
            plugin: None,
            events,
            connection: AsyncMutex::new(None),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn plugin(executable: String, events: Arc<dyn Events>, source: &'static str) -> Self {
        let mut sdk = Self::new(executable, events);
        sdk.plugin = Some(source);
        sdk
    }

    async fn connect(&self) -> Result<Arc<Connection>> {
        let mut current = self.connection.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return Err("Provider SDK stopped".into());
        }
        if let Some(connection) = current.as_ref().filter(|connection| !connection.closed.load(Ordering::SeqCst)) {
            return Ok(connection.clone());
        }
        let source = format!(
            "{}\n{}\n{}\n{}\n{}",
            include_str!("../../resources/sdk-storage.mjs"),
            include_str!("../../resources/provider-accounts.bundle.mjs"),
            include_str!("../../resources/fast-capabilities.mjs"),
            self.plugin.unwrap_or("const bundledPlugin = null;"),
            include_str!("../../resources/provider-sdk.mjs")
        );
        let encoded = STANDARD.encode(source);
        let mut child = Command::new("node")
            .args(["--input-type=module", "-e", SOURCE_LOADER, "--", &self.executable])
            .args(source_arguments(&encoded))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Could not start Pi provider SDK: {error}"))?;
        let stdin = child.stdin.take().ok_or("Provider SDK input unavailable")?;
        let stdout = child.stdout.take().ok_or("Provider SDK output unavailable")?;
        let (stop, mut stopping) = mpsc::unbounded_channel();
        let connection = Arc::new(Connection {
            stdin: AsyncMutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            stop,
        });
        let reader = connection.clone();
        let events = self.events.clone();
        let read_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(packet) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if packet["event"].is_string() {
                    events.event(packet);
                    continue;
                }
                let Some(id) = packet["id"].as_str() else {
                    continue;
                };
                let pending = reader.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(id);
                if let Some(reply) = pending {
                    let result = packet["error"]
                        .as_str()
                        .map(|error| Err(error.to_owned()))
                        .unwrap_or_else(|| Ok(packet["data"].clone()));
                    let _ = reply.send(result);
                }
            }
        });
        let process = connection.clone();
        tokio::spawn(async move {
            tokio::select! { _ = child.wait() => {}, _ = stopping.recv() => { let _ = child.kill().await; } }
            let _ = read_task.await;
            process.closed.store(true, Ordering::SeqCst);
            for (_, reply) in process.pending.lock().unwrap_or_else(|error| error.into_inner()).drain() {
                let _ = reply.send(Err("Pi provider SDK disconnected".into()));
            }
        });
        *current = Some(connection.clone());
        Ok(connection)
    }

    pub async fn request(&self, mut packet: Value) -> Result<Value> {
        let connection = self.connect().await?;
        let id = Uuid::new_v4().to_string();
        packet["id"] = json!(id);
        let (reply, incoming) = oneshot::channel();
        connection
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.clone(), reply);
        let _pending = PendingRequest {
            connection: &connection,
            id: &id,
        };
        let data = format!("{packet}\n");
        let result = async {
            if connection.closed.load(Ordering::SeqCst) {
                return Err("Pi provider SDK disconnected".into());
            }
            let mut stdin = connection.stdin.lock().await;
            if self.plugin.is_some() && packet["method"] == "plugin_call" && crate::daemon_restart::blocking() {
                return Err("The daemon is restarting. Reconnect before retrying.".into());
            }
            stdin.write_all(data.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            drop(stdin);
            tokio::time::timeout(Duration::from_secs(630), incoming)
                .await
                .map_err(|_| "Pi provider SDK request timed out")?
                .map_err(|_| "Pi provider SDK disconnected".to_owned())?
        }
        .await;
        result
    }

    pub async fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(connection) = self.connection.lock().await.take() {
            let _ = connection.stop.send(());
        }
    }
}
