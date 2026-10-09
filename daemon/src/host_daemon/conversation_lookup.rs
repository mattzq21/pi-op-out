use super::{optional_path, read_candidate, ConversationOwnership, SavedConversation};
use crate::host_supervisor::protocol::Result;
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use std::path::{Path, PathBuf};

pub(super) fn registered_path(root: &Path, id: &str) -> Result<Option<PathBuf>> {
    let database = crate::session_registry::open(root)?;
    let path: Option<String> = database.query_row("SELECT session_path FROM sessions WHERE session_id=?
        AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))",
        [id, id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.flatten();
    Ok(path.map(PathBuf::from))
}

impl ConversationOwnership {
    pub fn lookup(&self, id: &str) -> Result<Value> {
        let (saved, archived) = self.lookup_saved(id, true)?.ok_or("Conversation was not found in active or archived storage")?;
        Ok(json!({"sessionId":id,"sessionPath":saved.path,"cwd":saved.header["cwd"],"archived":archived,"revision":saved.revision}))
    }

    pub fn lookup_saved(&self, id: &str, metadata_only: bool) -> Result<Option<(SavedConversation, bool)>> {
        Self::key(id)?;
        let Some(path) = registered_path(&self.root, id)? else { return Ok(None); };
        for archived in [false, true] {
            let Some(root) = optional_path(&self.root.join(if archived { "archived" } else { "sessions" }))? else { continue; };
            if !path.starts_with(&root) { continue; }
            return Ok(conversation_candidate(id, &path, &root, metadata_only)?.map(|saved| (saved, archived)));
        }
        Ok(None)
    }
}

fn conversation_candidate(id: &str, path: &std::path::Path, root: &std::path::Path, metadata_only: bool) -> Result<Option<SavedConversation>> {
    Ok(read_candidate(id, path, root, metadata_only)?.filter(|saved| saved.header["type"] == "session" && saved.header["cwd"].as_str().is_some()))
}
