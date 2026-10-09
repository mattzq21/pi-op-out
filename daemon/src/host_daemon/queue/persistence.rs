use super::{json, QueueState, QueueStorage, Result, SessionQueue};
use serde_json::Value;
use std::path::Path;

pub(crate) fn clear_saved(root: &Path, id: &str) -> Result<()> {
    QueueStorage::new(&root.join("queued-input"), id)?.save(&[])
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
