use super::protocol::Result;
use sha2::{Digest, Sha256};
use serde_json::Value;
use std::{collections::HashSet, fs::{self, File, OpenOptions}, path::{Component, Path, PathBuf}};

pub(super) fn lock(root: &Path) -> Result<File> {
    crate::ensure_private_dir(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(root.join("reference-publication.lock")).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Invalid reference publication lock".into());
    }
    file.lock_shared().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(super) fn register_transcript(root: &Path, transcript: &Path) -> Result<()> {
    if !transcript.is_absolute() { return Err("External transcript path must be absolute".into()); }
    let directory = root.join("external-transcripts");
    crate::ensure_private_dir(&directory)?;
    let path = transcript.to_str().ok_or("Invalid external transcript path")?;
    let record = directory.join(format!("{:x}.json", Sha256::digest(path.as_bytes())));
    crate::atomic_write_private(&record, &serde_json::to_vec(&serde_json::json!({"path":path})).map_err(|error| error.to_string())?)?;
    for path in [&record, &directory, root] {
        File::open(path).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn validate_new_references(root: &Path, values: &[Value], previous: &[Value]) -> Result<()> {
    let mut retained = value_references(root, previous);
    let mut pending: Vec<_> = value_references(root, values).into_iter().collect();
    while let Some(directory) = pending.pop() {
        if !retained.insert(directory.clone()) { continue; }
        pending.extend(goal_dependencies(root, &directory).map_err(|error| {
            format!("Managed goal attachment is unavailable: {}. Reattach it before saving. {error}", directory.display())
        })?);
    }
    Ok(())
}

fn value_references(root: &Path, values: &[Value]) -> HashSet<PathBuf> {
    let mut found = HashSet::new();
    let mut pending: Vec<_> = values.iter().collect();
    while let Some(value) = pending.pop() {
        match value {
            Value::String(text) => text_references(root, text, &mut found),
            Value::Array(items) => pending.extend(items),
            Value::Object(items) => {
                for (key, value) in items { text_references(root, key, &mut found); pending.push(value); }
            },
            _ => {},
        }
    }
    found
}

fn text_references(root: &Path, text: &str, found: &mut HashSet<PathBuf>) {
    for area in ["sessions", "archived", "fork-transactions", "fork-preparations"] {
        let prefix = format!("{}/{area}/", root.display());
        for (start, _) in text.match_indices(&prefix) {
            let remainder = &text[start..];
            let root_prefix = format!("{}/", root.display());
            let next = remainder[prefix.len()..].find(&root_prefix).map_or(remainder.len(), |offset| prefix.len() + offset);
            let segment = &remainder[..next];
            let end = segment.find(['\r', '\n']).unwrap_or(segment.len());
            if let Some(path) = managed_goal_path(&segment[..end]) { found.insert(path); }
        }
    }
}

fn managed_goal_path(text: &str) -> Option<PathBuf> {
    let marker = "/attachments/goal-";
    for (start, _) in text.match_indices(marker) {
        let suffix = &text[start + marker.len()..];
        let Some(identity) = suffix.get(..6) else { continue; };
        if !identity.bytes().all(|byte| byte.is_ascii_alphanumeric()) { continue; }
        if suffix.as_bytes().get(6).is_some_and(u8::is_ascii_alphanumeric) { continue; }
        let path = PathBuf::from(&text[..start + marker.len() + 6]);
        if path.components().any(|part| part == Component::ParentDir) { continue; }
        if path.components().collect::<PathBuf>().as_os_str() == path.as_os_str() { return Some(path); }
    }
    None
}

fn validate_goal_directory(directory: &Path) -> Result<()> {
    let objective = directory.join("goal-objective.md");
    if !fs::symlink_metadata(directory).map_err(|error| error.to_string())?.is_dir()
        || !fs::symlink_metadata(objective).map_err(|error| error.to_string())?.is_file() {
        return Err("Invalid goal attachment".into());
    }
    Ok(())
}

fn goal_dependencies(root: &Path, directory: &Path) -> Result<HashSet<PathBuf>> {
    validate_goal_directory(directory)?;
    let mut found = HashSet::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() { continue; }
        if !matches!(entry.path().extension().and_then(|extension| extension.to_str()), Some("md" | "txt")) { continue; }
        let text = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
        text_references(root, &text, &mut found);
    }
    Ok(found)
}
