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
    time::{Duration, Instant, SystemTime},
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;
use chrono::{DateTime, Utc};

struct PiProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct TerminalProcess {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
struct TerminalRuntime {
    processes: Mutex<HashMap<String, TerminalProcess>>,
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
    cwd_exists: bool,
    updated_at: String,
    preview: String,
    message_count: usize,
    starred: bool,
    host_id: String,
    host_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHost {
    id: String,
    name: String,
    target: String,
    #[serde(default = "default_pi_path")]
    pi_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsage {
    remaining_percent: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
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
    #[serde(default)]
    hosts: Vec<RemoteHost>,
}

fn default_queue_mode() -> String { "one-at-a-time".into() }
fn default_pi_path() -> String { "pi".into() }

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

fn codex_executable() -> PathBuf {
    if let Ok(home) = home_dir() {
        for candidate in [home.join(".local/bin/codex"), home.join(".npm-global/bin/codex"), home.join(".bun/bin/codex")] { if candidate.is_file() { return candidate; } }
    }
    PathBuf::from("codex")
}

fn codex_response(receiver: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let timeout = deadline.checked_duration_since(Instant::now()).ok_or("Codex usage request timed out")?;
        let line = receiver.recv_timeout(timeout).map_err(|_| "Codex usage request timed out".to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if let Some(error) = value.get("error") { return Err(error.to_string()); }
        return value.get("result").cloned().ok_or_else(|| "Codex returned no usage data".into());
    }
}

fn codex_remaining_percent(response: &Value) -> Option<u8> {
    let limits = response.pointer("/rateLimitsByLimitId/codex").or_else(|| response.get("rateLimits"))?;
    let used = ["primary", "secondary"].iter().filter_map(|window| limits.get(window)?.get("usedPercent")?.as_f64()).fold(None, |highest, value| Some(highest.map_or(value, |current: f64| current.max(value))))?;
    Some((100.0 - used.clamp(0.0, 100.0)).round() as u8)
}

#[tauri::command]
fn codex_usage() -> Result<CodexUsage, String> {
    let mut child = Command::new(codex_executable()).arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("Codex stdin was unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout was unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) { if sender.send(line).is_err() { break; } });
        let deadline = Instant::now() + Duration::from_secs(8);
        writeln!(stdin, "{}", json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"pi-desktop","title":"Pi Desktop","version":env!("CARGO_PKG_VERSION")},"capabilities":null}})).map_err(|error| error.to_string())?;
        codex_response(&receiver, 1, deadline)?;
        writeln!(stdin, "{}", json!({"method":"initialized"})).map_err(|error| error.to_string())?;
        writeln!(stdin, "{}", json!({"method":"account/rateLimits/read","id":2})).map_err(|error| error.to_string())?;
        let response = codex_response(&receiver, 2, deadline)?;
        Ok(CodexUsage { remaining_percent: codex_remaining_percent(&response).ok_or("Codex usage is unavailable")? })
    })();
    let _ = child.kill(); let _ = child.wait(); result
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
        default_model: String::new(), default_thinking: "high".into(), auto_compaction: true, auto_retry: true, notifications: true, steering_mode: default_queue_mode(), follow_up_mode: default_queue_mode(), keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).collect(),
        skills: vec![], mcp_servers: vec![], hosts: vec![],
    }
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") { return None; }
    content.lines().skip(1).take_while(|line| line.trim() != "---").find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_string())
    })
}

fn codex_disables_implicit_invocation(skill_directory: &Path) -> bool {
    let Ok(content) = fs::read_to_string(skill_directory.join("agents/openai.yaml")) else { return false };
    let mut policy_indent = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        let indent = line.len().saturating_sub(line.trim_start().len());
        if trimmed == "policy:" { policy_indent = Some(indent); continue; }
        let Some(parent_indent) = policy_indent else { continue };
        if indent <= parent_indent { policy_indent = None; continue; }
        let Some((key, value)) = trimmed.split_once(':') else { continue };
        if key.trim() == "allow_implicit_invocation" {
            return value.split('#').next().unwrap_or("").trim().trim_matches(['\'', '"']).eq_ignore_ascii_case("false");
        }
    }
    false
}

fn skill_path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn expand_skill_path(path: &str, home: &Path) -> PathBuf {
    path.strip_prefix("~/").map(|rest| home.join(rest)).unwrap_or_else(|| PathBuf::from(path))
}

fn discover_skills_in(root: &Path, include_root_markdown: bool) -> Vec<Value> {
    if !root.is_dir() { return Vec::new(); }

    let mut skill_files: Vec<PathBuf> = WalkDir::new(root)
        .min_depth(1)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 { return true; }
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .map(|entry| entry.into_path())
        .collect();
    skill_files.sort_by_key(|path| path.components().count());

    // A directory containing SKILL.md is one skill. Pi does not continue looking
    // for nested skills inside that directory.
    let mut skill_roots: Vec<PathBuf> = Vec::new();
    let mut discovered = Vec::new();
    for skill_file in skill_files {
        let directory = skill_file.parent().unwrap_or(&skill_file);
        if skill_roots.iter().any(|known| directory != known && directory.starts_with(known)) { continue; }
        skill_roots.push(directory.to_path_buf());
        let content = fs::read_to_string(&skill_file).unwrap_or_default();
        let fallback = directory.file_name().and_then(|value| value.to_str()).unwrap_or("skill");
        let claude_user_only = frontmatter_value(&content, "disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true"));
        let codex_user_only = codex_disables_implicit_invocation(directory);
        discovered.push(json!({
            "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()),
            "path": directory.to_string_lossy(),
            "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()),
            "enabled": true,
            "scope": "global",
            "discovered": true,
            "userInvokedOnly": claude_user_only || codex_user_only,
        }));
    }

    // Pi also treats direct .md children of ~/.pi/agent/skills as skills.
    if include_root_markdown {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_file() || path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") || path.extension().and_then(|extension| extension.to_str()) != Some("md") { continue; }
                let content = fs::read_to_string(&path).unwrap_or_default();
                let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("skill");
                let claude_user_only = frontmatter_value(&content, "disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true"));
                discovered.push(json!({
                    "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()),
                    "path": path.to_string_lossy(),
                    "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()),
                    "enabled": true,
                    "scope": "global",
                    "discovered": true,
                    "userInvokedOnly": claude_user_only,
                }));
            }
        }
    }
    discovered
}

fn merge_discovered_skills(settings: &mut AppSettings) {
    let Ok(home) = home_dir() else { return };
    let roots = [
        (home.join(".pi/agent/skills"), true),
        (home.join(".agents/skills"), false),
    ];
    let enabled_by_path: HashMap<PathBuf, bool> = settings.skills.iter().filter_map(|skill| {
        let path = expand_skill_path(skill.get("path")?.as_str()?, &home);
        Some((path, skill.get("enabled").and_then(Value::as_bool).unwrap_or(true)))
    }).collect();

    // Preserve manually-added paths, but rebuild entries belonging to discovery
    // roots so deleted skills disappear and newly installed skills show up.
    settings.skills.retain(|skill| {
        let Some(path) = skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, &home)) else { return true };
        !roots.iter().any(|(root, _)| skill_path_is_within(&path, root))
    });

    let mut known: HashSet<PathBuf> = settings.skills.iter().filter_map(|skill| skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, &home))).collect();
    for (root, include_root_markdown) in roots {
        for mut skill in discover_skills_in(&root, include_root_markdown) {
            let Some(path) = skill.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
            if !known.insert(path.clone()) { continue; }
            if !skill.get("userInvokedOnly").and_then(Value::as_bool).unwrap_or(false) {
                if let Some(enabled) = enabled_by_path.get(&path) { skill["enabled"] = Value::Bool(*enabled); }
            }
            settings.skills.push(skill);
        }
    }
    settings.skills.sort_by(|left, right| {
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or("");
        let right_name = right.get("name").and_then(Value::as_str).unwrap_or("");
        left_name.to_lowercase().cmp(&right_name.to_lowercase())
    });
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
    let mut host_ids = HashSet::new();
    for host in &settings.hosts {
        if host.id.trim().is_empty() || !host_ids.insert(host.id.as_str()) { return Err("Every machine needs a unique id".into()); }
        validate_remote_host(host)?;
    }
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path(&app)?, body).map_err(|error| error.to_string())
}

#[tauri::command]
fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

fn validate_remote_host(host: &RemoteHost) -> Result<(), String> {
    if host.target.is_empty() || !host.target.chars().all(|character| character.is_ascii_alphanumeric() || "._@:-[]".contains(character)) { return Err("SSH target may only contain a host, user, and port-safe characters".into()); }
    if host.pi_path.is_empty() || !host.pi_path.chars().all(|character| character.is_ascii_alphanumeric() || "._/-~".contains(character)) { return Err("Pi executable must be a plain executable name or path".into()); }
    Ok(())
}

fn remote_host<'a>(settings: &'a AppSettings, host_id: &str) -> Result<&'a RemoteHost, String> {
    let host = settings.hosts.iter().find(|host| host.id == host_id).ok_or_else(|| format!("Unknown machine: {host_id}"))?;
    validate_remote_host(host)?;
    Ok(host)
}

const SSH_OPTIONS: [&str; 6] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"];

fn ssh(host: &RemoteHost) -> Command {
    let mut command = Command::new("ssh");
    command.arg("-T").args(SSH_OPTIONS).arg(&host.target); command
}

fn remote_pi_path(path: &str) -> String {
    path.strip_prefix("~/").map(|rest| format!("$HOME/{}", rest)).unwrap_or_else(|| shell_quote(path))
}

fn remote_directory_path(path: Option<&str>) -> String {
    match path.map(str::trim).filter(|path| !path.is_empty()) {
        None | Some("~") => "\"$HOME\"".into(),
        Some(path) if path.starts_with("~/") => format!("$HOME/{}", shell_quote(&path[2..])),
        Some(path) => shell_quote(path),
    }
}

#[tauri::command]
fn start_pi(app: AppHandle, runtime: State<PiRuntime>, cwd: Option<String>, session_path: Option<String>, host_id: Option<String>) -> Result<(), String> {
    let mut process_guard = runtime.process.lock().map_err(|_| "Pi runtime lock was poisoned")?;
    if process_guard.is_some() { return Ok(()); }
    let settings = load_app_settings(app.clone()).unwrap_or_else(|_| default_settings());
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let mut command = if host_id == "local" {
        let working_dir = cwd.as_ref().map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
        let (mcp_extension, mcp_config) = prepare_mcp_bridge(&app, &settings)?;
        let mut command = Command::new(pi_executable());
        command.arg("--mode").arg("rpc").arg("--approve").arg("--no-skills").current_dir(&working_dir).arg("--extension").arg(mcp_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config);
        if let Some(path) = &session_path { command.arg("--session").arg(path); }
        let enabled_tools: Vec<&str> = settings.tools.iter().filter(|tool| tool.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
        if enabled_tools.is_empty() { command.arg("--no-tools"); } else { command.arg("--tools").arg(enabled_tools.join(",")); }
        for skill in settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)) { if let Some(path) = skill.get("path").and_then(Value::as_str) { let expanded = path.strip_prefix("~/").and_then(|rest| home_dir().ok().map(|home| home.join(rest))).unwrap_or_else(|| PathBuf::from(path)); command.arg("--skill").arg(expanded); } }
        if !settings.default_model.trim().is_empty() { command.arg("--model").arg(settings.default_model.trim()); }
        if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
        command
    } else {
        let host = remote_host(&settings, &host_id)?;
        let mut arguments = vec![remote_pi_path(&host.pi_path), "--mode".into(), "rpc".into(), "--approve".into()];
        if let Some(path) = &session_path { arguments.extend(["--session".into(), shell_quote(path)]); }
        if !settings.default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(settings.default_model.trim())]); }
        if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
        let directory = cwd.as_ref().map(|path| shell_quote(path)).unwrap_or_else(|| "\"$HOME\"".into());
        let remote = format!("cd {directory} && exec {}", arguments.join(" "));
        let mut command = ssh(host); command.arg(remote); command
    };
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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

#[tauri::command]
fn start_terminal(app: AppHandle, runtime: State<TerminalRuntime>, terminal_id: String, cwd: String, cols: u16, rows: u16, host_id: Option<String>) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if processes.contains_key(&terminal_id) { return Ok(()); }
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let mut command = if host_id == "local" {
        let working_dir = PathBuf::from(&cwd);
        if !working_dir.is_dir() { return Err(format!("Terminal working directory does not exist: {}", working_dir.display())); }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut command = CommandBuilder::new(shell); command.cwd(working_dir); command
    } else {
        let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, &host_id)?;
        let mut command = CommandBuilder::new("ssh");
        command.arg("-tt"); command.args(SSH_OPTIONS); command.arg(&host.target); command.arg(format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))); command
    };
    command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(command).map_err(|error| format!("Could not start terminal shell: {error}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let event_app = app.clone(); let event_id = terminal_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(length) => { let data = String::from_utf8_lossy(&buffer[..length]).into_owned(); let _ = event_app.emit("pi://event", json!({ "type": "terminal_output", "terminalId": event_id, "data": data })); }
                Err(_) => break,
            }
        }
        let _ = event_app.emit("pi://event", json!({ "type": "terminal_exit", "terminalId": event_id }));
    });
    processes.insert(terminal_id, TerminalProcess { master: pair.master, child, writer });
    Ok(())
}

#[tauri::command]
fn write_terminal(runtime: State<TerminalRuntime>, terminal_id: String, data: String) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get_mut(&terminal_id).ok_or("Terminal is not running")?;
    process.writer.write_all(data.as_bytes()).and_then(|_| process.writer.flush()).map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal(runtime: State<TerminalRuntime>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get(&terminal_id).ok_or("Terminal is not running")?;
    process.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())
}

#[tauri::command]
fn close_terminal(runtime: State<TerminalRuntime>, terminal_id: String) -> Result<(), String> {
    if let Some(mut process) = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.remove(&terminal_id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    Ok(())
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

fn parse_session_content(path: &Path, content: &str, modified: SystemTime, cwd_exists: bool, host_id: &str, host_name: &str) -> Option<SessionSummary> {
    let mut lines = content.lines(); let header: Value = serde_json::from_str(lines.next()?).ok()?;
    if header.get("type")?.as_str()? != "session" { return None; }
    let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or("Unknown project").to_string();
    let id = header.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut name = None; let mut first_user_message = String::new(); let mut preview = String::new(); let mut message_count = 0;
    for line in lines { let Ok(entry) = serde_json::from_str::<Value>(line) else { continue }; if entry.get("type").and_then(Value::as_str) == Some("session_info") { name = entry.get("name").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned); } if entry.get("type").and_then(Value::as_str) == Some("message") { message_count += 1; if let Some(message) = entry.get("message") { let text = text_content(message); if !text.is_empty() { if first_user_message.is_empty() && message.get("role").and_then(Value::as_str) == Some("user") { first_user_message = text.clone(); } preview = text; } } } }
    let name = name.unwrap_or_else(|| if first_user_message.is_empty() { "Untitled session".into() } else { first_user_message });
    let project = Path::new(&cwd).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").to_string();
    Some(SessionSummary { id, path: path.to_string_lossy().into_owned(), name, project, cwd, cwd_exists, updated_at: iso_from_modified(modified), preview: preview.chars().take(100).collect(), message_count, starred: false, host_id: host_id.into(), host_name: host_name.into() })
}

fn parse_session(path: &Path) -> Option<SessionSummary> {
    let content = fs::read_to_string(path).ok()?;
    let modified = fs::metadata(path).and_then(|metadata| metadata.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
    parse_session_content(path, &content, modified, true, "local", "Local").map(|mut session| { session.cwd_exists = Path::new(&session.cwd).is_dir(); session })
}

fn list_remote_sessions(host: &RemoteHost) -> Result<Vec<SessionSummary>, String> {
    let script = r#"find "$HOME/.pi/agent/sessions" -type f -name '*.jsonl' -exec sh -c 'for path do printf "%s\000%s\000" "$path" "$(stat -c %Y "$path")"; cat "$path"; printf "\000"; done' sh {} + 2>/dev/null"#;
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not run ssh for {}: {error}", host.name))?;
    if !output.status.success() { return Err(format!("Could not list sessions on {}: {}", host.name, String::from_utf8_lossy(&output.stderr).trim())); }
    let chunks: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    let mut sessions = Vec::new();
    for frame in chunks.chunks(3) {
        if frame.len() < 3 || frame[0].is_empty() { continue; }
        let path = PathBuf::from(String::from_utf8_lossy(frame[0]).into_owned());
        let seconds = String::from_utf8_lossy(frame[1]).trim().parse::<u64>().unwrap_or(0);
        let content = String::from_utf8_lossy(frame[2]);
        // ponytail: remote CWD existence is validated when Pi starts; batch it here only if stale remote paths become common.
        if let Some(session) = parse_session_content(&path, &content, SystemTime::UNIX_EPOCH + Duration::from_secs(seconds), true, &host.id, &host.name) { sessions.push(session); }
    }
    Ok(sessions)
}

#[tauri::command]
fn list_directories(app: AppHandle, host_id: String, path: Option<String>) -> Result<DirectoryListing, String> {
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let remote = format!("cd {} && printf '%s\\000' \"$PWD\" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f\\000'", remote_directory_path(path.as_deref()));
    let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not browse {}: {error}", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let mut parts = output.stdout.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let current = PathBuf::from(String::from_utf8_lossy(parts.next().ok_or("Remote directory was unavailable")?).into_owned());
    let mut directories: Vec<String> = parts.map(|name| current.join(String::from_utf8_lossy(name).as_ref()).to_string_lossy().into_owned()).collect();
    directories.sort_by_key(|directory| directory.to_lowercase());
    Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories })
}

#[tauri::command]
fn list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let root = home_dir()?.join(".pi/agent/sessions");
    let mut sessions: Vec<_> = if root.exists() { WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")).filter_map(|entry| parse_session(entry.path())).collect() } else { vec![] };
    // ponytail: hosts are queried serially; parallelize only when measured startup latency warrants it.
    for host in load_app_settings(app)?.hosts { if let Ok(mut remote) = list_remote_sessions(&host) { sessions.append(&mut remote); } }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at)); Ok(sessions)
}

#[tauri::command]
fn archive_session(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        if session_path.contains("/../") || !session_path.contains("/.pi/agent/sessions/") { return Err("Only remote Pi session files can be archived".into()); }
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let file_name = Path::new(&session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
        let destination = format!("{}-{file_name}", Uuid::new_v4());
        let remote = format!("mkdir -p \"$HOME/.pi-desktop/archived\" && mv -- {} \"$HOME/.pi-desktop/archived/{}\"", shell_quote(&session_path), destination);
        let output = ssh(host).arg(remote).output().map_err(|error| error.to_string())?;
        return output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let sessions_root = home_dir()?.join(".pi/agent/sessions").canonicalize().map_err(|error| format!("Could not locate Pi sessions: {error}"))?;
    let source = PathBuf::from(&session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&sessions_root) { return Err("Only Pi session files can be archived".into()); }
    if !source.is_file() { return Err(format!("Session file does not exist: {}", source.display())); }
    let archive_dir = home_dir()?.join(".pi-desktop/archived");
    fs::create_dir_all(&archive_dir).map_err(|error| format!("Could not create archive directory: {error}"))?;
    let file_name = source.file_name().ok_or("Session path has no file name")?;
    let mut destination = archive_dir.join(file_name);
    if destination.exists() {
        let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("session");
        let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("jsonl");
        destination = archive_dir.join(format!("{stem}-{}.{}", Uuid::new_v4(), extension));
    }
    fs::rename(&source, &destination).map_err(|error| format!("Could not archive session: {error}"))
}

#[tauri::command]
fn relocate_session(session_path: String, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" { return Err("Relocating remote sessions is not supported yet".into()); }
    let replacement = PathBuf::from(cwd.trim());
    if !replacement.is_dir() { return Err(format!("Project directory does not exist: {}", replacement.display())); }
    let path = PathBuf::from(session_path);
    let content = fs::read_to_string(&path).map_err(|error| format!("Could not read session: {error}"))?;
    let (first, rest) = content.split_once('\n').unwrap_or((&content, ""));
    let mut header: Value = serde_json::from_str(first).map_err(|error| format!("Invalid session header: {error}"))?;
    if header.get("type").and_then(Value::as_str) != Some("session") { return Err("File is not a Pi session".into()); }
    header.as_object_mut().ok_or("Invalid session header")?.insert("cwd".into(), Value::String(replacement.to_string_lossy().into_owned()));
    let first = serde_json::to_string(&header).map_err(|error| error.to_string())?;
    let updated = if rest.is_empty() { first } else { format!("{first}\n{rest}") };
    fs::write(path, updated).map_err(|error| format!("Could not update session: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(PiRuntime::default()).manage(TerminalRuntime::default()).invoke_handler(tauri::generate_handler![start_pi, stop_pi, pi_command, start_terminal, write_terminal, resize_terminal, close_terminal, list_sessions, list_directories, archive_session, relocate_session, load_app_settings, save_app_settings, codex_usage]).run(tauri::generate_context!()).expect("error while running Pi desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_limiting_codex_usage_window() {
        let response = json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":24},"secondary":{"usedPercent":61}}}});
        assert_eq!(codex_remaining_percent(&response), Some(39));
    }

    #[test]
    fn discovers_skills_using_pi_global_directory_rules() {
        let root = std::env::temp_dir().join(format!("pi-ui-skills-{}", Uuid::new_v4()));
        let regular = root.join("regular");
        let nested = regular.join("references/nested");
        let codex = root.join("codex-only");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(codex.join("agents")).unwrap();
        fs::write(regular.join("SKILL.md"), "---\nname: Regular skill\ndescription: A discovered skill\ndisable-model-invocation: true\n---\n").unwrap();
        fs::write(nested.join("SKILL.md"), "---\nname: Nested reference\n---\n").unwrap();
        fs::write(codex.join("SKILL.md"), "---\nname: Codex skill\ndescription: A Codex user-only skill\n---\n").unwrap();
        fs::write(codex.join("agents/openai.yaml"), "interface:\n  display_name: Codex skill\npolicy:\n  allow_implicit_invocation: false\n").unwrap();
        fs::write(root.join("standalone.md"), "---\nname: Standalone skill\n---\n").unwrap();

        let pi_skills = discover_skills_in(&root, true);
        assert_eq!(pi_skills.len(), 3);
        assert!(pi_skills.iter().any(|skill| skill.get("name").and_then(Value::as_str) == Some("Regular skill") && skill.get("userInvokedOnly").and_then(Value::as_bool) == Some(true)));
        assert!(pi_skills.iter().any(|skill| skill.get("name").and_then(Value::as_str) == Some("Codex skill") && skill.get("userInvokedOnly").and_then(Value::as_bool) == Some(true)));
        assert!(pi_skills.iter().any(|skill| skill.get("name").and_then(Value::as_str) == Some("Standalone skill")));

        let agents_skills = discover_skills_in(&root, false);
        assert_eq!(agents_skills.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matches_pi_cli_session_picker_titles() {
        let root = std::env::temp_dir().join(format!("pi-ui-session-name-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let unnamed = root.join("unnamed.jsonl");
        fs::write(
            &unnamed,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"unnamed\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"This is message content, not a title\"}}}}\n",
                serde_json::to_string(root.to_str().unwrap()).unwrap()
            ),
        ).unwrap();
        let named = root.join("named.jsonl");
        fs::write(
            &named,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"named\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"This is still message content\"}}}}\n{{\"type\":\"session_info\",\"name\":\"Pi CLI title\"}}\n",
                serde_json::to_string(root.to_str().unwrap()).unwrap()
            ),
        ).unwrap();

        assert_eq!(parse_session(&unnamed).unwrap().name, "This is message content, not a title");
        assert_eq!(parse_session(&named).unwrap().name, "Pi CLI title");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relocates_a_session_with_a_missing_working_directory() {
        let root = std::env::temp_dir().join(format!("pi-ui-relocate-{}", Uuid::new_v4()));
        let replacement = root.join("replacement");
        fs::create_dir_all(&replacement).unwrap();
        let session = root.join("session.jsonl");
        fs::write(&session, "{\"type\":\"session\",\"version\":3,\"id\":\"test\",\"cwd\":\"/missing/project\"}\n{\"type\":\"message\"}\n").unwrap();

        relocate_session(session.to_string_lossy().into_owned(), replacement.to_string_lossy().into_owned(), None).unwrap();

        let content = fs::read_to_string(&session).unwrap();
        let header: Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(header.get("cwd").and_then(Value::as_str), replacement.to_str());
        assert!(content.contains("{\"type\":\"message\"}"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tags_remote_sessions_with_their_machine() {
        let content = "{\"type\":\"session\",\"version\":3,\"id\":\"remote\",\"cwd\":\"/srv/app\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Deploy it\"}}\n";
        let session = parse_session_content(Path::new("/home/deploy/.pi/agent/sessions/remote.jsonl"), content, SystemTime::UNIX_EPOCH, true, "build", "Build VPS").unwrap();
        assert_eq!((session.host_id.as_str(), session.host_name.as_str(), session.project.as_str()), ("build", "Build VPS", "app"));
        assert_eq!(shell_quote("it's safe"), "'it'\\''s safe'");
    }

    #[test]
    fn ssh_accepts_new_keys_without_accepting_changed_keys() {
        let host = RemoteHost { id: "vps".into(), name: "VPS".into(), target: "deploy@example.com".into(), pi_path: "pi".into() };
        let command = ssh(&host); let arguments: Vec<_> = command.get_args().map(|argument| argument.to_string_lossy().into_owned()).collect();
        assert!(arguments.windows(2).any(|pair| pair == ["StrictHostKeyChecking=accept-new", "deploy@example.com"]));
    }
}
