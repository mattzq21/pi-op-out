use super::super::protocol::Result;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use rusqlite::OptionalExtension;
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

    fn root(&self) -> Result<&Path> { self.path.parent().and_then(Path::parent).ok_or_else(|| "Queued-input storage has no root".into()) }

    fn id(&self) -> Result<&str> { self.path.file_stem().and_then(|name| name.to_str()).ok_or_else(|| "Queued-input identity is missing".into()) }

    pub fn record(&self) -> Result<Option<Value>> {
        let db = crate::session_registry::open(self.root()?)?;
        let body: Option<String> = db.query_row("SELECT record_json FROM queued_inputs WHERE session_id=?", [self.id()?], |row| row.get(0))
            .optional().map_err(|error| error.to_string())?;
        body.map(|body| serde_json::from_str(&body).map_err(|error| error.to_string())).transpose()
    }

    pub fn load(&self) -> Result<Vec<Value>> {
        match self.record()? { Some(saved) => recover_items(saved), None => Ok(Vec::new()) }
    }

    pub fn recover(&self, pending: Vec<Value>) -> Result<Vec<Value>> {
        let mut recovered = self.load()?;
        for mut item in pending {
            validate_item(&item)?;
            item["retry"] = json!(true);
            if !recovered.iter().any(|saved| saved["id"] == item["id"]) { recovered.push(item); }
        }
        self.save(&recovered)?;
        Ok(recovered)
    }

    pub fn save(&self, items: &[Value]) -> Result<()> {
        let root = self.root()?;
        let _publication = super::super::reference_publication::lock(root)?;
        let _storage = super::temporary::lock(root)?;
        let db = crate::session_registry::open(root)?;
        if items.is_empty() {
            db.execute("DELETE FROM queued_inputs WHERE session_id=?", [self.id()?]).map_err(|error| error.to_string())?;
            return Ok(());
        }
        super::super::reference_publication::validate_new_references(root, items, &self.load()?)?;
        self.write_items(&db, items)
    }

    fn write_items(&self, db: &rusqlite::Connection, items: &[Value]) -> Result<()> {
        let origin = self.origin.as_ref().ok_or("Queued-input recovery is missing its working directory")?;
        let body = json!({"version":1,"origin":origin,"items":items}).to_string();
        let written = db.execute("INSERT INTO queued_inputs SELECT ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE session_id=lower(?))
            ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json", rusqlite::params![self.id()?, body, self.id()?]).map_err(|error| error.to_string())?;
        if written == 0 { return Err("Cannot queue input for a deleted session".into()); }
        Ok(())
    }
}

fn recover_items(saved: Value) -> Result<Vec<Value>> {
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
    if !item["id"].as_str().is_some_and(|id| !id.is_empty()) || !item["message"].is_string() || !matches!(item["behavior"].as_str(), Some("steer" | "followUp")) {
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
