use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};

const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn resolve(cwd: &str, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(cwd).canonicalize().map_err(|error| format!("Could not open project: {error}"))?;
    if !root.is_dir() { return Err("Project path is not a directory".into()); }
    let requested = Path::new(path);
    let target = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    let target = target.canonicalize().map_err(|error| format!("Could not open path: {error}"))?;
    if !target.starts_with(&root) { return Err("This path is outside the chat's project directory".into()); }
    Ok((root, target))
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

pub(crate) fn list(cwd: &str, path: &str) -> Result<Value, String> {
    let (root, directory) = resolve(cwd, path)?;
    let entries = fs::read_dir(&directory).map_err(|error| format!("Could not list directory: {error}"))?;
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if rows.len() >= ENTRY_LIMIT { return Err("This directory contains too many entries to display".into()); }
        if let Some(row) = directory_entry(&root, &entry) { rows.push(row); }
    }
    rows.sort_by(|left, right| {
        right["directory"].as_bool().cmp(&left["directory"].as_bool())
            .then_with(|| left["name"].as_str().unwrap_or("").to_lowercase().cmp(&right["name"].as_str().unwrap_or("").to_lowercase()))
    });
    let parent = directory.parent().filter(|parent| parent.starts_with(&root)).map(|parent| relative(&root, parent));
    Ok(json!({ "path": relative(&root, &directory), "parent": parent, "entries": rows }))
}

fn directory_entry(root: &Path, entry: &fs::DirEntry) -> Option<Value> {
    let path = entry.path();
    let resolved = path.canonicalize().ok()?;
    if !resolved.starts_with(root) { return None; }
    let metadata = resolved.metadata().ok()?;
    if !metadata.is_dir() && !metadata.is_file() { return None; }
    Some(json!({ "name": entry.file_name().to_string_lossy(), "path": relative(root, &path), "directory": metadata.is_dir() }))
}

fn read_text(path: &Path) -> Result<String, String> {
    if !fs::metadata(path).map_err(|error| error.to_string())?.is_file() { return Err("Select a regular text file".into()); }
    let file = File::open(path).map_err(|error| format!("Could not read file: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Select a regular text file".into()); }
    if metadata.len() > FILE_LIMIT { return Err("Files larger than 2 MB cannot be opened in the editor".into()); }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > FILE_LIMIT { return Err("File exceeds the 2 MB editor limit".into()); }
    if bytes.contains(&0) { return Err("Binary files cannot be opened in the editor".into()); }
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text".into())
}

fn revision(content: &str) -> String { format!("{:x}", Sha256::digest(content.as_bytes())) }

pub(crate) fn read(cwd: &str, path: &str) -> Result<Value, String> {
    let (root, path) = resolve(cwd, path)?;
    let content = read_text(&path)?;
    Ok(json!({ "path": relative(&root, &path), "content": content, "revision": revision(&content) }))
}

pub(crate) fn save(cwd: &str, path: &str, content: &str, expected: &str) -> Result<Value, String> {
    if content.len() as u64 > FILE_LIMIT { return Err("File exceeds the 2 MB editor limit".into()); }
    let _guard = SAVE_LOCK.lock().map_err(|_| "File save lock unavailable")?;
    let (root, path) = resolve(cwd, path)?;
    let current = read_text(&path)?;
    if revision(&current) != expected { return Err("This file changed on disk. Reload it before saving to avoid overwriting those changes.".into()); }
    replace_file(&path, content)?;
    Ok(json!({ "path": relative(&root, &path), "content": content, "revision": revision(content) }))
}

fn replace_file(path: &Path, content: &str) -> Result<(), String> {
    let temporary = path.with_file_name(format!(".piop-save-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.set_permissions(fs::metadata(path)?.permissions())?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result.map_err(|error: std::io::Error| format!("Could not save file: {error}"))
}
