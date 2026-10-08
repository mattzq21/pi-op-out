use serde_json::{json, Value};
use std::{collections::HashMap, io::{Read, Write}, path::PathBuf, sync::{mpsc, Arc, Mutex}, thread};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;
use crate::{MAX_TERMINALS, PiRuntime};
use crate::platform::{AppHandle, State};
use crate::settings::load_app_settings;
use crate::pi_launch::{remote_host, user_ssh_config};
use crate::worktree_setup::shell_quote;

pub(super) struct TerminalProcess {
    pub(super) generation: Uuid,
    pub(super) session_key: String,
    pub(super) cwd: String,
    pub(super) host_id: String,
    pub(super) window_label: String,
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) child: Box<dyn PtyChild + Send + Sync>,
    pub(super) writer: mpsc::SyncSender<String>,
}

#[derive(Default)]
pub(super) struct TerminalRuntime {
    processes: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    history: Arc<Mutex<HashMap<String, terminal_lookup::Transcript>>>,
}

pub(super) struct TerminalLaunch { pub(super) terminal_id: String, pub(super) session_key: String, pub(super) cwd: String, pub(super) cols: u16, pub(super) rows: u16, pub(super) host_id: String, pub(super) window_label: String }

pub(super) struct StartTerminalOptions { pub(super) terminal_id: String, pub(super) session_key: String, pub(super) cwd: String, pub(super) cols: u16, pub(super) rows: u16, pub(super) host_id: Option<String> }

pub(super) fn start_terminal_for_owner(app: AppHandle, owner: String, runtime: State<TerminalRuntime>, options: StartTerminalOptions) -> Result<(), String> {
    let session_runtime = app.state::<PiRuntime>();
    let _lifecycle = session_runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    launch_terminal_for_owner(&app, owner, &runtime, options)
}

fn launch_terminal_for_owner(app: &AppHandle, owner: String, runtime: &TerminalRuntime, options: StartTerminalOptions) -> Result<(), String> {
    let StartTerminalOptions { terminal_id, session_key, cwd, cols, rows, host_id } = options;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let event_app = app.clone();
    start_terminal_with(runtime, TerminalLaunch { terminal_id, session_key, cwd: cwd.clone(), cols, rows, host_id: host_id.clone(), window_label: owner },
        || if host_id == "local" {
            let working_dir = PathBuf::from(&cwd);
            if !working_dir.is_dir() { return Err(format!("Terminal working directory does not exist: {}", working_dir.display())); }
            let mut command = CommandBuilder::new("/bin/bash"); command.cwd(working_dir); Ok(command)
        } else {
            let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, &host_id)?;
            let mut command = CommandBuilder::new("ssh");
            if let Some(config) = user_ssh_config() { command.arg("-F"); command.arg(config); }
            command.args(["-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", &host.target, &format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))]); Ok(command)
        },
        move |packet| { let _ = event_app.emit("pi://event", packet); })
}

fn spawn_terminal_shell(slave: &dyn portable_pty::SlavePty, command: impl FnOnce() -> Result<CommandBuilder, String>) -> Result<Box<dyn PtyChild + Send + Sync>, String> {
    let mut command = command()?;
    command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    slave.spawn_command(command).map_err(|error| format!("Could not start terminal shell: {error}"))
}

fn terminal_already_running(runtime: &TerminalRuntime, processes: &HashMap<String, TerminalProcess>, terminal_id: &str, owner: &str) -> Result<bool, String> {
    if runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?.get(terminal_id).is_some_and(|item| !terminal_lookup::owned_by(item, owner)) {
        return Err("Terminal belongs to another connection".into());
    }
    if let Some(process) = processes.get(terminal_id) {
        return if process.window_label == owner { Ok(true) } else { Err("Terminal belongs to another connection".into()) };
    }
    Ok(false)
}

pub(super) fn start_terminal_with(runtime: &TerminalRuntime, launch: TerminalLaunch,
    command: impl FnOnce() -> Result<CommandBuilder, String>, mut emit: impl FnMut(Value) + Send + 'static) -> Result<(), String> {
    let TerminalLaunch { terminal_id, session_key, cwd, cols, rows, host_id, window_label } = launch;
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if terminal_already_running(runtime, &processes, &terminal_id, &window_label)? { return Ok(()); }
    if processes.values().filter(|process| process.session_key == session_key).count() >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals may run for one conversation")); }
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let child = spawn_terminal_shell(pair.slave.as_ref(), command)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let event_id = terminal_id.clone(); let terminal_processes = runtime.processes.clone();
    let generation = Uuid::new_v4();
    let terminal_history = runtime.history.clone();
    terminal_lookup::start(runtime, &terminal_id, &session_key, &cwd, &host_id, &window_label, generation)?;
    let size = format!("\u{1b}[8;{};{}t", rows.max(1), cols.max(1));
    terminal_lookup::record(&terminal_history, &terminal_id, &size);
    emit(terminal_lookup::event(&terminal_history, &terminal_id, json!({ "type": "terminal_output", "terminalId": terminal_id, "data": size })));
    thread::spawn(move || {
        stream_terminal_output(&mut reader, &event_id, |packet| {
            if let Ok(values) = terminal_processes.lock() {
                if values.get(&event_id).is_some_and(|process| process.generation == generation) {
                    terminal_lookup::record(&terminal_history, &event_id, packet["data"].as_str().unwrap_or_default());
                    emit(terminal_lookup::event(&terminal_history, &event_id, packet));
                }
            }
        });
        let finished = terminal_processes.lock().ok().and_then(|mut values| {
            if !values.get(&event_id).is_some_and(|process| process.generation == generation) { return None; }
            let process = values.remove(&event_id);
            let packet = terminal_lookup::event(&terminal_history, &event_id, json!({ "type": "terminal_exit", "terminalId": event_id }));
            terminal_lookup::finish(&terminal_history, &event_id);
            emit(packet);
            process
        });
        if let Some(mut process) = finished { let _ = process.child.wait(); }
    });
    let (input, queued) = mpsc::sync_channel::<String>(32);
    thread::spawn(move || write_terminal_queue(&mut writer, queued));
    processes.insert(terminal_id, TerminalProcess { generation, session_key, cwd, host_id, window_label, master: pair.master, child, writer: input });
    Ok(())
}

pub(super) fn write_terminal_queue(writer: &mut impl Write, queued: mpsc::Receiver<String>) {
    while let Ok(data) = queued.recv() {
        if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() { break; }
    }
}

pub(super) fn stream_terminal_output(reader: &mut impl Read, terminal_id: &str, mut emit: impl FnMut(Value)) {
    let mut buffer = [0_u8; 8192];
    let mut pending_utf8 = Vec::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                let data = decode_terminal_bytes(&mut pending_utf8, &buffer[..length], false);
                if !data.is_empty() { emit(json!({"type":"terminal_output","terminalId":terminal_id,"data":data})); }
            }
            Err(_) => break,
        }
    }
    let tail = decode_terminal_bytes(&mut pending_utf8, &[], true);
    if !tail.is_empty() { emit(json!({"type":"terminal_output","terminalId":terminal_id,"data":tail})); }
}

pub(super) fn decode_terminal_bytes(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => { output.push_str(text); pending.clear(); break; }
            Err(error) => {
                let valid = error.valid_up_to(); let error_length = error.error_len(); const REPLACEMENT: char = '\u{fffd}';
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&pending[..valid]).expect("validated UTF-8 prefix"));
                    pending.drain(..valid);
                }
                match error_length {
                    Some(length) => { pending.drain(..length.min(pending.len())); output.push(REPLACEMENT); }
                    None => break,
                }
            }
        }
    }
    if eof && !pending.is_empty() { output.push_str(&String::from_utf8_lossy(pending)); pending.clear(); }
    output
}
pub(super) fn write_terminal(runtime: State<TerminalRuntime>, terminal_id: String, data: String) -> Result<(), String> {
    write_terminal_input(&runtime, &terminal_id, data)
}

pub(super) fn write_terminal_input(runtime: &TerminalRuntime, terminal_id: &str, data: String) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get_mut(terminal_id).ok_or("Terminal is not running")?;
    if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB; paste a smaller block".into()); }
    process.writer.try_send(data).map_err(|_| "Terminal input is busy; wait or close the terminal".to_string())
}
pub(super) fn resize_terminal(runtime: State<TerminalRuntime>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize_terminal_pty(&runtime, &terminal_id, cols, rows)
}

pub(super) fn resize_terminal_pty(runtime: &TerminalRuntime, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get(terminal_id).ok_or("Terminal is not running")?;
    process.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())
}
pub(super) fn close_terminal(runtime: State<TerminalRuntime>, terminal_id: String) -> Result<(), String> {
    stop_terminals(&runtime, &[terminal_id])
}

pub(super) fn stop_terminals(runtime: &TerminalRuntime, terminal_ids: &[String]) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let mut history = runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?;
    for id in terminal_ids {
        if let Some(process) = processes.get_mut(id) { stop_terminal_process(process).map_err(|error| format!("Could not close terminal {id}: {error}"))?; }
        processes.remove(id);
        history.remove(id);
    }
    Ok(())
}

fn stop_terminal_process(process: &mut TerminalProcess) -> Result<(), String> {
    if process.child.try_wait().map_err(|error| error.to_string())?.is_none() {
        process.child.kill().map_err(|error| error.to_string())?;
    }
    process.child.wait().map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn detach_owner(runtime: &TerminalRuntime, owner: &str) {
    let _ = terminal_lookup::discard_drafts(runtime, &format!("shared:{owner}:"));
    let ids = runtime.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(runtime, &ids);
    terminal_lookup::detach(runtime, owner);
}

pub(super) fn shutdown(runtime: &TerminalRuntime) {
    let ids = runtime.processes.lock().map(|processes| processes.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(runtime, &ids);
}

#[path = "../terminal_lookup.rs"]
pub(crate) mod terminal_lookup;

impl TerminalRuntime {
    pub(super) fn running_count(&self) -> Result<usize, String> {
        Ok(self.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.len())
    }
    pub(super) fn ensure_owner(&self, id: &str, owner: &str) -> Result<(), String> {
        if self.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.get(id).is_some_and(|process| process.window_label != owner) { return Err("Terminal belongs to another connection".into()); }
        Ok(())
    }
    pub(super) fn contains_process(&self, id: &str) -> Result<bool, String> {
        Ok(self.processes.lock().map_err(|_| "Terminal registry unavailable")?.contains_key(id))
    }
    pub(super) fn working_directories(&self, host_id: &str) -> Result<Vec<String>, String> {
        Ok(self.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.values().filter(|terminal| terminal.host_id == host_id).map(|terminal| terminal.cwd.clone()).collect())
    }
    #[cfg(test)]
    pub(super) fn test_processes(&self) -> &Mutex<HashMap<String, TerminalProcess>> { &self.processes }
}
