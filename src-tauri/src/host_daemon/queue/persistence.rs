use super::{json, text, QueueState, Result, SessionQueue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::{Path, PathBuf}};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedQueue {
    version: u32,
    session_id: String,
    messages: Vec<Value>,
}

pub(crate) struct PendingStore {
    path: PathBuf,
    session_id: String,
}

pub(crate) fn clear_saved(root: &Path, id: &str) -> Result<()> {
    PendingStore::new(root, id)?.save(&[])
}

impl PendingStore {
    pub fn new(root: &Path, id: &str) -> Result<Self> {
        let key = super::super::ownership::ConversationOwnership::key(id)?;
        Ok(Self { path: root.join("conversation-queues").join(format!("{key}.json")), session_id: id.to_lowercase() })
    }

    pub fn exists(&self) -> bool { self.path.exists() }

    pub fn restore(&self, lines: &[String], previous: Vec<Value>) -> Result<Vec<Value>> {
        let mut messages = match fs::read(&self.path) {
            Ok(body) => self.decode(&body)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("Could not restore queued messages: {error}")),
        };
        for item in previous {
            if !messages.iter().any(|saved| saved["id"] == item["id"]) { messages.push(item); }
        }
        let consumed: HashSet<String> = lines.iter().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry["type"] == "message" && entry["message"]["role"] == "user")
            .filter_map(|entry| entry["message"]["piopQueueId"].as_str().map(str::to_owned)).collect();
        messages.retain(|item| !consumed.contains(&text(item, "id")));
        for item in &mut messages { item["retry"] = Value::Bool(true); }
        self.save(&messages)?;
        Ok(messages)
    }

    fn decode(&self, body: &[u8]) -> Result<Vec<Value>> {
        let saved: SavedQueue = serde_json::from_slice(body).map_err(|error| format!("Could not restore queued messages: {error}"))?;
        if saved.version != 1 || saved.session_id != self.session_id || saved.messages.iter().any(|item| !valid_message(item)) {
            return Err("Invalid saved conversation queue; queued messages have been retained on disk".into());
        }
        Ok(saved.messages)
    }

    pub fn save(&self, messages: &[Value]) -> Result<()> {
        if messages.is_empty() {
            match fs::remove_file(&self.path) {
                Ok(()) => {
                    if let Some(parent) = self.path.parent() {
                        if let Ok(directory) = fs::File::open(parent) { let _ = directory.sync_all(); }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Could not save queued messages: {error}")),
            }
            return Ok(());
        }
        let body = serde_json::to_vec(&SavedQueue { version: 1, session_id: self.session_id.clone(), messages: messages.to_vec() })
            .map_err(|error| error.to_string())?;
        crate::atomic_write_private(&self.path, &body).map_err(|error| format!("Could not save queued messages: {error}"))
    }
}

fn valid_message(item: &Value) -> bool {
    !text(item, "id").is_empty() && item["message"].is_string()
        && matches!(item["behavior"].as_str(), Some("steer" | "followUp"))
        && item.get("images").is_none_or(Value::is_array)
        && item.get("retry").is_none_or(Value::is_boolean)
}

impl SessionQueue {
    pub(super) fn persist(&self, state: &mut QueueState) -> Result<()> {
        self.executor.save_pending(state.durable_messages())
    }

    pub(super) fn publish_saved(&self) -> Result<Value> {
        self.persist(&mut self.state())?;
        self.publish();
        Ok(Value::Null)
    }

    pub(super) fn report_storage_error(&self, result: Result<()>) {
        if let Err(error) = result {
            self.executor.publish(json!({"type":"extension_error","extensionPath":"conversation queue","event":"queue","error":error}));
        }
    }

    pub fn rejected(&self, id: &str) {
        self.state().rejected.insert(id.into());
        self.consumed(id);
    }

    pub fn consumed(&self, id: &str) {
        let mut state = self.state();
        state.remove(id);
        let saved = self.persist(&mut state);
        drop(state);
        self.report_storage_error(saved);
    }
}
