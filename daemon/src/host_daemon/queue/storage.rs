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

    pub fn reserve_id(&self) -> Result<String> {
        let db = crate::session_registry::open(self.root()?)?;
        db.query_row("UPDATE queue_item_sequence SET last_id=last_id+1 WHERE id=1 AND last_id<9007199254740991 RETURNING last_id", [], |row| row.get::<_, i64>(0))
            .map(|id| id.to_string()).map_err(|error| error.to_string())
    }

    pub fn record(&self) -> Result<Option<Value>> {
        let mut db = crate::session_registry::open(self.root()?)?;
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        let origin = transaction.query_row("SELECT cwd, session_path FROM queue_origins WHERE session_id=?", [self.id()?], |row| {
            Ok(json!({"cwd":row.get::<_, String>(0)?, "sessionPath":row.get::<_, Option<String>>(1)?}))
        }).optional().map_err(|error| error.to_string())?;
        let Some(origin) = origin else { return Ok(None); };
        let items = super::storage_rows::load(&transaction, self.id()?)?;
        Ok(Some(json!({"version":1,"origin":origin,"items":items})))
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
        validate_items(items)?;
        let root = self.root()?;
        let _publication = super::super::reference_publication::lock(root)?;
        let _storage = super::temporary::lock(root)?;
        super::super::reference_publication::validate_new_references(root, items, &self.load()?)?;
        let mut db = crate::session_registry::open(root)?;
        let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        self.write_items(&transaction, items)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn write_items(&self, db: &rusqlite::Connection, items: &[Value]) -> Result<()> {
        let id = self.id()?;
        if items.is_empty() {
            db.execute("DELETE FROM queue_items WHERE session_id=?", [id]).map_err(|error| error.to_string())?;
            db.execute("DELETE FROM queue_origins WHERE session_id=?", [id]).map_err(|error| error.to_string())?;
            return Ok(());
        }
        let origin = self.origin.as_ref().ok_or("Queued-input recovery is missing its working directory")?;
        db.execute("INSERT INTO queue_origins VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, session_path=excluded.session_path",
            rusqlite::params![id, origin["cwd"].as_str(), origin["sessionPath"].as_str()]).map_err(|error| error.to_string())?;
        super::storage_rows::save(db, id, items)
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

fn validate_items(items: &[Value]) -> Result<()> {
    if items.len() > 100 { return Err("A session can have at most 100 queued items".into()); }
    for item in items { validate_item(item)?; }
    Ok(())
}

fn validate_item(item: &Value) -> Result<()> {
    super::storage_rows::item_id(item)?;
    if !item["message"].is_string() || !matches!(item["behavior"].as_str(), Some("steer" | "followUp")) {
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
