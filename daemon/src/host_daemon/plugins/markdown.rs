use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use uuid::Uuid;

#[derive(Clone, Deserialize, PartialEq, Serialize)]
struct Lease { client: String, editor: String, token: String, expires: u64 }

struct Editor<'a> { client: &'a str, id: String, token: Option<&'a str> }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn notes_root() -> Result<PathBuf, String> { Ok(crate::home_dir()?.join(crate::STORAGE_DIRECTORY).join("notes")) }

fn lock_notes() -> Result<File, String> {
    let root = crate::home_dir()?.join(crate::STORAGE_DIRECTORY);
    crate::ensure_private_dir(&root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(validate_path(root.join("note-mutations.lock"))?).map_err(|error| error.to_string())?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

fn lease_path(session: &str) -> Result<PathBuf, String> {
    Ok(notes_root()?.join("leases").join(format!("{session}.json")))
}

fn read_lease(path: &Path) -> Result<Option<Lease>, String> {
    let Some(body) = super::markdown_leases::read(path)? else { return Ok(None); };
    let lease: Lease = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    Ok((lease.expires > now()).then_some(lease))
}

fn write_lease(path: &Path, lease: Option<&Lease>) -> Result<(), String> {
    let body = lease.map(serde_json::to_string).transpose().map_err(|error| error.to_string())?;
    super::markdown_leases::write(path, body.as_deref())
}

pub(crate) struct RestartLeases { preserved: Vec<(PathBuf, Lease, Lease)> }

impl RestartLeases {
    pub(crate) fn commit(mut self) { self.preserved.clear(); }

    fn restore(&self) -> Result<(), String> {
        let _guard = lock_notes()?;
        for (path, original, extended) in &self.preserved {
            if read_lease(path)?.as_ref() == Some(extended) { write_lease(path, Some(original))?; }
        }
        Ok(())
    }
}

impl Drop for RestartLeases {
    fn drop(&mut self) {
        if self.preserved.is_empty() { return; }
        if let Err(error) = self.restore() { eprintln!("Could not restore note leases after failed restart preparation: {error}"); }
    }
}

pub(crate) fn preserve_leases_for_restart() -> Result<RestartLeases, String> {
    let mut leases = RestartLeases { preserved: Vec::new() };
    let _guard = lock_notes()?;
    let root = crate::home_dir()?.join(crate::STORAGE_DIRECTORY);
    for path in super::markdown_leases::list(&root)? {
        preserve_lease(&path, &mut leases)?;
    }
    Ok(leases)
}

fn preserve_lease(path: &Path, leases: &mut RestartLeases) -> Result<(), String> {
    if path.extension().is_none_or(|extension| extension != "json") { return Ok(()); }
    if let Some(mut lease) = read_lease(path)? {
        let original = lease.clone();
        lease.expires = lease.expires.max(now() + 300);
        leases.preserved.push((path.into(), original, lease.clone()));
        write_lease(path, Some(&lease))?;
    }
    Ok(())
}

fn owns(lease: Option<&Lease>, editor: &Editor<'_>) -> bool {
    lease.is_some_and(|lease| lease.client == editor.client && lease.editor == editor.id && lease.expires > now())
}

fn ownership(lease: Option<&Lease>, editor: &Editor<'_>) -> Value {
    let owned = owns(lease, editor);
    json!({"owned":owned,"available":lease.is_none(),"token":lease.filter(|_| owned).map(|lease| lease.token.to_string())})
}

fn controls(lease: Option<&Lease>, editor: &Editor<'_>) -> bool {
    owns(lease, editor) && lease.is_some_and(|lease| Some(lease.token.as_str()) == editor.token)
}

fn update_lease(lease: &mut Option<Lease>, editor: &Editor<'_>, action: &str) {
    let controlled = controls(lease.as_ref(), editor);
    if action == "release" {
        if controlled { *lease = None; }
    } else if action == "takeover" || action == "claim" && lease.is_none() {
        *lease = Some(Lease { client: editor.client.into(), editor: editor.id.clone(), token: Uuid::new_v4().to_string(), expires: now() + 30 });
    } else if controlled && matches!(action, "renew" | "save") {
        if let Some(lease) = lease { lease.expires = lease.expires.max(now() + 30); }
    }
}

pub(crate) fn initialize() -> Result<(), String> {
    let root = notes_root()?.join("chats");
    crate::ensure_private_dir(&root)?;
    crate::private_fs::sync_directory_ancestors(&root)
}

fn field<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name].as_str().ok_or_else(|| format!("Missing note {name}"))
}

fn note_path(session: &str) -> Result<PathBuf, String> {
    Ok(notes_root()?.join("chats").join(format!("{session}.md")))
}

fn has_conversation(session: &str) -> Result<bool, String> {
    let storage = crate::home_dir()?.join(crate::STORAGE_DIRECTORY);
    let db = crate::session_registry::open(&storage)?;
    let deleted: bool = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM sessions WHERE session_id=?)", [session], |row| row.get(0)).map_err(|error| error.to_string())?;
    if deleted { return Ok(false); }
    let key = super::super::ownership::ConversationOwnership::key(session)?;
    let Some(body) = crate::conversation_storage::read(&storage, &key)? else { return Ok(true); };
    let record: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    let Some(path) = record["path"].as_str().map(Path::new) else { return Ok(true); };
    conversation_exists(&storage, session, path)
}

fn conversation_exists(storage: &Path, session: &str, recorded: &Path) -> Result<bool, String> {
    if recorded.is_file() { return Ok(true); }
    for area in ["sessions", "archived"] {
        if super::super::ownership::saved_conversation_in(&storage.join(area), session)? { return Ok(true); }
    }
    Ok(false)
}

fn validate_path(path: PathBuf) -> Result<PathBuf, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err("The chat note must be a regular file".into()),
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(error.to_string()),
    }
}

fn read(path: &Path) -> Result<String, String> { super::markdown_storage::read(path) }

fn version(body: &str) -> String { format!("{:x}", Sha256::digest(body.as_bytes())) }

fn document(body: &str) -> Value {
    json!({ "content": body, "version": version(body) })
}

fn write_note(path: &Path, body: &str, args: &Value) -> Result<(), String> {
    super::markdown_storage::write(path, body, field(args, "version")?)
}

pub(super) fn dispatch(args: Value, enabled: bool) -> Result<Value, String> {
    let _guard = lock_notes()?;
    let session = Uuid::parse_str(field(&args, "sessionId")?).map_err(|_| "Choose a chat before writing a note")?.to_string();
    let lease_path = lease_path(&session)?;
    if !has_conversation(&session)? {
        write_lease(&lease_path, None)?;
        return Ok(json!({"content":"","version":version(""),"deleted":true,"ownership":{"owned":false,"available":false,"token":null}}));
    }
    if !enabled { return disabled_note(&args, &session, &lease_path); }
    dispatch_note(&args, &session, &lease_path)
}

fn disabled_note(args: &Value, session: &str, lease_path: &Path) -> Result<Value, String> {
    let mut result = document(&read(&note_path(session)?)?);
    let editor = editor(args)?;
    let lease = read_lease(lease_path)?;
    if controls(lease.as_ref(), &editor) { write_lease(lease_path, None)?; }
    result["ownership"] = json!({"owned":false,"available":false,"token":null});
    result["disabled"] = json!(true);
    Ok(result)
}

fn editor(args: &Value) -> Result<Editor<'_>, String> {
    Ok(Editor {
        client: field(args, "clientId")?,
        id: Uuid::parse_str(field(args, "leaseId")?).map_err(|_| "Invalid note editor identity")?.to_string(),
        token: args["leaseToken"].as_str(),
    })
}

fn dispatch_note(args: &Value, session: &str, lease_path: &Path) -> Result<Value, String> {
    let path = note_path(session)?;
    let mut lease = read_lease(lease_path)?;
    let previous = lease.clone();
    let editor = editor(args)?;
    let action = field(args, "action")?;
    let mut result = perform(&path, args, action, controls(lease.as_ref(), &editor))?;
    update_lease(&mut lease, &editor, action);
    if lease != previous { write_lease(lease_path, lease.as_ref())?; }
    result["ownership"] = ownership(lease.as_ref(), &editor);
    Ok(result)
}

fn perform(path: &Path, args: &Value, action: &str, owned: bool) -> Result<Value, String> {
    match action {
        "read" | "claim" | "takeover" | "renew" | "release" => Ok(document(&read(path)?)),
        "save" => {
            if !owned { return Err("This client no longer controls the note.".into()); }
            let body = field(args, "content")?;
            write_note(path, body, args)?;
            Ok(document(body))
        },
        _ => Err("Unknown chat note action".into()),
    }
}
