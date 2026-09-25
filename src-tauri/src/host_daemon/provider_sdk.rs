use super::protocol::Result;
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

pub(super) trait Events: Send + Sync {
    fn event(&self, packet: Value);
}

pub(super) struct Sdk {
    executable: String,
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
            events,
            connection: AsyncMutex::new(None),
            stopped: AtomicBool::new(false),
        }
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
            "{}\n{}",
            include_str!("../../../extensions/piop-runtime-settings/provider-accounts.mjs"),
            include_str!("../../resources/provider-sdk.mjs")
        );
        let mut child = Command::new("node")
            .args(["--input-type=module", "-e", &source, "--", &self.executable])
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
            connection
                .stdin
                .lock()
                .await
                .write_all(data.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
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
