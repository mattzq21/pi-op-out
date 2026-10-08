use std::{fs::File, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::Path};
use serde_json::{Value, json};
use super::{State, MAX_RECORD_BYTES, error, migrate, private_open, read_state};

const PAGE_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn page(path: &Path, mut file: File, mut state: State, cursor: &Value) -> Result<Value, String> {
    if state.legacy {
        migrate(path, &state)?;
        file = private_open(path, false)?;
        state = read_state(&mut file, false, None)?;
    }
    let metadata = file.metadata().map_err(error)?;
    let revision = format!("{}:{}:{:?}", state.end, metadata.len(), metadata.modified().map_err(error)?);
    let after = decode_cursor(cursor, &revision)?;
    collect(&mut file, state, after.as_deref(), &revision)
}

fn decode_cursor(cursor: &Value, revision: &str) -> Result<Option<String>, String> {
    let cursor = cursor.as_str().ok_or("Invalid diff page cursor")?;
    if cursor.is_empty() { return Ok(None); }
    let value: Value = serde_json::from_str(cursor).map_err(error)?;
    if value["revision"] != revision { return Err("Diff history changed while paging; retry from the first page".into()); }
    Ok(Some(value["after"].as_str().ok_or("Invalid diff page message ID")?.to_owned()))
}

fn snapshot(file: &mut File, position: u64, id: &str) -> Result<Value, String> {
    file.seek(SeekFrom::Start(position)).map_err(error)?;
    let mut reader = BufReader::new(file).take((MAX_RECORD_BYTES + 1) as u64);
    let mut line = Vec::new(); reader.read_until(b'\n', &mut line).map_err(error)?;
    if line.len() > MAX_RECORD_BYTES { return Err("Permanent diff limit: individual page record is too large".into()); }
    let record: Value = serde_json::from_slice(&line).map_err(error)?;
    if record["op"] != "set" || record["id"] != id { return Err("Diff index did not match the saved record; file preserved".into()); }
    Ok(record["snapshot"].clone())
}

fn collect(file: &mut File, state: State, after: Option<&str>, revision: &str) -> Result<Value, String> {
    let mut ids = state.positions.keys().filter(|id| after.is_none_or(|after| id.as_str() > after)).collect::<Vec<_>>();
    ids.sort();
    let mut snapshots = serde_json::Map::new(); let mut bytes = 0usize; let mut last = None;
    for id in ids {
        let value = snapshot(file, state.positions[id], id)?;
        let size = serde_json::to_vec(&value).map_err(error)?.len() + id.len() + 16;
        if !snapshots.is_empty() && bytes + size > PAGE_BYTES { return Ok(json!({"snapshots":snapshots,"next":serde_json::to_string(&json!({"after":last,"revision":revision})).map_err(error)?})); }
        bytes += size; last = Some(id);
        snapshots.insert(id.clone(), value);
    }
    Ok(json!({"snapshots":snapshots,"next":null}))
}
