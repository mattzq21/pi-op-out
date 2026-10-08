use super::Result;
use serde_json::Value;
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader},
    path::Path,
};
use uuid::Uuid;

pub(super) fn saved_user_messages(path: &Path, session_id: &str) -> Result<Vec<Value>> {
    let Some(file) = open_transcript(path)? else { return Ok(Vec::new()); };
    let messages = read_user_messages(&mut BufReader::new(&file), session_id)?;
    if !messages.is_empty() { sync_transcript(&file, path)?; }
    Ok(messages)
}

fn open_transcript(path: &Path) -> Result<Option<File>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot verify saved queued input: {error}")),
    };
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Queued-input transcript must be a regular file".into());
    }
    Ok(Some(file))
}

fn sync_transcript(file: &File, path: &Path) -> Result<()> {
    file.sync_all().map_err(|error| format!("Cannot sync saved queued input: {error}"))?;
    let parent = path.parent().ok_or("Queued-input transcript has no directory")?;
    File::open(parent).and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot sync queued-input transcript directory: {error}"))
}

fn read_user_messages(reader: &mut impl BufRead, session_id: &str) -> Result<Vec<Value>> {
    let Some(header) = read_complete_entry(reader)? else { return Ok(Vec::new()); };
    let expected = Uuid::parse_str(session_id).map_err(|_| "Invalid queued-input session identity")?;
    let identity = header["id"].as_str().and_then(|id| Uuid::parse_str(id).ok());
    if header["type"] != "session" || identity != Some(expected) {
        return Err("Queued-input transcript belongs to a different conversation".into());
    }
    let mut messages = Vec::new();
    while let Some(entry) = read_complete_entry(reader)? {
        if entry["type"] == "message" && entry["message"]["role"] == "user" {
            messages.push(entry["message"].clone());
        }
    }
    Ok(messages)
}

fn read_complete_entry(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    reader.read_until(b'\n', &mut bytes).map_err(|error| format!("Cannot read queued-input transcript: {error}"))?;
    if bytes.last() != Some(&b'\n') { return Ok(None); }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| format!("Cannot verify queued-input transcript: {error}"))
}
