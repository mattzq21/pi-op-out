use super::super::protocol::Result;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

pub(crate) struct QueueStorage {
    path: PathBuf,
    origin: Option<Value>,
}

impl QueueStorage {
    pub fn new(root: &Path, session_id: &str) -> Result<Self> {
        let identity = Uuid::parse_str(session_id).map_err(|_| "Invalid queued-input session identity")?;
        Ok(Self { path: root.join(format!("{identity}.json")), origin: None })
    }

    pub fn with_origin(mut self, cwd: &Path, session_path: Option<&str>) -> Result<Self> {
        if !cwd.is_absolute() { return Err("Queued-input recovery requires an absolute working directory".into()); }
        self.origin = Some(json!({"cwd":cwd,"sessionPath":session_path}));
        Ok(self)
    }

    pub fn load(&self) -> Result<Vec<Value>> {
        if fs::symlink_metadata(&self.path).is_ok_and(|meta| !meta.is_file()) {
            return Err("Queued-input journal must be a regular file".into());
        }
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        recover_items(&bytes)
    }

    pub fn recover(&self, pending: Vec<Value>) -> Result<Vec<Value>> {
        let mut recovered = self.load()?;
        for mut item in pending {
            item["retry"] = json!(true);
            if !recovered.iter().any(|saved| saved["id"] == item["id"]) { recovered.push(item); }
        }
        self.save(&recovered)?;
        Ok(recovered)
    }

    pub fn save(&self, items: &[Value]) -> Result<()> {
        let parent = self.path.parent().ok_or("Queued-input journal has no directory")?;
        if fs::symlink_metadata(parent).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Queued-input directory cannot be a symbolic link".into());
        }
        if items.is_empty() {
            return self.remove(parent);
        }
        self.write_items(items, parent)
    }

    fn write_items(&self, items: &[Value], parent: &Path) -> Result<()> {
        let origin = self.origin.as_ref().ok_or("Queued-input recovery is missing its working directory")?;
        let body = serde_json::to_vec(&json!({"version":1,"origin":origin,"items":items})).map_err(|error| error.to_string())?;
        crate::atomic_write_private(&self.path, &body)?;
        sync_path(&self.path)?;
        sync_path(parent)?;
        if let Some(root) = parent.parent() { sync_path(root)?; }
        Ok(())
    }

    fn remove(&self, parent: &Path) -> Result<()> {
        match fs::remove_file(&self.path) {
            Ok(()) => sync_path(parent),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn sync_path(path: &Path) -> Result<()> {
    fs::File::open(path).and_then(|file| file.sync_all()).map_err(|error| error.to_string())
}

fn recover_items(bytes: &[u8]) -> Result<Vec<Value>> {
    let saved: Value = serde_json::from_slice(bytes).map_err(|error| format!("Cannot recover queued inputs: {error}"))?;
    if saved["version"] != 1 { return Err("Unsupported queued-input journal version".into()); }
    let mut items = saved["items"].as_array().ok_or("Invalid queued-input journal")?.clone();
    let mut identities = std::collections::HashSet::new();
    for item in &mut items {
        validate_item(item)?;
        if !identities.insert(item["id"].clone()) { return Err("Duplicate queued-input journal identity".into()); }
        item["retry"] = json!(true);
    }
    Ok(items)
}

fn validate_item(item: &Value) -> Result<()> {
    let identity = item["id"].as_str().and_then(|id| Uuid::parse_str(id).ok());
    if identity.is_none() || !item["message"].is_string() || !matches!(item["behavior"].as_str(), Some("steer" | "followUp")) {
        return Err("Invalid queued-input journal item".into());
    }
    if let Some(images) = item.get("images") {
        let images = images.as_array().ok_or("Invalid queued-input journal attachments")?;
        if images.iter().any(|image| !image["data"].is_string() || !image["mimeType"].is_string()) {
            return Err("Invalid queued-input journal attachment".into());
        }
    }
    Ok(())
}
