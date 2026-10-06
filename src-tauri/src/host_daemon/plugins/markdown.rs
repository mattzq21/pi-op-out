use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use uuid::Uuid;

const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
static NOTES: OnceLock<Mutex<HashMap<PathBuf, Lease>>> = OnceLock::new();

struct Lease { client: String, editor: Uuid, expires: Instant }

struct Editor<'a> { client: &'a str, id: Uuid }

fn owns(lease: Option<&Lease>, editor: &Editor<'_>) -> bool {
    lease.is_some_and(|lease| lease.client == editor.client && lease.editor == editor.id && lease.expires > Instant::now())
}

fn ownership(lease: Option<&Lease>, editor: &Editor<'_>) -> Value {
    json!({"owned":owns(lease, editor),"available":lease.is_none()})
}

fn update_lease(leases: &mut HashMap<PathBuf, Lease>, path: &Path, editor: &Editor<'_>, action: &str) {
    let owned = owns(leases.get(path), editor);
    if action == "release" {
        if owned { leases.remove(path); }
    } else if renews(action, owned, leases.contains_key(path)) {
        leases.insert(path.into(), Lease { client: editor.client.into(), editor: editor.id, expires: Instant::now() + Duration::from_secs(30) });
    }
}

fn renews(action: &str, owned: bool, occupied: bool) -> bool {
    match action { "claim" => owned || !occupied, "save" => owned, _ => false }
}

pub(crate) fn initialize() -> Result<(), String> {
    let root = crate::home_dir()?.join(crate::STORAGE_DIRECTORY).join("notes").join("chats");
    crate::ensure_private_dir(&root)
}

fn field<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name].as_str().ok_or_else(|| format!("Missing note {name}"))
}

fn note_path(session_id: &str) -> Result<PathBuf, String> {
    let session = Uuid::parse_str(session_id).map_err(|_| "Choose a chat before writing a note")?;
    let root = crate::home_dir()?.join(crate::STORAGE_DIRECTORY).join("notes").join("chats");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(root).map_err(|error| error.to_string())?.join(format!("{session}.md"));
    validate_path(path)
}

fn validate_path(path: PathBuf) -> Result<PathBuf, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err("The chat note must be a regular file".into()),
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(error.to_string()),
    }
}

fn read(path: &Path) -> Result<String, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("Could not read note: {error}")),
    };
    let mut body = String::new();
    file.take(MAX_NOTE_BYTES + 1).read_to_string(&mut body).map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_NOTE_BYTES { return Err("This note is larger than 4 MB".into()); }
    Ok(body)
}

fn version(body: &str) -> String { format!("{:x}", Sha256::digest(body.as_bytes())) }

fn document(body: &str) -> Value {
    json!({ "content": body, "version": version(body) })
}

fn check_version(path: &Path, args: &Value) -> Result<(), String> {
    if version(&read(path)?) != field(args, "version")? {
        return Err("This chat’s note changed on disk.".into());
    }
    Ok(())
}

fn write_note(path: &Path, body: &str, args: &Value) -> Result<(), String> {
    if body.len() as u64 > MAX_NOTE_BYTES { return Err("Notes must be smaller than 4 MB".into()); }
    check_version(path, args)?;
    let create = !path.exists();
    let temporary = path.with_file_name(format!(".piop-note-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        if !create { file.set_permissions(fs::metadata(path).map_err(|error| error.to_string())?.permissions()).map_err(|error| error.to_string())?; }
        file.write_all(body.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        if create {
            fs::hard_link(&temporary, path).map_err(|error| format!("Could not create chat note: {error}"))?;
        } else {
            check_version(path, args)?;
            fs::rename(&temporary, path).map_err(|error| format!("Could not save note: {error}"))?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub(super) fn dispatch(args: Value) -> Result<Value, String> {
    let mut leases = NOTES.get_or_init(Mutex::default).lock().map_err(|_| "Notes are unavailable")?;
    leases.retain(|_, lease| lease.expires > Instant::now());
    let path = note_path(field(&args, "sessionId")?)?;
    let editor = Editor { client: field(&args, "clientId")?, id: Uuid::parse_str(field(&args, "leaseId")?).map_err(|_| "Invalid note editor identity")? };
    let action = field(&args, "action")?;
    let mut result = perform(&path, &args, action, owns(leases.get(&path), &editor))?;
    update_lease(&mut leases, &path, &editor, action);
    result["ownership"] = ownership(leases.get(&path), &editor);
    Ok(result)
}

fn perform(path: &Path, args: &Value, action: &str, owned: bool) -> Result<Value, String> {
    match action {
        "read" | "claim" | "release" => Ok(document(&read(path)?)),
        "save" => {
            if !owned { return Err("This client no longer owns the note's editing lease. Your draft has been kept.".into()); }
            let body = field(args, "content")?;
            write_note(path, body, args)?;
            Ok(document(body))
        },
        _ => Err("Unknown chat note action".into()),
    }
}
