use super::{json, text, QueueState, QueueStorage, Result, SessionQueue};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use rusqlite::OptionalExtension;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedQueue {
    version: u32,
    session_id: String,
    messages: Vec<Value>,
}

pub(crate) fn clear_saved(root: &Path, id: &str) -> Result<()> {
    remove_legacy(root, id)?;
    QueueStorage::new(&root.join("queued-input"), id)?.save(&[])
}

pub(super) fn load_legacy(root: &Path, id: &str) -> Result<Vec<Value>> {
    let Some(body) = read_legacy(root, id)? else { return Ok(Vec::new()); };
    let saved: SavedQueue = serde_json::from_str(&body).map_err(|error| format!("Could not restore queued messages: {error}"))?;
    if saved.version != 1 || saved.session_id != id.to_lowercase() || saved.messages.iter().any(|item| !valid_message(item)) {
        return Err("Invalid saved conversation queue; queued messages have been retained in the database".into());
    }
    Ok(saved.messages)
}

fn read_legacy(root: &Path, id: &str) -> Result<Option<String>> {
    let key = super::super::ownership::ConversationOwnership::key(id)?;
    let db = crate::session_registry::open(root)?;
    db.query_row("SELECT record_json FROM legacy_queued_inputs WHERE owner_key=?
        AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))", rusqlite::params![key, id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub(super) fn remove_legacy(root: &Path, id: &str) -> Result<()> {
    let key = super::super::ownership::ConversationOwnership::key(id)?;
    let db = crate::session_registry::open(root)?;
    db.execute("DELETE FROM legacy_queued_inputs WHERE owner_key=?", [key]).map_err(|error| error.to_string())?;
    Ok(())
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
