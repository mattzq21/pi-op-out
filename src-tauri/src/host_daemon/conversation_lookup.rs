use super::{optional_path, read_candidate, ConversationOwnership, SavedConversation};
use crate::host_supervisor::protocol::Result;
use serde_json::{json, Value};
use walkdir::WalkDir;

impl ConversationOwnership {
    pub fn lookup(&self, id: &str) -> Result<Value> {
        let (saved, archived) = self.lookup_saved(id, true)?.ok_or("Conversation was not found in active or archived storage")?;
        Ok(json!({"sessionId":id,"sessionPath":saved.path,"cwd":saved.header["cwd"],"archived":archived,"revision":saved.revision}))
    }

    pub fn lookup_saved(&self, id: &str, metadata_only: bool) -> Result<Option<(SavedConversation, bool)>> {
        Self::key(id)?;
        let mut found = None;
        for archived in [false, true] {
            let Some(root) = optional_path(&self.root.join(if archived { "archived" } else { "sessions" }))? else { continue; };
            for entry in WalkDir::new(&root).follow_links(false) {
                let entry = entry.map_err(|error| error.to_string())?;
                if !transcript_entry(&entry) { continue; }
                let Some(saved) = conversation_candidate(id, entry.path(), &root, metadata_only)? else { continue; };
                if found.is_some() { return Err("Conversation identity is duplicated; resolve its storage copies before opening it".into()); }
                found = Some((saved, archived));
            }
        }
        Ok(found)
    }
}

fn conversation_candidate(id: &str, path: &std::path::Path, root: &std::path::Path, metadata_only: bool) -> Result<Option<SavedConversation>> {
    Ok(read_candidate(id, path, root, metadata_only)?.filter(|saved| saved.header["type"] == "session" && saved.header["cwd"].as_str().is_some()))
}

fn transcript_entry(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_file() && entry.path().extension().is_some_and(|extension| extension == "jsonl")
}
