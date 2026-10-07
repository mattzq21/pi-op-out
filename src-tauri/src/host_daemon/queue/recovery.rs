use super::{storage::QueueStorage, Result};
use super::super::ownership::ConversationOwnership;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(crate) struct Recovery {
    pub errors: Vec<String>,
    pub recovered: bool,
    pub retry: bool,
    pub transactions_pending: bool,
}

pub(crate) fn recover_missing_transcripts(root: &Path, ownership: &ConversationOwnership) -> Recovery {
    recover_storage(root, ownership).unwrap_or_else(|error| Recovery { errors: vec![error], ..Recovery::default() })
}

fn recover_storage(root: &Path, ownership: &ConversationOwnership) -> Result<Recovery> {
    let entries = match fs::read_dir(root.join("queued-input")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Recovery::default()),
        Err(error) => return Err(error.to_string()),
    };
    let Some(_storage_locks) = storage_locks(root)? else { return Ok(Recovery { retry: true, ..Recovery::default() }); };
    if transactions_pending(root)? { return Ok(Recovery { retry: true, transactions_pending: true, ..Recovery::default() }); }
    Ok(recover_entries(root, ownership, entries))
}

fn recover_entries(root: &Path, ownership: &ConversationOwnership, entries: fs::ReadDir) -> Recovery {
    let mut recovery = Recovery::default();
    for entry in entries {
        let result = entry.map_err(|error| error.to_string()).and_then(|entry| recover_journal(root, ownership, &entry.path()));
        match result {
            Ok(recovered) => recovery.recovered |= recovered,
            Err(error) => recovery.errors.push(error),
        }
    }
    recovery
}

fn storage_locks(root: &Path) -> Result<Option<(File, File)>> {
    let Some(notes) = try_lock(&root.join("notes").join("ownership.lock"))? else { return Ok(None); };
    let Some(restore) = try_lock(&root.join("restore.lock"))? else { return Ok(None); };
    Ok(Some((notes, restore)))
}

fn transactions_pending(root: &Path) -> Result<bool> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with("archive-transaction-") { return Ok(true); }
    }
    for area in ["restore-transactions", "fork-transactions", "deleted-sessions"] {
        if directory_has_entries(&root.join(area))? { return Ok(true); }
    }
    deletion_pending(&root.join("sessions")).and_then(|active| {
        if active { Ok(true) } else { deletion_pending(&root.join("archived")) }
    })
}

fn directory_has_entries(path: &Path) -> Result<bool> {
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().transpose().map(|entry| entry.is_some()).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn deletion_pending(path: &Path) -> Result<bool> {
    if !path.try_exists().map_err(|error| error.to_string())? { return Ok(false); }
    let entries = walkdir::WalkDir::new(path).follow_links(false).into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().ends_with(".snapshots"));
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy();
        if name.starts_with(".delete-") && name.ends_with(".lock") { return Ok(true); }
    }
    Ok(false)
}

fn recover_journal(root: &Path, ownership: &ConversationOwnership, path: &Path) -> Result<bool> {
    let Some((id, _ownership_lock, _worker_lock)) = lock_journal(root, path)? else { return Ok(false); };
    remove_temporary(&root.join("sessions").join(format!(".queued-input-recovery-{id}")))?;
    if ownership.removed(&id)? || transcript_exists(root, &id)? { return Ok(false); }
    recover_contents(root, path, &id)
}

fn lock_journal(root: &Path, path: &Path) -> Result<Option<(String, File, File)>> {
    if path.extension().is_none_or(|extension| extension != "json") { return Ok(None); }
    let id = path.file_stem().and_then(|name| name.to_str()).ok_or("Invalid queued-input journal name")?;
    let key = ConversationOwnership::key(id)?;
    let Some(ownership_lock) = try_lock(&root.join("conversation-ownership").join(format!("{key}.lock")))? else { return Ok(None); };
    let Some(worker_lock) = try_lock(&root.join("session-claims").join(format!("id-{key}.lock")))? else { return Ok(None); };
    Ok(Some((id.into(), ownership_lock, worker_lock)))
}

fn recover_contents(root: &Path, path: &Path, id: &str) -> Result<bool> {
    let pending = QueueStorage::new(&root.join("queued-input"), id)?.load()?;
    if pending.is_empty() { return Ok(false); }
    let journal: Value = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let cwd = journal["origin"]["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or("Queued input retained: recovery working directory is missing")?;
    let target = recovery_path(root, id, &journal["origin"])?;
    let name = pending.first().and_then(|item| item["message"].as_str()).unwrap_or("Recovered queued input");
    create_transcript(&target, id, cwd, name)
}

fn try_lock(path: &Path) -> Result<Option<File>> {
    crate::ensure_private_dir(path.parent().ok_or("Conversation lock has no directory")?)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn transcript_exists(root: &Path, id: &str) -> Result<bool> {
    for area in ["sessions", "archived"] {
        let directory = root.join(area);
        if !directory.try_exists().map_err(|error| error.to_string())? { continue; }
        let entries = walkdir::WalkDir::new(directory).follow_links(false).into_iter()
            .filter_entry(|entry| !entry.file_name().to_string_lossy().ends_with(".snapshots"));
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_type().is_file() && entry.path().extension().is_some_and(|extension| extension == "jsonl")
                && matching_header(entry.path(), id)? { return Ok(true); }
        }
    }
    Ok(false)
}

fn matching_header(path: &Path, id: &str) -> Result<bool> {
    let mut header = String::new();
    BufReader::new(File::open(path).map_err(|error| error.to_string())?).take(64 * 1024)
        .read_line(&mut header).map_err(|error| error.to_string())?;
    let parsed: Value = match serde_json::from_str(&header) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(path.file_stem().is_some_and(|name| name.to_string_lossy().ends_with(id))),
    };
    Ok(parsed["type"] == "session" && parsed["id"].as_str().is_some_and(|candidate| candidate.eq_ignore_ascii_case(id)))
}

fn recovery_path(root: &Path, id: &str, origin: &Value) -> Result<PathBuf> {
    let directory = root.join("sessions");
    crate::ensure_private_dir(&directory)?;
    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
    if let Some(path) = origin["sessionPath"].as_str().map(Path::new) {
        let parent = path.parent().ok_or("Queued-input transcript has no directory")?;
        if parent.canonicalize().map_err(|error| error.to_string())? != directory || path.extension().is_none_or(|extension| extension != "jsonl") {
            return Err("Queued-input recovery path is outside active session storage".into());
        }
        return Ok(path.into());
    }
    Ok(directory.join(format!("recovered_{id}.jsonl")))
}

fn create_transcript(path: &Path, id: &str, cwd: &str, name: &str) -> Result<bool> {
    let name: String = name.chars().take(120).collect();
    let output = crate::node_command().args(["-e", TRANSCRIPT, id, cwd, &name]).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    let temporary = path.parent().ok_or("Queued-input transcript has no directory")?.join(format!(".queued-input-recovery-{id}"));
    let result = install_transcript(path, &temporary, &output.stdout);
    let cleanup = remove_temporary(&temporary);
    if result.is_ok() { cleanup?; }
    result
}

fn remove_temporary(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            let parent = path.parent().ok_or("Queued-input recovery temporary file has no directory")?;
            File::open(parent).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())
        },
        Ok(_) => Err("Invalid queued-input recovery temporary file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn install_transcript(path: &Path, temporary: &Path, body: &[u8]) -> Result<bool> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(temporary).map_err(|error| error.to_string())?;
    file.write_all(body).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    match fs::hard_link(temporary, path) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error.to_string()),
    }
    let parent = path.parent().ok_or("Queued-input transcript has no directory")?;
    File::open(parent).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
    Ok(true)
}

const TRANSCRIPT: &str = r#"
const [id, cwd, name] = process.argv.slice(1);
const timestamp = new Date().toISOString();
const header = {type: 'session', version: 3, id, timestamp, cwd};
const info = {type: 'session_info', id: require('node:crypto').randomUUID().slice(0, 8), parentId: null, timestamp,
  name: `Recovered queued input: ${name.trim().slice(0, 120)}`};
process.stdout.write(JSON.stringify(header) + '\n' + JSON.stringify(info) + '\n');
"#;
