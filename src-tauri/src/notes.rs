use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::Mutex};
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
static NOTE_LOCK: Mutex<()> = Mutex::new(());

fn field<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name].as_str().ok_or_else(|| format!("Missing note {name}"))
}

fn vault(requested: Option<&str>) -> Result<PathBuf, String> {
    let path = match requested.filter(|path| !path.is_empty()) {
        Some(path) if path.starts_with("~/") => super::home_dir()?.join(&path[2..]),
        Some(path) => PathBuf::from(path),
        None => {
            let path = super::home_dir()?.join(super::STORAGE_DIRECTORY).join("notes");
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            path
        }
    };
    if !path.is_absolute() || !path.is_dir() { return Err("Choose an existing notes folder using its full path".into()); }
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn note_path(root: &Path, name: &str, create_parents: bool) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    let valid_part = |part: Component<'_>| matches!(part, Component::Normal(value) if !value.to_string_lossy().starts_with('.'));
    if name.contains('\\') || !relative.components().all(valid_part) || !is_markdown(relative) {
        return Err("Use a relative .md filename, such as Ideas/Plan.md".into());
    }
    let mut path = root.to_path_buf();
    let parts = relative.components().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        check_component(&path, index + 1 < parts.len(), create_parents)?;
    }
    Ok(path)
}

fn check_component(path: &Path, directory: bool, create: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_component(&metadata, directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if directory && create { fs::create_dir(path).map_err(|error| error.to_string())?; }
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

fn validate_component(metadata: &fs::Metadata, directory: bool) -> Result<(), String> {
    if metadata.file_type().is_symlink() { return Err("Notes cannot follow symbolic links".into()); }
    if directory != metadata.is_dir() { return Err("The note path is not a regular file or folder".into()); }
    if !directory && !metadata.is_file() { return Err("The note is not a regular file".into()); }
    Ok(())
}

fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn read(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("Could not read note: {error}"))?;
    let mut body = String::new();
    file.take(MAX_NOTE_BYTES + 1).read_to_string(&mut body).map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_NOTE_BYTES { return Err("This note is larger than 4 MB".into()); }
    Ok(body)
}

fn version(body: &str) -> String { format!("{:x}", Sha256::digest(body.as_bytes())) }

fn document(name: &str, body: &str) -> Value {
    json!({ "path": name, "content": body, "version": version(body) })
}

fn check_version(path: &Path, args: &Value) -> Result<(), String> {
    if version(&read(path)?) != field(args, "version")? {
        return Err("This note changed on disk. Save your draft as a copy, or reload the file before editing again.".into());
    }
    Ok(())
}

fn list(root: &Path) -> Result<Value, String> {
    let mut paths = Vec::new();
    let entries = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
    });
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not list notes: {error}"))?;
        if !entry.file_type().is_file() || !is_markdown(entry.path()) { continue; }
        paths.push(entry.path().strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/"));
        if paths.len() > 10_000 { return Err("Choose a notes folder with fewer than 10,000 Markdown files".into()); }
    }
    paths.sort_by_key(|path| path.to_lowercase());
    Ok(json!({ "root": root, "paths": paths }))
}

fn write_note(path: &Path, body: &str, create: bool, args: &Value) -> Result<(), String> {
    if body.len() as u64 > MAX_NOTE_BYTES { return Err("Notes must be smaller than 4 MB".into()); }
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
            fs::hard_link(&temporary, path).map_err(|error| format!("Could not create note (the name may already exist): {error}"))?;
        } else {
            check_version(path, args)?;
            fs::rename(&temporary, path).map_err(|error| format!("Could not save note: {error}"))?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn move_note(path: &Path, destination: &Path) -> Result<(), String> {
    fs::hard_link(path, destination).map_err(|error| format!("Could not move note (the name may already exist): {error}"))?;
    if let Err(error) = fs::remove_file(path) {
        let _ = fs::remove_file(destination);
        return Err(format!("Could not move note: {error}"));
    }
    Ok(())
}

fn rename(root: &Path, path: &Path, args: &Value) -> Result<Value, String> {
    check_version(path, args)?;
    let name = field(args, "destination")?;
    let destination = note_path(root, name, true)?;
    let body = read(path)?;
    if path != destination { move_note(path, &destination)?; }
    Ok(document(name, &body))
}

fn trash(root: &Path, path: &Path, args: &Value) -> Result<Value, String> {
    check_version(path, args)?;
    let folder = root.join(".trash");
    check_component(&folder, true, true)?;
    let name = path.file_name().ok_or("Note has no filename")?.to_string_lossy();
    move_note(path, &folder.join(format!("{}-{name}", Uuid::new_v4())))?;
    Ok(Value::Null)
}

pub(super) fn dispatch(args: Value) -> Result<Value, String> {
    let _guard = NOTE_LOCK.lock().map_err(|_| "Notes are unavailable")?;
    let root = vault(args["root"].as_str())?;
    let action = field(&args, "action")?;
    if action == "list" { return list(&root); }
    let name = field(&args, "path")?;
    let path = note_path(&root, name, action == "create")?;
    note_action(&root, &path, name, action, &args)
}

fn note_action(root: &Path, path: &Path, name: &str, action: &str, args: &Value) -> Result<Value, String> {
    match action {
        "read" => Ok(document(name, &read(path)?)),
        "create" | "save" => {
            let body = field(args, "content")?;
            write_note(path, body, action == "create", args)?;
            Ok(document(name, body))
        }
        "rename" => rename(root, path, args),
        "trash" => trash(root, path, args),
        _ => Err("Unknown notes action".into()),
    }
}
