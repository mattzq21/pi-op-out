use super::protocol::{flag, text, Result};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use uuid::Uuid;

pub(super) fn ownership_error() -> String {
    "Take ownership of this conversation before changing it".into()
}

pub(super) trait Revocation: Send + Sync {
    fn revoke<'a>(&'a self, id: &'a str, intent: &'a str) -> BoxFuture<'a, Result<()>>;
}

pub(super) struct ConversationOwnership {
    root: PathBuf,
    directory: PathBuf,
    token: String,
    endpoint: String,
    revoke: Arc<dyn Revocation>,
    shutdown: watch::Sender<bool>,
}

#[derive(Clone)]
pub(super) struct SavedConversation {
    pub path: PathBuf,
    pub header: Value,
    pub lines: Vec<String>,
    pub revision: String,
}

pub(super) struct Guard {
    pub owned: bool,
    pub saved: Option<SavedConversation>,
    record: Value,
    id: String,
    worker_lock: Option<File>,
    lock: Option<File>,
}

impl Guard {
    pub fn ephemeral() -> Self {
        Self {
            owned: true,
            saved: None,
            record: Value::Null,
            id: String::new(),
            worker_lock: None,
            lock: None,
        }
    }

    pub fn release(mut self, ownership: &ConversationOwnership, deleted: bool) -> Result<()> {
        if deleted && self.owned && self.lock.is_some() {
            self.record["deleted"] = json!(true);
            ownership.write(&self.id, &self.record)?;
        }
        self.worker_lock.take();
        self.lock.take();
        Ok(())
    }
}

impl ConversationOwnership {
    pub async fn new(home: &Path, storage: &str, revoke: Arc<dyn Revocation>) -> Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| error.to_string())?;
        let endpoint = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().map_err(|error| error.to_string())?.port()
        );
        let (shutdown, mut stopped) = watch::channel(false);
        let root = home.join(storage);
        let ownership = Arc::new(Self {
            directory: root.join("conversation-ownership"),
            root,
            endpoint,
            token: Uuid::new_v4().to_string(),
            revoke,
            shutdown,
        });
        let weak = Arc::downgrade(&ownership);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    connection = listener.accept() => {
                        let Ok((stream, _)) = connection else { break; };
                        let Some(ownership) = weak.upgrade() else { break; };
                        tokio::spawn(async move { ownership.serve(stream).await; });
                    }
                }
            }
        });
        Ok(ownership)
    }

    pub fn key(id: &str) -> Result<String> {
        if id.len() != 36 || Uuid::parse_str(id).is_err() {
            return Err("Invalid conversation identity".into());
        }
        let hash = format!("{:x}", Sha256::digest(id.to_lowercase().as_bytes()));
        Ok(hash[..40].into())
    }

    async fn lock(&self, id: &str, worker: bool) -> Result<File> {
        let directory = if worker {
            self.root.join("session-claims")
        } else {
            self.directory.clone()
        };
        crate::ensure_private_dir(&directory)?;
        let prefix = if worker { "id-" } else { "" };
        let path = directory.join(format!("{prefix}{}.lock", Self::key(id)?));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(|error| error.to_string())?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err("Conversation is busy; try taking ownership again".into());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => return Err(format!("Could not lock conversation: {error}")),
            }
        }
    }

    fn read(&self, id: &str) -> Result<Option<Value>> {
        match std::fs::read(self.directory.join(format!("{}.json", Self::key(id)?))) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn write(&self, id: &str, record: &Value) -> Result<()> {
        let path = self.directory.join(format!("{}.json", Self::key(id)?));
        let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
            file.write_all(record.to_string().as_bytes()).map_err(|error| error.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub fn locate(&self, id: &str, path: Option<&str>, archived: bool, metadata_only: bool) -> Result<Option<SavedConversation>> {
        let Some(root) = optional_path(&self.root.join(if archived { "archived" } else { "sessions" }))? else {
            return Ok(None);
        };
        let candidates = if let Some(path) = path.filter(|path| !path.is_empty()) {
            vec![PathBuf::from(path)]
        } else {
            std::fs::read_dir(&root)
                .map_err(|error| error.to_string())?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|extension| extension == "jsonl"))
                .collect()
        };
        for path in candidates {
            if let Some(saved) = read_candidate(id, &path, &root, metadata_only)? {
                return Ok(Some(saved));
            }
        }
        Ok(None)
    }

    async fn release_previous(&self, id: &str, record: &Value, intent: &str) -> Result<()> {
        let Some(endpoint) = record["endpoint"].as_str() else {
            return Ok(());
        };
        if endpoint == self.endpoint && record["token"] == self.token {
            return self.revoke.revoke(id, intent).await;
        }
        let response = reqwest::Client::new()
            .post(endpoint)
            .bearer_auth(text(record, "token"))
            .header("Content-Type", "application/json")
            .body(json!({"id":id,"intent":intent}).to_string())
            .timeout(Duration::from_secs(30))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => Ok(()),
            Ok(_) => Err("The previous client could not release the conversation".into()),
            Err(error) if connection_refused(&error) => Ok(()),
            Err(_) => Err("Could not reach the current owner; try taking ownership again".into()),
        }
    }

    pub async fn begin(&self, id: &str, client: &str, options: &Value) -> Result<Guard> {
        if client.is_empty() {
            return Err("Conversation client is missing".into());
        }
        let lock = self.lock(id, false).await?;
        let record = self.read(id)?;
        let previous = record.clone().unwrap_or(Value::Null);
        let path = options["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .or_else(|| previous["path"].as_str());
        let saved = self.locate(id, path, flag(options, "archived"), false)?;
        if flag(&previous, "deleted") && !flag(options, "archived") || saved.is_none() && !flag(options, "create") {
            return Err("This conversation has been deleted or archived".into());
        }
        let other = previous["client"]
            .as_str()
            .is_some_and(|owner| !owner.is_empty() && owner != client);
        if other && !flag(options, "take") {
            return Ok(Guard {
                owned: false,
                ..Guard::ephemeral()
            });
        }
        let returning = previous["client"].as_str().is_none_or(str::is_empty)
            && previous["previousClient"] == client
            && previous["endpoint"] == self.endpoint
            && previous["token"] == self.token;
        let handoff = record.is_some()
            && ((!returning && previous["client"] != client) || previous["endpoint"] != self.endpoint || flag(options, "mutation"));
        if handoff {
            self.release_previous(
                id,
                &previous,
                if flag(options, "message") {
                    "message"
                } else if flag(options, "archive") {
                    "archive"
                } else {
                    "transfer"
                },
            )
            .await?;
        }
        let mut worker_lock = if record.is_none() || handoff {
            Some(self.lock(id, true).await?)
        } else {
            None
        };
        let mut next = json!({"client":client,"endpoint":self.endpoint,"token":self.token,"deleted":false});
        if let Some(saved) = &saved {
            next["path"] = json!(saved.path);
        }
        self.write(id, &next)?;
        if !flag(options, "mutation") || flag(options, "message") {
            worker_lock = None;
        }
        Ok(Guard {
            owned: true,
            saved,
            record: next,
            id: id.into(),
            worker_lock,
            lock: Some(lock),
        })
    }

    pub async fn release_client(&self, id: &str, client: &str, unused: impl Fn() -> bool) -> Result<()> {
        let _lock = self.lock(id, false).await?;
        let Some(mut record) = self.read(id)? else {
            return Ok(());
        };
        if !unused()
            || record["client"] != client
            || record["endpoint"] != self.endpoint
            || record["token"] != self.token
            || flag(&record, "deleted")
        {
            return Ok(());
        }
        record["client"] = Value::Null;
        record["previousClient"] = json!(client);
        self.write(id, &record)
    }

    pub fn snapshot(&self, id: &str, path: Option<&str>) -> Result<Value> {
        let saved = self.locate(id, path, false, false)?;
        let entries: Vec<Value> = saved
            .as_ref()
            .into_iter()
            .flat_map(|saved| saved.lines.iter().skip(1))
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let revision = saved
            .as_ref()
            .map(|saved| saved.revision.clone())
            .unwrap_or_else(|| format!("missing:{id}"));
        let mut snapshot = json!({"revision":revision,"state":{"sessionId":id,"model":null,"thinkingLevel":"off","isStreaming":false,"pendingMessageCount":0,
                "messageCount":entries.iter().filter(|entry| entry["type"] == "message").count()},
            "history":{"leafId":entries.last().and_then(|entry| entry.get("id")),"entries":entries},"sequence":0,"epoch":format!("readonly:{id}"),
            "liveTools":[],"queue":{"type":"queue_update","steering":[],"followUp":[],"pendingMessages":[]}});
        if let Some(saved) = saved {
            snapshot["state"]["sessionFile"] = json!(saved.path);
        }
        Ok(snapshot)
    }

    pub fn revision(&self, id: &str, path: Option<&str>) -> Result<Value> {
        let saved = self.locate(id, path, false, true)?;
        Ok(json!({"revision":saved.map(|saved| saved.revision).unwrap_or_else(|| format!("missing:{id}"))}))
    }

    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    async fn serve(&self, mut stream: TcpStream) {
        let request = tokio::time::timeout(Duration::from_secs(30), read_request(&mut stream, &self.token)).await;
        let status = match request {
            Ok(Ok(Some(packet))) => {
                let id = text(&packet, "id");
                if Self::key(&id).is_ok() && self.revoke.revoke(&id, &text(&packet, "intent")).await.is_ok() {
                    "200 OK"
                } else {
                    "409 Conflict"
                }
            }
            Ok(Ok(None)) => "403 Forbidden",
            _ => "409 Conflict",
        };
        let response = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }
}

fn optional_path(path: &Path) -> Result<Option<PathBuf>> {
    match path.canonicalize() {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_candidate(id: &str, path: &Path, root: &Path, metadata_only: bool) -> Result<Option<SavedConversation>> {
    let Some(path) = optional_path(path)? else {
        return Ok(None);
    };
    if !path.starts_with(root) || path == root || path.extension().is_none_or(|extension| extension != "jsonl") {
        return Err("Invalid conversation path".into());
    }
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let mut header = String::new();
    BufReader::new(file)
        .take(64 * 1024)
        .read_line(&mut header)
        .map_err(|error| error.to_string())?;
    let header: Value = match serde_json::from_str(&header) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if header["id"] != id {
        return Ok(None);
    }
    #[cfg(unix)]
    let revision = {
        use std::os::unix::fs::MetadataExt;
        let mtime = metadata.mtime() as i128 * 1_000_000_000 + metadata.mtime_nsec() as i128;
        let ctime = metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128;
        format!("{id}:{}:{}:{}:{mtime}:{ctime}", metadata.dev(), metadata.ino(), metadata.len())
    };
    #[cfg(not(unix))]
    let revision = format!("{id}:{}:{:?}:{:?}", metadata.len(), metadata.modified(), metadata.created());
    let lines = if metadata_only {
        Vec::new()
    } else {
        match std::fs::read_to_string(&path) {
            Ok(content) => content.trim_end().split('\n').map(str::to_owned).collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    };
    Ok(Some(SavedConversation {
        path,
        header,
        lines,
        revision,
    }))
}

fn connection_refused(error: &reqwest::Error) -> bool {
    use std::error::Error;
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        source = error.source();
    }
    false
}

async fn read_request(stream: &mut TcpStream, token: &str) -> Result<Option<Value>> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16384 {
            return Err("Request is too large".into());
        }
        header.push(stream.read_u8().await.map_err(|error| error.to_string())?);
    }
    let header = std::str::from_utf8(&header).map_err(|error| error.to_string())?;
    let mut lines = header.split("\r\n");
    let post = lines.next().is_some_and(|line| line.starts_with("POST "));
    let headers: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim()))
        .collect();
    if !post
        || !headers
            .iter()
            .any(|(name, value)| name == "authorization" && *value == format!("Bearer {token}"))
    {
        return Ok(None);
    }
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .ok_or("Missing request length")?
        .1
        .parse()
        .map_err(|_| "Invalid request length")?;
    if length > 8192 {
        return Err("Request is too large".into());
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map(Some).map_err(|error| error.to_string())
}
