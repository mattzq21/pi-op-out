use serde_json::{Value, json};
use crate::RemoteHost;
#[cfg(test)]
use crate::GitDiffSnapshots;
use super::{discard_git_tree_at_host, load_git_diff_between_at_host, storage_request};

fn finish(session_path: &str, id: &str, capture: Value, host: Option<&RemoteHost>) -> Result<(), String> {
    if capture["failure"]["kind"] == "permanent" { return Err(format!("{}; pending comparison preserved", capture["failure"]["message"].as_str().unwrap_or("Permanent diff limit"))); }
    let result = finish_inner(session_path, id, capture, host);
    if let Err(error) = &result {
        let _ = retain_failure(session_path, id, error, host);
    }
    result
}

fn retain_failure(session_path: &str, id: &str, error: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let state = storage_request(session_path, &json!({"action":"pending_status","id":id}), host)?;
    if let Some(capture) = state.get("capture").filter(|capture| !capture.is_null()) {
        let mut capture = capture.clone();
        let kind = if error.starts_with("Permanent diff limit:") { "permanent" } else { "transient" };
        capture["failure"] = json!({"kind":kind,"message":error});
        storage_request(session_path, &json!({"action":"pending","id":id,"capture":capture}), host)?;
    }
    Ok(())
}

fn finish_inner(session_path: &str, id: &str, capture: Value, host: Option<&RemoteHost>) -> Result<(), String> {
    if capture["source"] == "copy" {
        commit(session_path, id, &capture, host)?;
        return Ok(());
    }
    let cwd = capture["cwd"].as_str().ok_or("Pending diff has no project directory")?.to_owned();
    let baseline = capture["baseline"].as_str().ok_or("Pending diff has no baseline")?.to_owned();
    let current = capture["current"].as_str().ok_or("Pending diff has no final snapshot")?.to_owned();
    let capture = ready_capture(session_path, id, capture, &cwd, &baseline, &current, host)?;
    commit(session_path, id, &capture, host)?;
    let _ = discard_git_tree_at_host(&baseline, host);
    let _ = discard_git_tree_at_host(&current, host);
    Ok(())
}

fn commit(session_path: &str, id: &str, capture: &Value, host: Option<&RemoteHost>) -> Result<(), String> {
    let result = storage_request(session_path, &json!({"action":"finish","id":id,"capture":capture,"snapshot":capture["snapshot"]}), host)?;
    if result["finished"] != true { return Err("Pending comparison changed during commit; snapshots preserved for retry".into()); }
    Ok(())
}

fn ready_capture(session_path: &str, id: &str, mut capture: Value, cwd: &str, baseline: &str, current: &str, host: Option<&RemoteHost>) -> Result<Value, String> {
    if capture["ready"] != true {
        let snapshot = load_git_diff_between_at_host(cwd, baseline, current, host).map_err(|error| {
            if error.contains("too large") { format!("Permanent diff limit: {error}; comparison retained") }
            else { error }
        })?;
        capture["snapshot"] = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
        capture["ready"] = Value::Bool(true);
        storage_request(session_path, &json!({"action":"pending","id":id,"capture":capture}), host)?;
    }
    Ok(capture)
}

pub(crate) fn capture(session_path: &str, id: &str, cwd: &str, baseline: &str, current: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let capture = json!({"cwd":cwd,"baseline":baseline,"current":current,"ready":false});
    let pointer = storage_request(session_path, &json!({"action":"retain","id":id,"capture":capture}), host);
    storage_request(session_path, &json!({"action":"pending","id":id,"capture":capture}), host).map_err(|error| {
        let recovery = match &pointer { Ok(_) => "Durable pending-diff.json recovery pointer saved".to_owned(), Err(pointer) => format!("Recovery pointer also failed: {pointer}") };
        format!("{error}; {recovery}; comparison snapshots preserved: baseline={baseline}, current={current}")
    })?;
    let state = storage_request(session_path, &json!({"action":"pending_status","id":id}), host)?;
    if let Some(capture) = state.get("capture").filter(|capture| !capture.is_null()) { return finish(session_path, id, capture.clone(), host); }
    let _ = discard_git_tree_at_host(baseline, host);
    let _ = discard_git_tree_at_host(current, host);
    Ok(())
}

#[cfg(test)]
pub(super) fn load(session_path: &str, host: Option<&RemoteHost>) -> Result<GitDiffSnapshots, String> {
    let mut snapshots = GitDiffSnapshots::new(); let mut cursor = String::new();
    loop {
        let result = page(session_path, &cursor, host)?;
        snapshots.extend(serde_json::from_value::<GitDiffSnapshots>(result["snapshots"].clone()).map_err(|error| error.to_string())?);
        let Some(next) = result["next"].as_str() else { break; };
        cursor = next.to_owned();
    }
    Ok(snapshots)
}

pub(super) fn page(session_path: &str, cursor: &str, host: Option<&RemoteHost>) -> Result<Value, String> {
    if cursor.is_empty() { recover(session_path, host)?; }
    storage_request(session_path, &json!({"action":"page","cursor":cursor}), host)
}

fn recover(session_path: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    discover(session_path, host)?;
    let state = storage_request(session_path, &json!({"action":"pending_ids"}), host)?;
    if let Some(ids) = state["ids"].as_array() {
        for id in ids {
            let id = id.as_str().ok_or("Invalid pending diff message ID")?;
            let capture = storage_request(session_path, &json!({"action":"pending_status","id":id}), host)?;
            if capture["capture"].is_null() { continue; }
            if let Err(error) = finish(session_path, id, capture["capture"].clone(), host) {
                eprintln!("Pending project changes for {session_path}, message {id}, preserved for retry: {error}");
            }
        }
    }
    Ok(())
}

fn discover(session_path: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let pointers = storage_request(session_path, &json!({"action":"discover"}), host)?;
    if let Some(pointers) = pointers.as_array() {
        for pointer in pointers {
            if let Err(error) = import_pointer(session_path, pointer, host) { eprintln!("Pending diff pointer for {session_path} preserved: {error}"); }
        }
    }
    Ok(())
}

fn import_pointer(session_path: &str, pointer: &Value, host: Option<&RemoteHost>) -> Result<(), String> {
    let id = pointer["id"].as_str().ok_or("Pending diff pointer has no message ID")?;
    let state = storage_request(session_path, &json!({"action":"pending_status","id":id}), host)?;
    if state["completed"] == true && state["capture"].is_null() {
        let baseline = pointer["capture"]["baseline"].as_str().ok_or("Pending diff pointer has no baseline")?;
        let current = pointer["capture"]["current"].as_str().ok_or("Pending diff pointer has no final snapshot")?;
        let _ = discard_git_tree_at_host(baseline, host);
        let _ = discard_git_tree_at_host(current, host);
        return Ok(());
    }
    storage_request(session_path, &json!({"action":"pending","id":id,"capture":pointer["capture"]}), host)?;
    Ok(())
}
