use super::*;
use std::time::SystemTime;

const RETAINED_BYTES: usize = 4 * 1024 * 1024;
const EXITED_LIMIT: usize = 64;

pub(crate) struct Transcript {
    session_id: String,
    host_id: String,
    owner: String,
    cwd: String,
    generation: Uuid,
    creation_order: u64,
    output: String,
    end: u64,
    text_end: u64,
    updated: SystemTime,
    pub(crate) running: bool,
}

impl Transcript {
    pub(crate) fn append(&mut self, data: &str) {
        self.output.push_str(data);
        self.end += data.len() as u64;
        self.text_end += data.encode_utf16().count() as u64;
        self.updated = SystemTime::now();
        let mut discard = self.output.len().saturating_sub(RETAINED_BYTES);
        while !self.output.is_char_boundary(discard) { discard += 1; }
        self.output.drain(..discard);
    }

    fn summary(&self, id: &str) -> Value {
        json!({"terminalId":id,"generation":self.generation.to_string(),"initialCwd":self.cwd,
            "running":self.running,"updatedAt":self.updated.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis(),
            "availableFrom":self.end - self.output.len() as u64,"endOffset":self.end})
    }
}

pub(super) fn owned_by(item: &Transcript, owner: &str) -> bool { item.owner == owner }

pub(crate) fn start(runtime: &TerminalRuntime, id: &str, session_key: &str, cwd: &str, host_id: &str, owner: &str, generation: Uuid) -> Result<(), String> {
    let mut history = runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?;
    let session_id = session_key.rsplit_once(':').map_or(session_key, |(_, id)| id);
    let creation_order = match history.get(id) {
        Some(item) => item.creation_order,
        None => history.values().map(|item| item.creation_order).max().unwrap_or(0).checked_add(1).ok_or("Terminal creation order exhausted")?,
    };
    history.insert(id.into(), Transcript { session_id: session_id.into(), host_id: host_id.into(), owner: owner.into(), cwd: cwd.into(), generation, creation_order,
        output: String::new(), end: 0, text_end: 0, updated: SystemTime::now(), running: true });
    Ok(())
}

pub(crate) fn record(history: &Mutex<HashMap<String, Transcript>>, id: &str, data: &str) {
    if let Ok(mut history) = history.lock() {
        if let Some(item) = history.get_mut(id) { item.append(data); }
    }
}

pub(super) fn event(history: &Mutex<HashMap<String, Transcript>>, id: &str, mut packet: Value) -> Value {
    if let Ok(history) = history.lock() {
        if let Some(item) = history.get(id) {
            packet["sessionId"] = json!(item.session_id);
            packet["hostId"] = json!(item.host_id);
            packet["generation"] = json!(item.generation.to_string());
            packet["outputEnd"] = json!(item.text_end);
        }
    }
    packet
}

fn changed(app: &AppHandle, session_id: &str) {
    let _ = app.emit("pi://event", json!({"type":"terminal_changed","sessionId":session_id,"hostId":"local"}));
}

pub(crate) fn finish(history: &Mutex<HashMap<String, Transcript>>, id: &str) {
    if let Ok(mut history) = history.lock() {
        if let Some(item) = history.get_mut(id) { item.running = false; }
        let mut exited: Vec<_> = history.iter().filter(|(_, item)| !item.running).map(|(id, item)| (id.clone(), item.updated)).collect();
        exited.sort_by_key(|(_, updated)| *updated);
        let discard = exited.len().saturating_sub(EXITED_LIMIT);
        for (id, _) in exited.into_iter().take(discard) { history.remove(&id); }
    }
}

pub(crate) fn reassign(runtime: &TerminalRuntime, owner: &str, id: &str, session_key: &str) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let mut history = runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?;
    let item = history.get_mut(id).ok_or("Terminal history is unavailable")?;
    if item.owner != owner { return Err("Terminal belongs to another connection".into()); }
    item.session_id = session_key.rsplit_once(':').map_or(session_key, |(_, id)| id).into();
    if let Some(process) = processes.get_mut(id) { process.session_key = session_key.into(); }
    Ok(())
}

pub(crate) fn detach(runtime: &TerminalRuntime, owner: &str) {
    if let Ok(mut history) = runtime.history.lock() { history.retain(|_, item| item.owner != owner); }
}

pub(crate) fn session_terminals(runtime: &TerminalRuntime, host_id: &str, session_ids: &[String]) -> Result<Vec<String>, String> {
    let history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    Ok(history.iter().filter(|(_, item)| item.host_id == host_id && session_ids.contains(&item.session_id)).map(|(id, _)| id.clone()).collect())
}

pub(crate) fn discard_drafts(runtime: &TerminalRuntime, owner_prefix: &str) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
    let mut history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    let ids: Vec<_> = history.iter().filter(|(_, item)| item.session_id.starts_with("draft-") && item.owner.starts_with(owner_prefix)).map(|(id, _)| id.clone()).collect();
    let mut removed = Vec::new();
    for id in ids {
        history.remove(&id);
        if let Some(process) = processes.remove(&id) { removed.push(process); }
    }
    drop(history);
    drop(processes);
    for mut process in removed { let _ = process.child.kill(); let _ = process.child.wait(); }
    Ok(())
}

pub(crate) fn shared(app: &AppHandle, connection: &str, request: &Value) -> Result<Value, String> {
    let runtime = app.state::<TerminalRuntime>();
    let action = request["action"].as_str().ok_or("Missing terminal action")?;
    let source = request["terminalConnectionId"].as_str().unwrap_or_default();
    let owner_prefix = format!("shared:{connection}:{source}:");
    if action == "discard_drafts" {
        discard_drafts(&runtime, &owner_prefix)?;
        return Ok(Value::Null);
    }
    let owner = format!("{owner_prefix}{}", request["terminalClientId"].as_str().ok_or("Missing terminal client")?);
    let session_key = request["sessionKey"].as_str().unwrap_or_default();
    let session_id = session_key.rsplit_once(':').map_or(session_key, |(_, id)| id);
    if action == "list" {
        let history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
        let mut entries: Vec<_> = history.iter().filter(|(_, item)| item.session_id == session_id && item.host_id == "local").collect();
        entries.sort_by_key(|(_, item)| item.creation_order);
        return Ok(json!(entries.into_iter().map(|(id, item)| {
            let known = &request["known"][id];
            let unchanged = known["generation"].as_str() == Some(item.generation.to_string().as_str()) && known["outputEnd"].as_u64() == Some(item.text_end);
            json!({"id":id,"output":if unchanged { Value::Null } else { json!(item.output) },"outputEnd":item.text_end,
                "generation":item.generation.to_string(),"owned":item.owner == owner,"started":true,"exited":!item.running})
        }).collect::<Vec<_>>()));
    }
    let id = request["sharedTerminalId"].as_str().ok_or("Missing terminal ID")?;
    if action == "start" {
        runtime.ensure_owner(id, &owner)?;
        start_terminal_for_owner(app.clone(), owner, runtime, StartTerminalOptions {
            terminal_id: id.into(), session_key: format!("local:{session_id}"), cwd: request["cwd"].as_str().ok_or("Missing working directory")?.into(),
            cols: dimension(request, "cols")?, rows: dimension(request, "rows")?, host_id: Some("local".into()),
        })?;
        changed(app, session_id);
        return Ok(Value::Null);
    }
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
    let mut history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    if action == "close" && !history.contains_key(id) && !processes.contains_key(id) {
        return Ok(Value::Null);
    }
    let item = history.get_mut(id).ok_or("Terminal is unavailable")?;
    let previous_session = item.session_id.clone();
    if action == "claim" {
        item.owner = owner.clone();
        if let Some(process) = processes.get_mut(id) { process.window_label = owner; }
        drop(history);
        drop(processes);
        changed(app, &previous_session);
        return Ok(Value::Null);
    }
    if item.owner != owner { return Err("Click the terminal to take ownership".into()); }
    match action {
        "write" => {
            let data = request["data"].as_str().ok_or("Missing terminal input")?;
            if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB".into()); }
            processes.get(id).ok_or("Terminal is not running")?.writer.try_send(data.into()).map_err(|_| "Terminal input is busy".to_string())?;
        }
        "resize" => {
            processes.get(id).ok_or("Terminal is not running")?.master.resize(PtySize { cols: dimension(request, "cols")?, rows: dimension(request, "rows")?, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
        }
        "reassign" => {
            item.session_id = session_id.into();
            if let Some(process) = processes.get_mut(id) { process.session_key = format!("local:{session_id}"); }
            drop(history);
            drop(processes);
            changed(app, &previous_session);
            if session_id != previous_session { changed(app, session_id); }
        }
        "close" => {
            let process = processes.remove(id);
            history.remove(id);
            drop(history);
            drop(processes);
            if let Some(mut process) = process { let _ = process.child.kill(); let _ = process.child.wait(); }
            changed(app, &previous_session);
        }
        _ => return Err("Unknown terminal action".into()),
    }
    Ok(Value::Null)
}

fn dimension(request: &Value, key: &str) -> Result<u16, String> {
    request[key].as_u64().and_then(|value| u16::try_from(value).ok()).map(|value| value.max(1)).ok_or_else(|| format!("Invalid {key}"))
}

pub(crate) fn lookup(runtime: &TerminalRuntime, request: &Value, host_id: &str) -> Result<Value, String> {
    let session_id = request["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or("sessionId is required")?;
    let history = runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?;
    let belongs = |item: &&Transcript| item.session_id == session_id && item.host_id == host_id;
    let Some(id) = request["terminalId"].as_str() else {
        let mut terminals: Vec<_> = history.iter().filter(|(_, item)| belongs(item)).collect();
        terminals.sort_by_key(|(_, item)| item.creation_order);
        return Ok(json!({"terminals":terminals.into_iter().map(|(id, item)| item.summary(id)).collect::<Vec<_>>(),
            "retention":"Up to 4 MiB per terminal; closed terminals are removed, exited history may be evicted. Select terminalId to read output."}));
    };
    let item = history.get(id).filter(belongs).ok_or("Terminal not found in this session; list terminals again")?;
    if request["generation"].as_str().is_some_and(|generation| generation != item.generation.to_string()) {
        return Err("Terminal restarted; list terminals again before reading output".into());
    }
    read_page(item, id, request)
}

fn read_page(item: &Transcript, id: &str, request: &Value) -> Result<Value, String> {
    let limit = match request.get("maxBytes") {
        None => 4096,
        Some(value) => value.as_u64().filter(|limit| (4..=16384).contains(limit)).ok_or("maxBytes must be an integer from 4 to 16384")? as usize,
    };
    let available = item.end - item.output.len() as u64;
    let requested = match request.get("offset") {
        None => item.end.saturating_sub(limit as u64).max(available),
        Some(value) => value.as_u64().ok_or("offset must be a nonnegative integer")?,
    };
    if requested > item.end { return Err("Offset is beyond terminal output; list terminals again".into()); }
    let mut start = (requested.max(available) - available) as usize;
    while !item.output.is_char_boundary(start) { start += 1; }
    let mut end = (start + limit).min(item.output.len());
    while !item.output.is_char_boundary(end) { end -= 1; }
    let mut result = item.summary(id);
    result["output"] = json!(&item.output[start..end]);
    result["startOffset"] = json!(available + start as u64);
    result["nextOffset"] = json!(available + end as u64);
    result["hasMore"] = json!(end < item.output.len());
    result["truncated"] = json!(requested < available);
    Ok(result)
}
