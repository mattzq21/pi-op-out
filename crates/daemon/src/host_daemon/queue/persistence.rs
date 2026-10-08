use super::{json, text, QueueState, QueueStorage, Result, SessionQueue};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedQueue {
    version: u32,
    session_id: String,
    messages: Vec<Value>,
}

fn legacy_path(root: &Path, id: &str) -> Result<PathBuf> {
    let key = super::super::ownership::ConversationOwnership::key(id)?;
    Ok(root.join("conversation-queues").join(format!("{key}.json")))
}

pub(crate) fn clear_saved(root: &Path, id: &str) -> Result<()> {
    remove_legacy(root, id)?;
    QueueStorage::new(&root.join("queued-input"), id)?.save(&[])
}

pub(super) fn load_legacy(root: &Path, id: &str) -> Result<Vec<Value>> {
    let path = legacy_path(root, id)?;
    let Some(body) = read_legacy(&path)? else { return Ok(Vec::new()); };
    let saved: SavedQueue = serde_json::from_slice(&body).map_err(|error| format!("Could not restore queued messages: {error}"))?;
    if saved.version != 1 || saved.session_id != id.to_lowercase() || saved.messages.iter().any(|item| !valid_message(item)) {
        return Err("Invalid saved conversation queue; queued messages have been retained on disk".into());
    }
    Ok(saved.messages)
}

fn read_legacy(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() => {},
        Ok(_) => return Err("Saved conversation queue must be a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    fs::read(path).map(Some).map_err(|error| format!("Could not restore queued messages: {error}"))
}

pub(super) fn remove_legacy(root: &Path, id: &str) -> Result<()> {
    let path = legacy_path(root, id)?;
    match fs::remove_file(&path) {
        Ok(()) => fs::File::open(path.parent().ok_or("Saved queue has no directory")?)
            .and_then(|directory| directory.sync_all()).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove migrated conversation queue: {error}")),
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
        self.persist_state(state)
    }

    pub(super) fn publish_saved(&self) -> Result<Value> {
        self.publish()?;
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
        self.report_storage_error(self.forget_item(id));
    }
}
