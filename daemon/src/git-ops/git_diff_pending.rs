use serde_json::{Value, json};
use crate::RemoteHost;
#[cfg(test)]
use crate::git_ops::GitDiffSnapshots;
use super::{discard_git_tree_at_host, load_git_diff_between_at_host, storage_request};

struct Storage<'a> { path: &'a str, host: Option<&'a RemoteHost>, ephemeral_id: Option<&'a str> }

impl Storage<'_> {
    fn request(&self, mut request: Value) -> Result<Value, String> {
        if let Some(id) = self.ephemeral_id { request["ephemeralSessionId"] = json!(id); }
        storage_request(self.path, &request, self.host)
    }
}

fn finish(storage: &Storage<'_>, id: &str, capture: Value) -> Result<Value, String> {
    if capture["failure"]["kind"] == "permanent" { return Err(format!("{}; pending comparison preserved", capture["failure"]["message"].as_str().unwrap_or("Permanent diff limit"))); }
    let result = finish_inner(storage, id, capture);
    if let Err(error) = &result {
        let _ = retain_failure(storage, id, error);
    }
    result
}

fn retain_failure(storage: &Storage<'_>, id: &str, error: &str) -> Result<(), String> {
    let state = storage.request(json!({"action":"pending_status","id":id}))?;
    if let Some(capture) = state.get("capture").filter(|capture| !capture.is_null()) {
        let mut capture = capture.clone();
        let kind = if error.starts_with("Permanent diff limit:") { "permanent" } else { "transient" };
        capture["failure"] = json!({"kind":kind,"message":error});
        storage.request(json!({"action":"pending","id":id,"capture":capture}))?;
    }
    Ok(())
}

fn finish_inner(storage: &Storage<'_>, id: &str, capture: Value) -> Result<Value, String> {
    if capture["source"] == "copy" {
        commit(storage, id, &capture, &capture["snapshot"])?;
        return Ok(capture["snapshot"].clone());
    }
    let cwd = capture["cwd"].as_str().ok_or("Pending diff has no project directory")?.to_owned();
    let baseline = capture["baseline"].as_str().ok_or("Pending diff has no baseline")?.to_owned();
    let current = capture["current"].as_str().ok_or("Pending diff has no final snapshot")?.to_owned();
    let snapshot = capture_snapshot(&capture, &cwd, &baseline, &current, storage.host)?;
    commit(storage, id, &capture, &snapshot)?;
    let _ = discard_git_tree_at_host(&baseline, storage.host);
    let _ = discard_git_tree_at_host(&current, storage.host);
    Ok(snapshot)
}

fn commit(storage: &Storage<'_>, id: &str, capture: &Value, snapshot: &Value) -> Result<(), String> {
    let result = storage.request(json!({"action":"finish","id":id,"capture":capture,"snapshot":snapshot}))?;
    if result["finished"] != true { return Err("Pending comparison changed during commit; snapshots preserved for retry".into()); }
    Ok(())
}

fn capture_snapshot(capture: &Value, cwd: &str, baseline: &str, current: &str, host: Option<&RemoteHost>) -> Result<Value, String> {
    if capture["ready"] == true { return Ok(capture["snapshot"].clone()); }
    let snapshot = load_git_diff_between_at_host(cwd, baseline, current, host).map_err(|error| {
        if error.contains("too large") { format!("Permanent diff limit: {error}; comparison retained") }
        else { error }
    })?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) fn capture(session_path: &str, id: &str, cwd: &str, baseline: &str, current: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let storage = Storage { path: session_path, host, ephemeral_id: None };
    capture_at(&storage, id, cwd, baseline, current).map(|_| ())
}

pub(crate) fn capture_ephemeral(session_path: &str, session_id: &str, id: &str, cwd: &str, baseline: &str, current: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let storage = Storage { path: session_path, host, ephemeral_id: Some(session_id) };
    storage.request(json!({"action":"ephemeral_validate"}))?;
    capture_at(&storage, id, cwd, baseline, current).map(|_| ())
}

fn capture_at(storage: &Storage<'_>, id: &str, cwd: &str, baseline: &str, current: &str) -> Result<Value, String> {
    let capture = json!({"cwd":cwd,"baseline":baseline,"current":current,"ready":false});
    let pointer = storage.request(json!({"action":"retain","id":id,"capture":capture}));
    storage.request(json!({"action":"pending","id":id,"capture":capture})).map_err(|error| {
        let recovery = match &pointer { Ok(_) => "Pending comparison saved in the database".to_owned(), Err(pointer) => format!("Recovery pointer also failed: {pointer}") };
        format!("{error}; {recovery}; comparison snapshots preserved: baseline={baseline}, current={current}")
    })?;
    let state = storage.request(json!({"action":"pending_status","id":id}))?;
    if let Some(capture) = state.get("capture").filter(|capture| !capture.is_null()) { return finish(storage, id, capture.clone()); }
    let _ = discard_git_tree_at_host(baseline, storage.host);
    let _ = discard_git_tree_at_host(current, storage.host);
    Ok(Value::Null)
}

#[cfg(test)]
pub(super) fn load(session_path: &str, host: Option<&RemoteHost>) -> Result<GitDiffSnapshots, String> {
    let mut snapshots = GitDiffSnapshots::new(); let mut cursor = String::new();
    let mut fragment = None;
    loop {
        let result = page(session_path, &cursor, host)?;
        super::merge_diff_page(&mut snapshots, &mut fragment, &result)?;
        let Some(next) = result["next"].as_str() else { break; };
        cursor = next.to_owned();
    }
    if fragment.is_some() { return Err("Diff history ended with an incomplete snapshot; preserved".into()); }
    Ok(snapshots)
}

pub(super) fn page(session_path: &str, cursor: &str, host: Option<&RemoteHost>) -> Result<Value, String> {
    if cursor.is_empty() { recover(session_path, host, None)?; }
    storage_request(session_path, &json!({"action":"page","cursor":cursor}), host)
}

pub(super) fn recover(session_path: &str, host: Option<&RemoteHost>, ephemeral_id: Option<&str>) -> Result<(), String> {
    let storage = Storage { path: session_path, host, ephemeral_id };
    let mut errors = discover(&storage)?;
    let state = storage.request(json!({"action":"pending_ids"}))?;
    if let Some(ids) = state["ids"].as_array() {
        for id in ids {
            let id = id.as_str().ok_or("Invalid pending diff message ID")?;
            let capture = storage.request(json!({"action":"pending_status","id":id}))?;
            if capture["capture"].is_null() { continue; }
            if let Err(error) = finish(&storage, id, capture["capture"].clone()) { errors.push(format!("Message {id}, preserved for retry: {error}")); }
        }
    }
    report_recovery_errors(&storage, errors)
}

fn report_recovery_errors(storage: &Storage<'_>, errors: Vec<String>) -> Result<(), String> {
    if errors.is_empty() { return Ok(()); }
    let message = format!("Pending project changes for {}, preserved: {}", storage.path, errors.join("; "));
    if storage.ephemeral_id.is_some() { return Err(message); }
    eprintln!("{message}");
    Ok(())
}

fn discover(storage: &Storage<'_>) -> Result<Vec<String>, String> {
    let pointers = storage.request(json!({"action":"discover"}))?;
    let mut errors = Vec::new();
    if let Some(pointers) = pointers.as_array() {
        for pointer in pointers {
            if let Err(error) = import_pointer(storage, pointer) { errors.push(format!("Pending diff pointer preserved: {error}")); }
        }
    }
    Ok(errors)
}

fn import_pointer(storage: &Storage<'_>, pointer: &Value) -> Result<(), String> {
    let id = pointer["id"].as_str().ok_or("Pending diff pointer has no message ID")?;
    let state = storage.request(json!({"action":"pending_status","id":id}))?;
    if state["completed"] == true && state["capture"].is_null() {
        let baseline = pointer["capture"]["baseline"].as_str().ok_or("Pending diff pointer has no baseline")?;
        let current = pointer["capture"]["current"].as_str().ok_or("Pending diff pointer has no final snapshot")?;
        let _ = discard_git_tree_at_host(baseline, storage.host);
        let _ = discard_git_tree_at_host(current, storage.host);
        return Ok(());
    }
    storage.request(json!({"action":"pending","id":id,"capture":pointer["capture"]}))?;
    Ok(())
}
