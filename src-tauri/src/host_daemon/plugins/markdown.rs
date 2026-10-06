use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use uuid::Uuid;

const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
static NOTE_LOCK: Mutex<()> = Mutex::new(());

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
    let _guard = NOTE_LOCK.lock().map_err(|_| "Notes are unavailable")?;
    let path = note_path(field(&args, "sessionId")?)?;
    match field(&args, "action")? {
        "read" => Ok(document(&read(&path)?)),
        "save" => save(&path, &args),
        _ => Err("Unknown chat note action".into()),
    }
}

fn save(path: &Path, args: &Value) -> Result<Value, String> {
    let body = field(args, "content")?;
    let current = read(path)?;
    if version(&current) != field(args, "version")? { return Ok(document(&current)); }
    write_note(path, body, args)?;
    Ok(document(body))
}
