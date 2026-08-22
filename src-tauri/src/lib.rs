use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;
use chrono::{DateTime, Utc};

struct PiProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Default)]
struct PiRuntime {
    process: Mutex<Option<PiProcess>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    path: String,
    name: String,
    project: String,
    cwd: String,
    updated_at: String,
    preview: String,
    message_count: usize,
    starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    theme: String,
    default_model: String,
    default_thinking: String,
    auto_compaction: bool,
    auto_retry: bool,
    notifications: bool,
    #[serde(default = "default_queue_mode")]
    steering_mode: String,
    #[serde(default = "default_queue_mode")]
    follow_up_mode: String,
    #[serde(default = "default_keybindings")]
    keybindings: HashMap<String, String>,
    tools: Vec<Value>,
    skills: Vec<Value>,
    mcp_servers: Vec<Value>,
}

fn default_queue_mode() -> String { "one-at-a-time".into() }

fn default_keybindings() -> HashMap<String, String> {
    [
        ("newConversation", "Ctrl+N"),
        ("toggleConversations", "Ctrl+B"),
        ("toggleTerminal", "Ctrl+J"),
        ("focusComposer", "Ctrl+L"),
        ("openSettings", "Ctrl+,"),
    ].into_iter().map(|(action, shortcut)| (action.into(), shortcut.into())).collect()
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

fn pi_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("PI_DESKTOP_PI_PATH") { return PathBuf::from(path); }
    if let Ok(home) = home_dir() {
        for candidate in [home.join(".local/bin/pi"), home.join(".npm-global/bin/pi"), home.join(".bun/bin/pi")] { if candidate.is_file() { return candidate; } }
    }
    for candidate in ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"] { let path = PathBuf::from(candidate); if path.is_file() { return path; } }
    PathBuf::from("pi")
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("settings.json"))
}

fn prepare_mcp_bridge(app: &AppHandle, settings: &AppSettings) -> Result<(PathBuf, PathBuf), String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let extension_path = dir.join("pi-desktop-mcp-bridge.ts");
    let config_path = dir.join("mcp-servers.json");
    fs::write(&extension_path, include_str!("../resources/mcp-bridge.ts")).map_err(|error| error.to_string())?;
    fs::write(&config_path, serde_json::to_vec_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok((extension_path, config_path))
}

fn default_settings() -> AppSettings {
    AppSettings {
        theme: "system".into(), default_model: String::new(), default_thinking: "high".into(), auto_compaction: true, auto_retry: true, notifications: true, steering_mode: default_queue_mode(), follow_up_mode: default_queue_mode(), keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).collect(),
        skills: vec![], mcp_servers: vec![],
    }
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") { return None; }
    content.lines().skip(1).take_while(|line| line.trim() != "---").find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_string())
    })
}

fn merge_discovered_skills(settings: &mut AppSettings) {
    let mut known: HashSet<String> = settings.skills.iter().filter_map(|skill| skill.get("path").and_then(Value::as_str).map(str::to_owned)).collect();
    let mut roots = Vec::new();
    if let Ok(home) = home_dir() { roots.push((home.join(".pi/agent/skills"), "global")); }
    if let Ok(cwd) = std::env::current_dir() { roots.push((cwd.join(".pi/skills"), "project")); roots.push((cwd.join(".pi/agent/skills"), "project")); }
    for (root, scope) in roots {
        if !root.exists() { continue; }
        for entry in WalkDir::new(root).min_depth(1).max_depth(3).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md") {
            let directory = entry.path().parent().unwrap_or(entry.path()); let path = directory.to_string_lossy().into_owned();
            if !known.insert(path.clone()) { continue; }
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            let fallback = directory.file_name().and_then(|value| value.to_str()).unwrap_or("skill");
            settings.skills.push(json!({ "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()), "path": path, "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()), "enabled": true, "scope": scope }));
        }
    }
}

#[tauri::command]
fn load_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    let mut settings = if !path.exists() { default_settings() } else { serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? };
    for shortcut in settings.keybindings.values_mut() { *shortcut = shortcut.replace("Mod+", "Ctrl+"); }
    merge_discovered_skills(&mut settings); Ok(settings)
}

#[tauri::command]
fn save_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path(&app)?, body).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_pi(app: AppHandle, runtime: State<PiRuntime>, cwd: Option<String>, session_path: Option<String>) -> Result<(), String> {
    let mut process_guard = runtime.process.lock().map_err(|_| "Pi runtime lock was poisoned")?;
    if process_guard.is_some() { return Ok(()); }
    let working_dir = cwd.map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
    let settings = load_app_settings(app.clone()).unwrap_or_else(|_| default_settings());
    let (mcp_extension, mcp_config) = prepare_mcp_bridge(&app, &settings)?;
    let mut command = Command::new(pi_executable());
    command.arg("--mode").arg("rpc").arg("--approve").current_dir(&working_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.arg("--extension").arg(mcp_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config);
    if let Some(path) = session_path { command.arg("--session").arg(path); }
    if !settings.default_model.trim().is_empty() { command.arg("--model").arg(settings.default_model.trim()); }
    if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
    let enabled_tools: Vec<&str> = settings.tools.iter().filter(|tool| tool.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
    if enabled_tools.is_empty() { command.arg("--no-tools"); } else { command.arg("--tools").arg(enabled_tools.join(",")); }
    for skill in settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)) {
        if let Some(path) = skill.get("path").and_then(Value::as_str) { let expanded = path.strip_prefix("~/").and_then(|rest| home_dir().ok().map(|home| home.join(rest))).unwrap_or_else(|| PathBuf::from(path)); command.arg("--skill").arg(expanded); }
    }
    let mut child = command.spawn().map_err(|error| format!("Could not start pi: {error}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("Pi stdin was unavailable")?));
    let stdout = child.stdout.take().ok_or("Pi stdout was unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi stderr was unavailable")?;
    let pending = runtime.pending.clone(); let event_app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n') {
            let Ok(bytes) = line else { break }; let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if value.get("type") == Some(&Value::String("response".into())) {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(id)) {
                        let result = if value.get("success").and_then(Value::as_bool).unwrap_or(false) { Ok(value.get("data").cloned().unwrap_or(Value::Null)) } else { Err(value.get("error").and_then(Value::as_str).unwrap_or("Pi command failed").to_string()) };
                        let _ = sender.send(result); continue;
                    }
                }
            }
            let _ = event_app.emit("pi://event", value);
        }
        let _ = event_app.emit("pi://event", json!({"type": "disconnected"}));
    });
    let error_app = app.clone();
    thread::spawn(move || for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = error_app.emit("pi://stderr", line); });
    *process_guard = Some(PiProcess { child, stdin });
    Ok(())
}

#[tauri::command]
fn stop_pi(runtime: State<PiRuntime>) -> Result<(), String> {
    if let Some(mut process) = runtime.process.lock().map_err(|_| "Pi runtime lock was poisoned")?.take() { let _ = process.child.kill(); let _ = process.child.wait(); }
    Ok(())
}

#[tauri::command]
fn pi_command(runtime: State<PiRuntime>, mut command: Value) -> Result<Value, String> {
    let fire_and_forget = command.get("type").and_then(Value::as_str) == Some("extension_ui_response");
    let id = command.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
    command.as_object_mut().ok_or("RPC command must be an object")?.insert("id".into(), Value::String(id.clone()));
    let (sender, receiver) = mpsc::channel();
    runtime.pending.lock().map_err(|_| "Pending command lock was poisoned")?.insert(id.clone(), sender);
    let write_result = (|| {
        let process_guard = runtime.process.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        let process = process_guard.as_ref().ok_or("Pi is not running")?;
        let mut stdin = process.stdin.lock().map_err(|_| "Pi stdin lock was poisoned")?;
        serde_json::to_writer(&mut *stdin, &command).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
    })();
    if let Err(error) = write_result { runtime.pending.lock().ok().map(|mut map| map.remove(&id)); return Err(error); }
    if fire_and_forget { runtime.pending.lock().ok().map(|mut map| map.remove(&id)); return Ok(Value::Null); }
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| { runtime.pending.lock().ok().map(|mut map| map.remove(&id)); "Pi command timed out".to_string() })?
}

fn text_content(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| if part.get("type") == Some(&Value::String("text".into())) { part.get("text").and_then(Value::as_str) } else { None }).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

fn iso_from_modified(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

fn parse_session(path: &Path) -> Option<SessionSummary> {
    let content = fs::read_to_string(path).ok()?; let mut lines = content.lines(); let header: Value = serde_json::from_str(lines.next()?).ok()?;
    if header.get("type")?.as_str()? != "session" { return None; }
    let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or("Unknown project").to_string();
    let id = header.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut name = String::new(); let mut preview = String::new(); let mut message_count = 0;
    for line in lines { let Ok(entry) = serde_json::from_str::<Value>(line) else { continue }; if entry.get("type").and_then(Value::as_str) == Some("session_info") { if let Some(value) = entry.get("name").and_then(Value::as_str) { name = value.into(); } } if entry.get("type").and_then(Value::as_str) == Some("message") { message_count += 1; if let Some(message) = entry.get("message") { let text = text_content(message); if !text.is_empty() { if name.is_empty() && message.get("role").and_then(Value::as_str) == Some("user") { name = text.chars().take(52).collect(); } preview = text; } } } }
    if name.is_empty() { name = "Untitled session".into(); }
    let project = Path::new(&cwd).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").to_string();
    let modified = fs::metadata(path).and_then(|metadata| metadata.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
    Some(SessionSummary { id, path: path.to_string_lossy().into_owned(), name, project, cwd, updated_at: iso_from_modified(modified), preview: preview.chars().take(100).collect(), message_count, starred: false })
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionSummary>, String> {
    let root = home_dir()?.join(".pi/agent/sessions"); if !root.exists() { return Ok(vec![]); }
    let mut sessions: Vec<_> = WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")).filter_map(|entry| parse_session(entry.path())).collect();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at)); Ok(sessions)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().manage(PiRuntime::default()).invoke_handler(tauri::generate_handler![start_pi, stop_pi, pi_command, list_sessions, load_app_settings, save_app_settings]).run(tauri::generate_context!()).expect("error while running Pi desktop");
}
