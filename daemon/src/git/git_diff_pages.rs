use std::{fs::File, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::Path};
use serde_json::{Value, json};
use super::{State, MAX_RECORD_BYTES, error, migrate, private_open, read_state};

const PAGE_BYTES: usize = 8 * 1024 * 1024 - 64 * 1024;
const PART_BYTES: usize = 1024 * 1024;
const PART_UNITS: usize = 512 * 1024;

struct Cursor { after: Option<String>, offset: usize }

pub(super) fn page(path: &Path, mut file: File, mut state: State, cursor: &Value) -> Result<Value, String> {
    if state.legacy {
        migrate(path, &state)?;
        file = private_open(path, false)?;
        state = read_state(&mut file, false, None)?;
    }
    let metadata = file.metadata().map_err(error)?;
    let revision = format!("{}:{}:{:?}", state.end, metadata.len(), metadata.modified().map_err(error)?);
    let cursor = decode_cursor(cursor, &revision)?;
    collect(&mut file, state, cursor, &revision)
}

fn decode_cursor(cursor: &Value, revision: &str) -> Result<Cursor, String> {
    let cursor = cursor.as_str().ok_or("Invalid diff page cursor")?;
    if cursor.is_empty() { return Ok(Cursor { after: None, offset: 0 }); }
    let value: Value = serde_json::from_str(cursor).map_err(error)?;
    if value["revision"] != revision { return Err("Diff history changed while paging; retry from the first page".into()); }
    let after = if value["after"].is_null() { None } else { Some(value["after"].as_str().ok_or("Invalid diff page message ID")?.to_owned()) };
    let offset = if value["offset"].is_null() { 0 } else { usize::try_from(value["offset"].as_u64().ok_or("Invalid diff fragment offset")?).map_err(error)? };
    Ok(Cursor { after, offset })
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

fn collect(file: &mut File, state: State, cursor: Cursor, revision: &str) -> Result<Value, String> {
    let mut ids = state.positions.keys().filter(|id| cursor.after.as_deref().is_none_or(|after| id.as_str() > after)).collect::<Vec<_>>();
    ids.sort();
    let mut snapshots = serde_json::Map::new(); let mut bytes = 0usize; let mut last = None;
    let mut after = cursor.after.as_deref();
    for (index, id) in ids.iter().enumerate() {
        let value = snapshot(file, state.positions[*id], id)?;
        let content = serde_json::to_string(&value).map_err(error)?;
        let size = content.len() + id.len() * 6 + 16;
        if !snapshots.is_empty() && bytes + size > PAGE_BYTES { return Ok(json!({"snapshots":snapshots,"next":next_cursor(last, revision, 0)?})); }
        if size > PAGE_BYTES || cursor.offset > 0 { return fragment(id, &content, cursor.offset, after, revision, index + 1 < ids.len()); }
        bytes += size; last = Some(id.as_str());
        snapshots.insert((*id).clone(), value);
        after = Some(id.as_str());
    }
    if cursor.offset > 0 { return Err("Diff fragment cursor has no snapshot".into()); }
    Ok(json!({"snapshots":snapshots,"next":null}))
}

fn next_cursor(after: Option<&str>, revision: &str, offset: usize) -> Result<String, String> {
    serde_json::to_string(&json!({"after":after,"revision":revision,"offset":offset})).map_err(error)
}

fn fragment(id: &str, content: &str, offset: usize, after: Option<&str>, revision: &str, more: bool) -> Result<Value, String> {
    let remaining = content.get(offset..).filter(|value| !value.is_empty()).ok_or("Invalid diff fragment offset")?;
    let mut bytes = 0; let mut units = 0;
    for character in remaining.chars() {
        if bytes + character.len_utf8() > PART_BYTES || units + character.len_utf16() > PART_UNITS { break; }
        bytes += character.len_utf8(); units += character.len_utf16();
    }
    let end = offset + bytes;
    let complete = end == content.len();
    let next = if !complete { Some(next_cursor(after, revision, end)?) } else if more { Some(next_cursor(Some(id), revision, 0)?) } else { None };
    Ok(json!({"snapshots":{},"next":next,"fragment":{"messageId":id,"content":&content[offset..end],"complete":complete}}))
}
