use super::super::protocol::Result;
use std::{fs::{self, File, OpenOptions}, path::{Path, PathBuf}};
use uuid::Uuid;

pub(super) fn lock(root: &Path) -> Result<File> {
    crate::ensure_private_dir(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(root.join("queued-input.lock")).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() { return Err("Invalid queued-input storage lock".into()); }
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(super) fn cleanup(directory: &Path, journal: Option<&Path>) -> Result<()> {
    let Some(entries) = temporary_entries(directory)? else { return Ok(()); };
    let mut removed = false;
    for entry in entries {
        removed |= remove_temporary(entry.map_err(|error| error.to_string())?, journal)?;
    }
    if removed { File::open(directory).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?; }
    Ok(())
}

fn temporary_entries(directory: &Path) -> Result<Option<fs::ReadDir>> {
    match fs::symlink_metadata(directory) {
        Ok(info) if info.is_dir() => fs::read_dir(directory).map(Some).map_err(|error| error.to_string()),
        Ok(_) => Err("Invalid queued-input storage directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_temporary(entry: fs::DirEntry, journal: Option<&Path>) -> Result<bool> {
    let Some(target) = temporary_journal(&entry.path()) else { return Ok(false); };
    if journal.is_some_and(|journal| journal != target) { return Ok(false); }
    if !entry.file_type().map_err(|error| error.to_string())?.is_file() { return Err("Invalid queued-input temporary file".into()); }
    fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
    Ok(true)
}

fn temporary_journal(file: &Path) -> Option<PathBuf> {
    let session = temporary_identity(file.file_name()?.to_str()?)?;
    Some(file.parent()?.join(format!("{session}.json")))
}

fn temporary_identity(name: &str) -> Option<Uuid> {
    let name = name.strip_prefix('.')?.strip_suffix(".tmp")?;
    let (session, publication) = name.split_once(".json.")?;
    if session.len() != 36 || publication.len() != 36 { return None; }
    let session = Uuid::parse_str(session).ok()?;
    Uuid::parse_str(publication).ok()?;
    Some(session)
}
