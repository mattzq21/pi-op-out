use super::{protocol::{kind, wire_command, LaunchSpec, Result}, session::SessionCallbacks};
use serde_json::Value;
use sha2::{Digest, Sha256};
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
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, watch, Mutex as AsyncMutex},
};
use uuid::Uuid;

pub(super) struct Request {
    pub command: Value,
    pub request_type: String,
    pub snapshot_state: Value,
    reply: oneshot::Sender<Result<Value>>,
}

pub(super) struct RuntimeWorker {
    stdin: AsyncMutex<ChildStdin>,
    pending: Mutex<HashMap<String, Request>>,
    signals: mpsc::UnboundedSender<bool>,
    closed: watch::Receiver<bool>,
    exited: AtomicBool,
    observer: Arc<SessionCallbacks>,
    timeout: Duration,
}

fn launch_command(spec: &LaunchSpec, identity: &str, home: &std::path::Path) -> Result<Command> {
    let mut command = if let Some(directory) = spec.env.get("PIOP_REMOTE_SESSION_CLAIMS") {
        let directory = home.join(directory).join("session-claims");
        crate::ensure_private_dir(&directory)?;
        let hash = format!("{:x}", Sha256::digest(identity.to_lowercase().as_bytes()));
        let mut command = Command::new("flock");
        command
            .args(["--nonblock", "--no-fork"])
            .arg(directory.join(format!("id-{}.lock", &hash[..40])))
            .arg(&spec.program);
        command
    } else {
        Command::new(&spec.program)
    };
    command.args(&spec.args).envs(&spec.env).env(
        "PI_DESKTOP_GIT_CAPTURE_SCRIPT",
        crate::session_registry::with_database(include_str!("../../resources/capture-git-tree.cjs")),
    ).env("PIOP_GIT_CAPTURE_READER_PID", std::process::id().to_string());
    if let Some(cwd) = spec.cwd.as_ref().filter(|cwd| !cwd.is_empty()) {
        command.current_dir(cwd);
    }
    Ok(command)
}

async fn supervise(child: &mut Child, mut signals: mpsc::UnboundedReceiver<bool>) {
    let mut deadline = None;
    loop {
        tokio::select! {
            _ = child.wait() => break,
            signal = signals.recv() => {
                if signal == Some(true) || signal.is_none() { let _ = child.start_kill(); }
                else {
                    terminate(child);
                    deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(5));
                }
            }
            _ = async {
                if let Some(deadline) = deadline { tokio::time::sleep_until(deadline).await; }
                else { std::future::pending::<()>().await; }
            } => { let _ = child.start_kill(); deadline = None; }
        }
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        unsafe {
            libc::kill(id as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.start_kill();
    }
}

impl RuntimeWorker {
    pub fn spawn(
        spec: &LaunchSpec,
        identity: &str,
        timeout: Duration,
        observer: Arc<SessionCallbacks>,
        home: &std::path::Path,
    ) -> Result<Arc<Self>> {
        let mut child = launch_command(spec, identity, home)?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("Pi stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Pi stderr is unavailable")?;
        let (signals, incoming_signals) = mpsc::unbounded_channel();
        let (closed_tx, closed) = watch::channel(false);
        let worker = Arc::new(Self {
            stdin: AsyncMutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            signals,
            closed,
            exited: AtomicBool::new(false),
            observer,
            timeout,
        });
        let reader = worker.clone();
        let stdout_task = tokio::spawn(async move { reader.read_events(stdout).await });
        let errors = worker.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                errors.observer.stderr(line);
            }
        });
        let process = worker.clone();
        tokio::spawn(async move {
            supervise(&mut child, incoming_signals).await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            process.exited.store(true, Ordering::SeqCst);
            let error = process.observer.disconnect_error();
            for (_, request) in process.pending.lock().unwrap_or_else(|error| error.into_inner()).drain() {
                let _ = request.reply.send(Err(error.clone()));
            }
            process.observer.finished();
            closed_tx.send_replace(true);
        });
        Ok(worker)
    }

    async fn read_events(&self, stdout: ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(event) => self.receive(event),
                    Err(error) => self.observer.diagnostic(error.to_string()),
                },
                Ok(None) => break,
                Err(error) => {
                    self.observer.diagnostic(error.to_string());
                    break;
                }
            }
        }
    }

    fn receive(&self, mut event: Value) {
        if kind(&event) == "extension_ui_request"
            && event["method"] == "setStatus"
            && event["statusKey"] == "pi-desktop-pause-state"
        {
            let Some(encoded) = event["statusText"].as_str().and_then(|text| text.strip_prefix("json:")) else {
                return;
            };
            match serde_json::from_str(encoded) {
                Ok(value) => event = value,
                Err(error) => {
                    self.observer.diagnostic(error.to_string());
                    return;
                }
            }
        }
        if kind(&event) != "response" {
            self.observer.event(event);
            return;
        }
        let Some(id) = event["id"].as_str() else {
            return;
        };
        let request = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
        if let Some(request) = request {
            let result = self.observer.response(event, &request);
            let _ = request.reply.send(result);
        }
    }

    pub fn is_closed(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub async fn send(&self, packet: &Value) -> Result<()> {
        if self.is_closed() {
            return Err("Pi is not running".into());
        }
        let mut bytes = serde_json::to_vec(packet).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        self.stdin.lock().await.write_all(&bytes).await.map_err(|error| error.to_string())
    }

    pub async fn request(&self, command: Value, request_type: &str, snapshot_state: Value) -> Result<Value> {
        if self.is_closed() {
            return Err("Pi is not running".into());
        }
        let id = Uuid::new_v4().to_string();
        let wire = wire_command(&command, &id);
        let abort = kind(&command) == "abort";
        let timeout = if abort { Duration::from_secs(5) } else { self.timeout };
        let (reply, incoming) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).insert(
            id.clone(),
            Request {
                command,
                request_type: request_type.into(),
                snapshot_state,
                reply,
            },
        );
        let result = match self.send(&wire).await {
            Ok(()) => match tokio::time::timeout(timeout, incoming).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("Pi disconnected before responding".into()),
                Err(_) => {
                    if abort {
                        let _ = self.signals.send(false);
                    }
                    Err("Pi command timed out".into())
                }
            },
            Err(error) => Err(error),
        };
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&id);
        result
    }

    pub async fn stop(&self) {
        if *self.closed.borrow() {
            return;
        }
        let _ = self.signals.send(false);
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(|closed| *closed).await;
    }
}
