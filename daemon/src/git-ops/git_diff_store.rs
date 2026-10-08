use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use crate::git_ops::{GitDiffSnapshots, MAX_GIT_PATCH_BYTES};

#[path = "git_diff_pages.rs"]
mod pages;
#[path = "git_diff_migration.rs"]
mod migration;

pub(super) const HEADER: &[u8] = b"PIOP-DIFFS-1\n";
pub(super) const MAX_RECORD_BYTES: usize = MAX_GIT_PATCH_BYTES * 6 + 64 * 1024;

#[derive(Default)]
pub(super) struct State {
    pub(super) snapshots: HashMap<String, Value>,
    pub(super) pending: HashMap<String, Value>,
    transfers: HashMap<String, Value>,
    digests: HashMap<String, String>,
    positions: HashMap<String, u64>,
    materialize: bool,
    focus: Option<String>,
    removed: HashSet<String>,
    done: HashSet<String>,
    end: u64,
    legacy: bool,
}

fn error(error: impl std::fmt::Display) -> String { format!("Diff storage: {error}") }

fn digest(snapshot: &Value) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(snapshot).map_err(error)?)))
}

fn private_open(path: &Path, create_new: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new { options.create_new(true); } else { options.create(true).truncate(false); }
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    options.open(path).map_err(error)
}

fn sync_parent(path: &Path) -> Result<(), String> {
    File::open(path.parent().ok_or("Diff storage has no parent")?).and_then(|file| file.sync_all()).map_err(error)
}

pub(super) fn lock(path: &Path) -> Result<File, String> {
    let file = private_open(&PathBuf::from(format!("{}.lock", path.display())), false)?;
    file.lock().map_err(error)?;
    Ok(file)
}

fn apply(state: &mut State, record: Value) -> Result<(), String> {
    let id = record["id"].as_str().ok_or("Diff record has no message ID")?.to_owned();
    match record["op"].as_str() {
        Some("set") => return apply_snapshot(state, id, &record["snapshot"]),
        Some("remove") => { state.snapshots.remove(&id); state.digests.remove(&id); state.removed.insert(id); }
        Some("pending") => return apply_pending(state, id, record["capture"].clone()),
        Some("done") => { state.pending.remove(&id); state.done.insert(id); }
        Some("transfer") => return apply_transfer(state, &record),
        _ => return Err("Unknown diff log operation; file preserved".into()),
    }
    Ok(())
}

fn apply_pending(state: &mut State, id: String, mut capture: Value) -> Result<(), String> {
    state.done.remove(&id);
    if state.focus.as_deref() != Some(&id) { capture.as_object_mut().ok_or("Invalid pending comparison")?.remove("snapshot"); }
    state.pending.insert(id, capture);
    Ok(())
}

fn apply_transfer(state: &mut State, record: &Value) -> Result<(), String> {
    let key = record["key"].as_str().ok_or("Invalid diff transfer identity")?.to_owned();
    if !record["transfer"].is_object() { return Err("Invalid diff transfer metadata; file preserved".into()); }
    state.transfers.insert(key, record["transfer"].clone());
    Ok(())
}

fn apply_snapshot(state: &mut State, id: String, snapshot: &Value) -> Result<(), String> {
    serde_json::from_value::<crate::git_ops::GitDiffSnapshot>(snapshot.clone()).map_err(error)?;
    state.removed.remove(&id);
    state.digests.insert(id.clone(), digest(snapshot)?);
    if state.materialize { state.snapshots.insert(id, snapshot.clone()); }
    Ok(())
}

fn read_log(mut reader: impl BufRead, mut state: State) -> Result<State, String> {
    let mut transaction = None::<State>;
    let mut offset = HEADER.len() as u64;
    loop {
        let mut line = Vec::new();
        let count = reader.by_ref().take((MAX_RECORD_BYTES + 1) as u64).read_until(b'\n', &mut line).map_err(error)?;
        if count == 0 { break; }
        if count > MAX_RECORD_BYTES { return Err("Permanent diff limit: individual log record is too large; file preserved".into()); }
        if line.last() != Some(&b'\n') { break; }
        let start = offset;
        offset += count as u64;
        let record: Value = serde_json::from_slice(&line).map_err(|cause| format!("Damaged diff log at byte {}; file preserved: {cause}", offset - count as u64))?;
        consume(&mut state, record, &mut transaction, offset, start)?;
    }
    Ok(state)
}

fn consume(state: &mut State, record: Value, transaction: &mut Option<State>, offset: u64, start: u64) -> Result<(), String> {
    match record["op"].as_str() {
        Some("begin") if transaction.is_none() => *transaction = Some(State { materialize:state.materialize, focus:state.focus.clone(), ..State::default() }),
        Some("commit") => {
            merge(state, transaction.take().ok_or("Diff commit without transaction")?);
            state.end = offset;
        }
        Some("begin") => return Err("Nested diff transaction; file preserved".into()),
        _ => apply_at(transaction.as_mut().ok_or("Diff operation outside transaction")?, record, start)?,
    }
    Ok(())
}

fn apply_at(state: &mut State, record: Value, start: u64) -> Result<(), String> {
    let id = record["id"].as_str().ok_or("Diff record has no message ID")?.to_owned();
    let snapshot = record["op"] == "set";
    apply(state, record)?;
    if snapshot { state.positions.insert(id, start); }
    Ok(())
}

fn merge(state: &mut State, transaction: State) {
    state.snapshots.extend(transaction.snapshots);
    state.digests.extend(transaction.digests);
    state.positions.extend(transaction.positions);
    for (id, capture) in transaction.pending {
        if !state.done.contains(&id) || capture["source"] == "copy" { state.pending.insert(id, capture); }
    }
    state.transfers.extend(transaction.transfers);
    for id in transaction.removed { state.snapshots.remove(&id); state.digests.remove(&id); state.positions.remove(&id); }
    for id in transaction.done { state.pending.remove(&id); state.done.insert(id); }
}

fn completed(state: &State, id: &str) -> bool { state.done.contains(id) || state.digests.contains_key(id) }

#[cfg(test)]
pub(super) fn read(reader: impl Read) -> Result<State, String> {
    read_state(reader, true, None)
}

fn read_state(reader: impl Read, materialize: bool, focus: Option<String>) -> Result<State, String> {
    let mut reader = BufReader::new(reader);
    if reader.fill_buf().map_err(error)?.is_empty() { return Ok(State::default()); }
    if reader.fill_buf().map_err(error)?.starts_with(b"PIOP-") {
        let mut header = vec![0; HEADER.len()];
        reader.read_exact(&mut header).map_err(error)?;
        if header != HEADER { return Err("Unknown diff storage version; file preserved".into()); }
        return read_log(reader, State { end: HEADER.len() as u64, materialize, focus, ..State::default() });
    }
    let snapshots: GitDiffSnapshots = serde_json::from_reader(reader).map_err(error)?;
    let snapshots: HashMap<String, Value> = snapshots.into_iter().map(|(id, snapshot)| serde_json::to_value(snapshot).map(|value| (id, value))).collect::<Result<_, _>>().map_err(error)?;
    let digests = snapshots.iter().map(|(id, snapshot)| digest(snapshot).map(|digest| (id.clone(), digest))).collect::<Result<_, _>>()?;
    Ok(State { snapshots, digests, legacy: true, ..State::default() })
}

fn record_bytes(record: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(record).map_err(error)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_RECORD_BYTES { return Err("Permanent diff limit: individual record is too large; comparison retained".into()); }
    Ok(bytes)
}

fn write_transaction(file: &mut File, records: &[Value]) -> Result<(), String> {
    for record in records { record_bytes(record)?; }
    file.write_all(b"{\"op\":\"begin\"}\n").map_err(error)?;
    for record in records { file.write_all(&record_bytes(record)?).map_err(error)?; }
    file.write_all(b"{\"op\":\"commit\"}\n").and_then(|_| file.sync_all()).map_err(error)
}

fn migrate(path: &Path, state: &State) -> Result<(), String> {
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = private_open(&temporary, true)?;
        file.write_all(HEADER).map_err(error)?;
        for (id, snapshot) in &state.snapshots { write_transaction(&mut file, &[json!({"op":"set","id":id,"snapshot":snapshot})])?; }
        file.sync_all().map_err(error)?;
        fs::rename(&temporary, path).map_err(error)?;
        sync_parent(path)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

fn operations(state: &State, request: &Value) -> Result<Vec<Value>, String> {
    match request["action"].as_str() {
        Some("replace") => replacement(state, &request["snapshots"]),
        Some("merge") => updates(state, &request["snapshots"]),
        Some("pending") => pending_operation(state, request),
        Some("finish") => finish_operation(state, request),
        _ => Err("Unknown diff storage request".into()),
    }
}

fn finish_operation(state: &State, request: &Value) -> Result<Vec<Value>, String> {
    let id = request["id"].as_str().ok_or("Missing diff message ID")?;
    if state.pending.get(id) != Some(&request["capture"]) { return Ok(Vec::new()); }
    let mut records = Vec::new();
    if request["capture"]["remove"] == true { records.push(json!({"op":"remove","id":id})); }
    else if !request["snapshot"].is_null() { records.push(json!({"op":"set","id":id,"snapshot":request["snapshot"]})); }
    records.push(json!({"op":"done","id":id}));
    Ok(records)
}

fn pending_operation(state: &State, request: &Value) -> Result<Vec<Value>, String> {
    let id = request["id"].as_str().ok_or("Missing pending diff message ID")?;
    if let Some(previous) = state.pending.get(id) {
        if previous["baseline"] != request["capture"]["baseline"] || previous["current"] != request["capture"]["current"] {
            return Err("A different pending comparison already owns this message; snapshots preserved".into());
        }
        if previous["ready"] == true && request["capture"]["ready"] != true { return Ok(Vec::new()); }
        if request["capture"]["ready"] != true && request["capture"]["failure"].is_null() { return Ok(Vec::new()); }
    }
    else if completed(state, id) { return Ok(Vec::new()); }
    Ok(vec![json!({"op":"pending","id":id,"capture":request["capture"]})])
}

fn replacement(state: &State, snapshots: &Value) -> Result<Vec<Value>, String> {
    let mut records = updates(state, snapshots)?;
    let snapshots = snapshots.as_object().ok_or("Diff snapshots must be an object")?;
    for id in state.digests.keys() {
        if !snapshots.contains_key(id) { records.push(json!({"op":"remove","id":id})); }
    }
    Ok(records)
}

fn updates(state: &State, snapshots: &Value) -> Result<Vec<Value>, String> {
    let snapshots = snapshots.as_object().ok_or("Diff snapshots must be an object")?;
    let mut records = Vec::new();
    for (id, snapshot) in snapshots {
        if state.digests.get(id) != Some(&digest(snapshot)?) { records.push(json!({"op":"set","id":id,"snapshot":snapshot})); }
    }
    Ok(records)
}

pub(super) fn request(path: &Path, request: &Value) -> Result<Value, String> {
    let _lock = lock(path)?;
    let _shards = migration::lock_shards(path)?;
    let mut file = read_migrated(path)?;
    let state = read_state(&mut file, request["action"] == "load", request["id"].as_str().map(str::to_owned))?;
    if request["action"] == "page" { return pages::page(path, file, state, &request["cursor"]); }
    if let Some(response) = read_action(&state, request) { return Ok(response); }
    if request["action"] == "finish" { return finish_request(path, request, file, &state); }
    save_request(path, request, file, &state)
}

fn read_migrated(path: &Path) -> Result<File, String> {
    let mut file = private_open(path, false)?;
    if migration::legacy(path, &mut file)? { file = private_open(path, false)?; }
    migration::shards(path, &mut file)?;
    Ok(file)
}

fn read_action(state: &State, request: &Value) -> Option<Value> {
    match request["action"].as_str() {
        Some("load") => Some(json!({"snapshots":state.snapshots,"pending":state.pending,"transfers":state.transfers})),
        Some("pending_ids") => Some(json!({"ids":state.pending.keys().collect::<Vec<_>>()})),
        Some("pending_status") => {
            let id = request["id"].as_str()?;
            Some(json!({"capture":state.pending.get(id),"completed":completed(state, id)}))
        }
        _ => None,
    }
}

fn save_request(path: &Path, request: &Value, file: File, state: &State) -> Result<Value, String> {
    let mut records = operations(state, request)?;
    validate_records(&records)?;
    let mut file = prepare(path, file, state)?;
    append_records(request, state, &mut file, &mut records)?;
    file.sync_all().map_err(error)?;
    sync_parent(path)?;
    Ok(Value::Null)
}

fn finish_request(path: &Path, request: &Value, file: File, state: &State) -> Result<Value, String> {
    let id = request["id"].as_str().ok_or("Missing diff message ID")?;
    if state.pending.get(id) != Some(&request["capture"]) { return Ok(json!({"finished":!state.pending.contains_key(id) && completed(state, id)})); }
    save_request(path, request, file, state)?;
    Ok(json!({"finished":true}))
}

fn append_records(request: &Value, state: &State, file: &mut File, records: &mut Vec<Value>) -> Result<(), String> {
    if matches!(request["action"].as_str(), Some("replace" | "merge")) && !records.is_empty() {
        records.extend(copy_pending(state, records)?);
    }
    if !records.is_empty() { write_transaction(file, records)?; }
    Ok(())
}

fn validate_records(records: &[Value]) -> Result<(), String> {
    for record in records { let mut validation = State::default(); apply(&mut validation, record.clone())?; record_bytes(record)?; }
    Ok(())
}

fn prepare(path: &Path, mut file: File, state: &State) -> Result<File, String> {
    if state.legacy || state.end == 0 { migrate(path, state)?; file = private_open(path, false)?; file.seek(SeekFrom::End(0)).map_err(error)?; }
    else { file.set_len(state.end).map_err(error)?; file.seek(SeekFrom::Start(state.end)).map_err(error)?; }
    Ok(file)
}

fn copy_pending(state: &State, records: &[Value]) -> Result<Vec<Value>, String> {
    records.iter().map(|record| {
        let id = record["id"].as_str().ok_or("Copied diff has no message ID")?;
        if state.pending.get(id).is_some_and(|capture| capture["source"] != "copy") { return Err("An unfinished comparison owns this message; copy retained for retry".into()); }
        Ok(json!({"op":"done","id":id}))
    }).collect()
}
