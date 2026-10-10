use super::*;
use crate::{daemon, BrokerRuntime};
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
    input_draft: String,
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
        output: String::new(), input_draft: String::new(), end: 0, text_end: 0, updated: SystemTime::now(), running: true });
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
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
    let history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    let mut ids: Vec<_> = history.iter().filter(|(_, item)| item.host_id == host_id && session_ids.contains(&item.session_id)).map(|(id, _)| id.clone()).collect();
    ids.extend(processes.iter().filter(|(_, process)| {
        let session_id = process.session_key.rsplit_once(':').map_or(process.session_key.as_str(), |(_, id)| id);
        process.host_id == host_id && session_ids.iter().any(|id| id == session_id)
    }).map(|(id, _)| id.clone()));
    ids.sort();
    ids.dedup();
    Ok(ids)
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

fn session_owned(app: &AppHandle, session_id: &str, client: &str, draft_owned: bool, allow_released: bool) -> Result<bool, String> {
    if session_id.starts_with("draft-") { return Ok(draft_owned); }
    let settings = load_app_settings(app.clone())?;
    let daemon = daemon::connect(app, &app.state::<PiRuntime>(), &app.state::<BrokerRuntime>(), &settings, "local")?;
    Ok(daemon.request(json!({"type":"conversation_owner","sessionId":session_id,"clientId":client,"allowReleased":allow_released}))?.as_bool() == Some(true))
}

struct SharedTerminalRequest<'a> {
    app: &'a AppHandle,
    runtime: &'a TerminalRuntime,
    request: &'a Value,
    owner: String,
    client: &'a str,
    session_id: &'a str,
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
    let client = request["clientId"].as_str().ok_or("Missing session client")?;
    let session_key = request["sessionKey"].as_str().unwrap_or_default();
    let session_id = session_key.rsplit_once(':').map_or(session_key, |(_, id)| id);
    let context = SharedTerminalRequest { app, runtime: &runtime, request, owner: format!("{owner_prefix}{client}"), client, session_id };
    if action == "list" { return shared_list(&context); }
    let id = request["sharedTerminalId"].as_str().ok_or("Missing terminal ID")?;
    if action == "start" { return shared_start(&context, id); }
    shared_update(&context, id, action)
}

fn shared_list(context: &SharedTerminalRequest<'_>) -> Result<Value, String> {
    let owned = session_owned(context.app, context.session_id, context.client, true, false)?;
    shared_entries(context.runtime, context.session_id, &context.owner, context.request, owned)
}

fn shared_entries(runtime: &TerminalRuntime, session_id: &str, owner: &str, request: &Value, owned: bool) -> Result<Value, String> {
    adopt_listed_terminals(runtime, session_id, owner, owned)?;
    let history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    let mut entries: Vec<_> = history.iter().filter(|(_, item)| item.session_id == session_id && item.host_id == "local").collect();
    entries.sort_by_key(|(_, item)| item.creation_order);
    Ok(json!(entries.into_iter().map(|(id, item)| {
        let known = &request["known"][id];
        let unchanged = known["generation"].as_str() == Some(item.generation.to_string().as_str()) && known["outputEnd"].as_u64() == Some(item.text_end);
        json!({"id":id,"output":if unchanged { Value::Null } else { json!(item.output) },"outputEnd":item.text_end,"inputDraft":item.input_draft,
            "generation":item.generation.to_string(),"owned":owned && (!session_id.starts_with("draft-") || item.owner == owner),"started":true,"exited":!item.running})
    }).collect::<Vec<_>>()))
}

fn adopt_listed_terminals(runtime: &TerminalRuntime, session_id: &str, owner: &str, owned: bool) -> Result<(), String> {
    if !owned || session_id.starts_with("draft-") { return Ok(()); }
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
    let mut history = runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    for (id, item) in history.iter_mut().filter(|(_, item)| item.session_id == session_id && item.host_id == "local") {
        item.owner = owner.into();
        if let Some(process) = processes.get_mut(id) { process.window_label = owner.into(); }
    }
    Ok(())
}

fn shared_start(context: &SharedTerminalRequest<'_>, id: &str) -> Result<Value, String> {
    let session_runtime = context.app.state::<PiRuntime>();
    let _lifecycle = session_runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    if !session_owned(context.app, context.session_id, context.client, true, false)? { return Err("Take ownership of this session before changing its terminals".into()); }
    adopt_shared_terminal(context, id)?;
    super::launch_terminal_for_owner(context.app, context.owner.clone(), context.runtime, StartTerminalOptions {
        terminal_id: id.into(), session_key: format!("local:{}", context.session_id), cwd: context.request["cwd"].as_str().ok_or("Missing working directory")?.into(),
        cols: dimension(context.request, "cols")?, rows: dimension(context.request, "rows")?, host_id: Some("local".into()),
    })?;
    changed(context.app, context.session_id);
    Ok(Value::Null)
}

fn adopt_shared_terminal(context: &SharedTerminalRequest<'_>, id: &str) -> Result<(), String> {
        let mut processes = context.runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
        let mut history = context.runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
        if history.get(id).is_some_and(|item| item.session_id != context.session_id) { return Err("Terminal belongs to another session".into()); }
        if let Some(item) = history.get_mut(id) { item.owner = context.owner.clone(); }
        if let Some(process) = processes.get_mut(id) { process.window_label = context.owner.clone(); }
    Ok(())
}

fn shared_access(context: &SharedTerminalRequest<'_>, item: &Transcript, action: &str) -> Result<(), String> {
    let same_owner = item.owner == context.owner;
    if action == "close" && same_owner { return Ok(()); }
    let allow_released = action == "reassign" && same_owner;
    if !session_owned(context.app, &item.session_id, context.client, same_owner, allow_released)? {
        return Err("Take ownership of this session before changing its terminals".into());
    }
    if action == "reassign" && !session_owned(context.app, context.session_id, context.client, true, false)? {
        return Err("Take ownership of the destination session first".into());
    }
    Ok(())
}

fn missing_closed_terminal(action: &str, id: &str, history: &HashMap<String, Transcript>, processes: &HashMap<String, TerminalProcess>) -> bool {
    action == "close" && !history.contains_key(id) && !processes.contains_key(id)
}

fn shared_update(context: &SharedTerminalRequest<'_>, id: &str, action: &str) -> Result<Value, String> {
    let session_runtime = context.app.state::<PiRuntime>();
    let _lifecycle = if action == "reassign" { Some(session_runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?) } else { None };
    update_shared_terminal(context, id, action)
}

fn update_shared_terminal(context: &SharedTerminalRequest<'_>, id: &str, action: &str) -> Result<Value, String> {
    let mut processes = context.runtime.processes.lock().map_err(|_| "Terminal runtime unavailable")?;
    let mut history = context.runtime.history.lock().map_err(|_| "Terminal history unavailable")?;
    if missing_closed_terminal(action, id, &history, &processes) { return Ok(Value::Null); }
    let item = history.get_mut(id).ok_or("Terminal is unavailable")?;
    let previous_session = item.session_id.clone();
    shared_access(context, item, action)?;
    match action {
        "reassign" => { reassign_shared(item, &mut processes, id, context.session_id); Ok(()) },
        "close" => close_shared_terminal(id, &mut history, &mut processes),
        _ => shared_running_action(context, id, action, item, &processes),
    }?;
    drop(history);
    drop(processes);
    finish_shared_update(context, action, &previous_session);
    Ok(Value::Null)
}

fn close_shared_terminal(id: &str, history: &mut HashMap<String, Transcript>, processes: &mut HashMap<String, TerminalProcess>) -> Result<(), String> {
    if let Some(process) = processes.get_mut(id) { super::stop_terminal_process(process).map_err(|error| format!("Could not close terminal {id}: {error}"))?; }
    processes.remove(id);
    history.remove(id);
    Ok(())
}

fn reassign_shared(item: &mut Transcript, processes: &mut HashMap<String, TerminalProcess>, id: &str, session_id: &str) {
    item.session_id = session_id.into();
    if let Some(process) = processes.get_mut(id) { process.session_key = format!("local:{session_id}"); }
}

fn finish_shared_update(context: &SharedTerminalRequest<'_>, action: &str, previous_session: &str) {
    if action == "close" || action == "reassign" { changed(context.app, previous_session); }
    if action == "reassign" && context.session_id != previous_session { changed(context.app, context.session_id); }
}

fn shared_running_action(context: &SharedTerminalRequest<'_>, id: &str, action: &str, item: &mut Transcript, processes: &HashMap<String, TerminalProcess>) -> Result<(), String> {
    match action {
        "draft" => {
            let data = context.request["data"].as_str().ok_or("Missing terminal draft")?;
            if data.len() > 1024 * 1024 { return Err("Terminal draft exceeds 1 MiB".into()); }
            item.input_draft = data.into();
            emit_shared_draft(context.app, item, id, data);
        }
        "write" | "write_with_draft" | "adopt_draft" => shared_write(context, id, action, item, processes)?,
        "resize" => shared_resize(context, id, item, processes)?,
        _ => return Err("Unknown terminal action".into()),
    }
    Ok(())
}

fn emit_shared_draft(app: &AppHandle, item: &Transcript, id: &str, data: &str) {
    let _ = app.emit("pi://event", json!({"type":"terminal_draft","terminalId":id,
        "sessionId":item.session_id,"hostId":item.host_id,"generation":item.generation.to_string(),"data":data}));
}

fn shared_write(context: &SharedTerminalRequest<'_>, id: &str, action: &str, item: &mut Transcript, processes: &HashMap<String, TerminalProcess>) -> Result<(), String> {
    let data = context.request["data"].as_str().ok_or("Missing terminal input")?;
    if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB".into()); }
    let draft = if action == "write" { "" } else { item.input_draft.as_str() };
    processes.get(id).ok_or("Terminal is not running")?.writer.try_send(format!("{draft}{data}")).map_err(|_| "Terminal input is busy".to_string())?;
    if action != "write" && !item.input_draft.is_empty() {
        item.input_draft.clear();
        emit_shared_draft(context.app, item, id, "");
    }
    Ok(())
}

fn shared_resize(context: &SharedTerminalRequest<'_>, id: &str, item: &mut Transcript, processes: &HashMap<String, TerminalProcess>) -> Result<(), String> {
    let cols = dimension(context.request, "cols")?;
    let rows = dimension(context.request, "rows")?;
    let master = &processes.get(id).ok_or("Terminal is not running")?.master;
    let size = master.get_size().map_err(|error| error.to_string())?;
    if size.cols == cols && size.rows == rows { return Ok(()); }
    master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let data = format!("\u{1b}[8;{rows};{cols}t");
    item.append(&data);
    let _ = context.app.emit("pi://event", json!({"type":"terminal_output","terminalId":id,
        "sessionId":item.session_id,"hostId":item.host_id,"generation":item.generation.to_string(),
        "outputEnd":item.text_end,"data":data}));
    Ok(())
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
