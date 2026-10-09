use super::control_state;
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

#[path = "conversation_lookup.rs"]
mod conversation_lookup;

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
    archived: bool,
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
            archived: false,
            record: Value::Null,
            id: String::new(),
            worker_lock: None,
            lock: None,
        }
    }

    pub fn restored(mut self, ownership: &ConversationOwnership, path: &str) -> Result<()> {
        ownership.locate(&self.id, Some(path), false, true)?.ok_or("Restored conversation is not in active storage")?;
        self.archived = false;
        self.release(ownership, false)
    }

    pub fn restore_finished(self, ownership: &ConversationOwnership, path: Option<&str>) -> Result<()> {
        crate::restore_recovery::recover(&ownership.root)?;
        if let Some(saved) = ownership.locate(&self.id, path, false, true)? {
            return self.restored(ownership, &saved.path.to_string_lossy());
        }
        self.release(ownership, false)
    }

    pub fn release(mut self, ownership: &ConversationOwnership, deleted: bool) -> Result<()> {
        if (deleted || self.archived) && self.owned && self.lock.is_some() {
            self.record["deleted"] = json!(true);
            self.record["client"] = Value::Null;
            ownership.write(&self.id, &self.record)?;
        }
        self.worker_lock.take();
        self.lock.take();
        Ok(())
    }
}

impl ConversationOwnership {
    pub async fn new(home: &Path, storage: &str, revoke: Arc<dyn Revocation>) -> Result<Arc<Self>> {
        crate::restore_recovery::recover(&home.join(storage))?;
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

    pub fn owns(&self, id: &str, client: &str, allow_released: bool) -> Result<bool> {
        let Some(record) = self.read(id)? else { return Ok(false); };
        let released = allow_released && record["client"].as_str().is_none_or(str::is_empty)
            && record["previousClient"] == client && record["endpoint"] == self.endpoint && record["token"] == self.token;
        Ok(!client.is_empty() && !flag(&record, "deleted") && (record["client"].as_str() == Some(client) || released))
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
        let candidate = if let Some(path) = path.filter(|path| !path.is_empty()) {
            PathBuf::from(path)
        } else {
            let Some(path) = conversation_lookup::registered_path(&self.root, id)? else { return Ok(None); };
            if !path.starts_with(&root) { return Ok(None); }
            path
        };
        read_candidate(id, &candidate, &root, metadata_only)
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
        crate::restore_recovery::recover(&self.root)?;
        let record = self.read(id)?;
        let previous = record.clone().unwrap_or(Value::Null);
        let saved = self.saved_for_claim(id, &previous, options)?;
        if claim_blocked(&previous, client, options) {
            return Ok(Guard {
                owned: false,
                ..Guard::ephemeral()
            });
        }
        let mut worker_lock = self.claim_worker_lock(id, record.as_ref(), client, options).await?;
        let next = self.write_claim(id, client, saved.as_ref())?;
        if !exclusive_mutation(options) {
            worker_lock = None;
        }
        Ok(Guard {
            owned: true,
            saved,
            archived: flag(options, "archived"),
            record: next,
            id: id.into(),
            worker_lock,
            lock: Some(lock),
        })
    }

    async fn claim_worker_lock(&self, id: &str, previous: Option<&Value>, client: &str, options: &Value) -> Result<Option<File>> {
        if let Some(previous) = previous {
            if !self.needs_handoff(previous, client, options) {
                return Ok(None);
            }
            if flag(options, "take") && !flag(options, "mutation") && previous["endpoint"] == self.endpoint && previous["token"] == self.token {
                self.revoke.revoke(id, "transfer-local").await?;
                return Ok(None);
            }
            self.release_previous(id, previous, claim_intent(options)).await?;
        }
        self.lock(id, true).await.map(Some)
    }

    fn write_claim(&self, id: &str, client: &str, saved: Option<&SavedConversation>) -> Result<Value> {
        let mut next = json!({"client":client,"endpoint":self.endpoint,"token":self.token,"deleted":false});
        if let Some(saved) = saved {
            next["path"] = json!(saved.path);
        }
        self.write(id, &next)?;
        Ok(next)
    }

    fn saved_for_claim(&self, id: &str, previous: &Value, options: &Value) -> Result<Option<SavedConversation>> {
        let path = options["path"]
            .as_str()
            .filter(|path| !path.is_empty())
            .or_else(|| previous["path"].as_str());
        let saved = self.locate(id, path, flag(options, "archived"), false)?;
        if saved.is_none() && !flag(options, "create") {
            return Err("This conversation has been deleted or archived".into());
        }
        Ok(saved)
    }

    fn needs_handoff(&self, previous: &Value, client: &str, options: &Value) -> bool {
        let returning = previous["client"].as_str().is_none_or(str::is_empty)
            && previous["previousClient"] == client
            && previous["endpoint"] == self.endpoint
            && previous["token"] == self.token;
        (!returning && previous["client"] != client) || previous["endpoint"] != self.endpoint || flag(options, "mutation")
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

    pub fn snapshot(&self, id: &str, _path: Option<&str>) -> Result<Value> {
        let saved = self.lookup_saved(id, false)?.map(|(saved, _)| saved);
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
        let leaf_id = entries
            .iter()
            .rev()
            .find(|entry| entry["type"] != "session")
            .and_then(|entry| entry["id"].as_str());
        let control = control_state::reduce(&entries, leaf_id)?;
        let mut snapshot = json!({"revision":revision,"state":{"sessionId":id,"model":null,"thinkingLevel":"off","isStreaming":false,"pendingMessageCount":0,
                "isPaused":control.is_paused,"isPausing":false,"needsInput":control.needs_input,
                "messageCount":entries.iter().filter(|entry| entry["type"] == "message").count()},
            "history":{"leafId":leaf_id,"entries":entries},"sequence":0,"epoch":format!("readonly:{id}"),
            "liveTools":[],"queue":{"type":"queue_update","steering":[],"followUp":[],"pendingMessages":[]}});
        if let Some(saved) = saved {
            snapshot["state"]["sessionFile"] = json!(saved.path);
        }
        Ok(snapshot)
    }

    pub fn revision(&self, id: &str, _path: Option<&str>) -> Result<Value> {
        let saved = self.lookup_saved(id, true)?.map(|(saved, _)| saved);
        Ok(json!({"revision":saved.map(|saved| saved.revision).unwrap_or_else(|| format!("missing:{id}"))}))
    }

    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    pub fn removed(&self, id: &str) -> Result<bool> {
        Ok(self.read(id)?.is_some_and(|record| flag(&record, "deleted")))
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

fn claim_blocked(previous: &Value, client: &str, options: &Value) -> bool {
    owned_by_other(previous, client) && !flag(options, "take") && !flag(options, "archive") && !(flag(options, "archived") && flag(previous, "deleted"))
}

fn owned_by_other(previous: &Value, client: &str) -> bool {
    previous["client"]
        .as_str()
        .is_some_and(|owner| !owner.is_empty() && owner != client)
}

fn claim_intent(options: &Value) -> &str {
    if flag(options, "message") {
        "message"
    } else if flag(options, "archive") {
        "archive"
    } else {
        "transfer"
    }
}

fn exclusive_mutation(options: &Value) -> bool {
    flag(options, "mutation") && !flag(options, "message")
}

fn validate_saved_path(path: &Path, root: &Path) -> Result<()> {
    if !path.starts_with(root) || path == root || path.extension().is_none_or(|extension| extension != "jsonl") {
        return Err("Invalid conversation path".into());
    }
    Ok(())
}

pub(super) fn saved_conversation_in(root: &Path, id: &str) -> Result<bool> {
    let Some(root) = optional_path(root)? else { return Ok(false); };
    let profile = root.parent().ok_or("Session storage root missing")?;
    let Some(path) = conversation_lookup::registered_path(profile, id)? else { return Ok(false); };
    if !path.starts_with(&root) { return Ok(false); }
    Ok(read_candidate(id, &path, &root, true)?.is_some())
}

fn read_candidate(id: &str, path: &Path, root: &Path, metadata_only: bool) -> Result<Option<SavedConversation>> {
    let Some(path) = optional_path(path)? else {
        return Ok(None);
    };
    validate_saved_path(&path, root)?;
    let Some((header, metadata)) = read_saved_header(id, &path)? else {
        return Ok(None);
    };
    let revision = saved_revision(id, &metadata);
    let lines = if metadata_only {
        Vec::new()
    } else {
        let Some(lines) = read_saved_lines(id, &path)? else { return Ok(None); };
        lines
    };
    Ok(Some(SavedConversation {
        path,
        header,
        lines,
        revision,
    }))
}

fn read_saved_lines(id: &str, path: &Path) -> Result<Option<Vec<String>>> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let lines: Vec<String> = content.trim_end().split('\n').map(str::to_owned).collect();
    let header: Value = lines.first().and_then(|line| serde_json::from_str(line).ok()).unwrap_or(Value::Null);
    if header["type"] != "session" || header["id"] != id { return Ok(None); }
    Ok(Some(lines))
}

fn read_saved_header(id: &str, path: &Path) -> Result<Option<(Value, std::fs::Metadata)>> {
    let file = match File::open(path) {
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
    Ok(Some((header, metadata)))
}

fn saved_revision(id: &str, metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    let revision = {
        use std::os::unix::fs::MetadataExt;
        let mtime = metadata.mtime() as i128 * 1_000_000_000 + metadata.mtime_nsec() as i128;
        let ctime = metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128;
        format!("{id}:{}:{}:{}:{mtime}:{ctime}", metadata.dev(), metadata.ino(), metadata.len())
    };
    #[cfg(not(unix))]
    let revision = format!("{id}:{}:{:?}:{:?}", metadata.len(), metadata.modified(), metadata.created());
    revision
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
    let header = request_header(stream).await?;
    let Some(length) = request_length(&header, token)? else {
        return Ok(None);
    };
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map(Some).map_err(|error| error.to_string())
}

async fn request_header(stream: &mut TcpStream) -> Result<String> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16384 {
            return Err("Request is too large".into());
        }
        header.push(stream.read_u8().await.map_err(|error| error.to_string())?);
    }
    String::from_utf8(header).map_err(|error| error.to_string())
}

fn request_length(header: &str, token: &str) -> Result<Option<usize>> {
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
    Ok(Some(length))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    include!("../test_directory.rs");
    struct Idle;
    impl Revocation for Idle {
        fn revoke<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<()>> { Box::pin(async { Ok(()) }) }
    }
    #[tokio::test]
    async fn another_client_cannot_claim_a_live_conversation_without_takeover() {
        let home = TestDirectory::new();
        let ownership = ConversationOwnership::new(&home.0, ".piop", Arc::new(Idle)).await.unwrap();
        let id = Uuid::new_v4().to_string();
        let path = home.0.join(".piop/sessions/chat.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{}\n", json!({"type":"session","id":id}))).unwrap();
        let first = ownership.begin(&id, "first", &json!({"path":path})).await.unwrap();
        assert!(first.owned);
        first.release(&ownership, false).unwrap();
        let previous = ownership.read(&id).unwrap();
        let blocked = ownership.begin(&id, "second", &json!({})).await.unwrap();
        assert!(!blocked.owned);
        blocked.release(&ownership, false).unwrap();
        assert_eq!(ownership.read(&id).unwrap(), previous);
    }
    #[tokio::test]
    async fn archived_mutations_can_move_between_clients() {
        let home = TestDirectory::new();
        let ownership = ConversationOwnership::new(&home.0, ".piop", Arc::new(Idle)).await.unwrap();
        let id = Uuid::new_v4().to_string();
        let live = home.0.join(".piop/sessions/chat.jsonl");
        let archive = home.0.join(".piop/archived/chat.jsonl");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        fs::create_dir_all(archive.parent().unwrap()).unwrap();
        fs::write(&live, format!("{}\n", json!({"type":"session","id":id}))).unwrap();
        let guard = ownership.begin(&id, "first", &json!({"path":live,"mutation":true,"archive":true})).await.unwrap();
        fs::rename(&live, &archive).unwrap();
        guard.release(&ownership, true).unwrap();
        for client in ["second", "third"] {
            let guard = ownership.begin(&id, client, &json!({"path":archive,"archived":true,"mutation":true})).await.unwrap();
            assert!(guard.owned, "archive remained owned by another client");
            guard.release(&ownership, false).unwrap();
        }
    }
    #[tokio::test]
    async fn terminal_reassignment_accepts_only_the_last_released_client() {
        let home = TestDirectory::new();
        let ownership = ConversationOwnership::new(&home.0, ".piop", Arc::new(Idle)).await.unwrap();
        let id = Uuid::new_v4().to_string();
        let path = home.0.join(".piop/sessions/chat.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{}\n", json!({"type":"session","id":id}))).unwrap();
        let guard = ownership.begin(&id, "first", &json!({"path":path})).await.unwrap();
        guard.release(&ownership, false).unwrap();
        ownership.release_client(&id, "first", || true).await.unwrap();
        assert!(!ownership.owns(&id, "first", false).unwrap());
        assert!(ownership.owns(&id, "first", true).unwrap());
        assert!(!ownership.owns(&id, "second", true).unwrap());
        let guard = ownership.begin(&id, "second", &json!({"path":path})).await.unwrap();
        guard.release(&ownership, false).unwrap();
        assert!(!ownership.owns(&id, "first", true).unwrap());
        assert!(ownership.owns(&id, "second", false).unwrap());
        ownership.release_client(&id, "second", || true).await.unwrap();
        assert!(!ownership.owns(&id, "first", true).unwrap());
        assert!(ownership.owns(&id, "second", true).unwrap());
        assert!(!ownership.owns(&id, "", true).unwrap());
        let mut record = ownership.read(&id).unwrap().unwrap();
        let endpoint = record["endpoint"].clone();
        record["endpoint"] = json!("another-daemon");
        ownership.write(&id, &record).unwrap();
        assert!(!ownership.owns(&id, "second", true).unwrap());
        record["endpoint"] = endpoint;
        let token = record["token"].clone();
        record["token"] = json!("another-token");
        ownership.write(&id, &record).unwrap();
        assert!(!ownership.owns(&id, "second", true).unwrap());
        record["token"] = token;
        record["deleted"] = json!(true);
        ownership.write(&id, &record).unwrap();
        assert!(!ownership.owns(&id, "second", true).unwrap());
        ownership.shutdown();
    }
}
