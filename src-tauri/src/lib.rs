mod session_groups;
use session_groups::{load_session_groups, change_session_groups};

use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant, SystemTime},
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

struct PiProcess {
    generation: Uuid,
    claim: Option<BusyAgent>,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    blank_cleanup: BlankSessionCleanup,
    command_timeout: Duration,
}

struct BlankSessionCleanup { path: Option<String>, id: Option<String>, host: Option<RemoteHost>, submitted: bool }

fn cleanup_blank_session(target: BlankSessionCleanup) {
    if target.submitted { return; }
    let script = include_str!("../resources/cleanup-blank-session.cjs");
    let arguments = json!({"path":target.path,"id":target.id,"root":if target.host.is_none() { home_dir().ok().map(|home| home.join(".piop/sessions")) } else { None }}).to_string();
    let result = if let Some(host) = target.host {
        ssh(&host).arg(remote_login_command(&format!("node -e {} {}", shell_quote(script), shell_quote(&arguments)))).output()
    } else { Command::new("node").arg("-e").arg(script).arg(arguments).output() };
    match result {
        Ok(output) if output.status.success() => {},
        Ok(output) => eprintln!("Could not clean up blank session: {}", String::from_utf8_lossy(&output.stderr)),
        Err(error) => eprintln!("Could not clean up blank session: {error}"),
    }
}

#[derive(Clone)]
enum EphemeralSession {
    Local(PathBuf),
    Remote { host: RemoteHost, path: String },
}

struct TerminalProcess {
    session_key: String,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
    writer: mpsc::SyncSender<String>,
}

#[derive(Default)]
struct TerminalRuntime {
    processes: Arc<Mutex<HashMap<String, TerminalProcess>>>,
}

#[derive(Clone)]
struct CachedSession { fingerprint: String, summary: SessionSummary }

#[derive(Default)]
struct SessionIndexRuntime {
    local: Mutex<HashMap<PathBuf, CachedSession>>,
    remote: Mutex<HashMap<String, HashMap<String, CachedSession>>>,
}

const MAX_TERMINALS: usize = 8;
const MAX_REMOTE_HOSTS: usize = 16;
const MAX_MCP_SERVERS: usize = 32;
const BROKER_WORKERS: usize = 8;
const BROKER_QUEUE_DEPTH: usize = 32;
const BROKER_HEADER_BYTES: usize = 16 * 1024;
const BROKER_BODY_BYTES: usize = 1024 * 1024;
const MAX_GIT_CHANGED_PATHS: usize = 4096;
const MAX_GIT_PATH_LIST_BYTES: usize = 1024 * 1024;
const MAX_GIT_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GIT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_DIFFS_BYTES: usize = 16 * 1024 * 1024;
const MAX_AGENT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SESSION_INDEX_BATCH_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct PiRuntime {
    worktree_setups: Mutex<HashMap<String, Arc<AtomicBool>>>,
    ephemeral_sessions: Mutex<HashMap<String, EphemeralSession>>,
    processes: Arc<Mutex<HashMap<String, PiProcess>>>,
    pending: Arc<Mutex<HashMap<(String, String), mpsc::Sender<Result<Value, String>>>>>,
    active_agents: Arc<Mutex<HashMap<String, AgentAddress>>>,
}

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String>, worktree: Option<String>, presence_id: Option<String>, working: bool }

#[derive(Clone)]
struct BrokerRuntime {
    closing: Arc<AtomicBool>,
    message_count: Arc<Mutex<usize>>,
    port: Arc<Mutex<u16>>,
    token: String,
    busy: Arc<Mutex<HashSet<String>>>,
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl Default for BrokerRuntime {
    fn default() -> Self {
        Self {
            closing: Arc::new(AtomicBool::new(false)), message_count: Arc::new(Mutex::new(0)),
            port: Arc::new(Mutex::new(0)),
            token: Uuid::new_v4().to_string(),
            busy: Arc::new(Mutex::new(HashSet::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

struct BusyAgent { key: String, busy: Arc<Mutex<HashSet<String>>> }

impl Drop for BusyAgent {
    fn drop(&mut self) { if let Ok(mut busy) = self.busy.lock() { busy.remove(&self.key); } }
}

fn fail_pending(pending: &Arc<Mutex<HashMap<(String, String), mpsc::Sender<Result<Value, String>>>>>, runtime_id: &str, error: &str) {
    let senders: Vec<_> = pending.lock().map(|mut requests| { let keys: Vec<_> = requests.keys().filter(|(owner, _)| owner == runtime_id).cloned().collect(); keys.into_iter().filter_map(|key| requests.remove(&key)).collect() }).unwrap_or_default();
    for sender in senders { let _ = sender.send(Err(error.into())); }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProjectKind { NoRepo, Main, Worktree }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    group_id: Option<String>,
    path: String,
    name: String,
    project: String,
    cwd: String,
    cwd_exists: bool,
    project_kind: Option<ProjectKind>,
    project_root: Option<String>,
    #[serde(skip)]
    modified_at: u64,
    preview: String,
    message_count: usize,
    api_cost: f64,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryEntry {
    word: String,
    replacement: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptDictionary {
    id: String,
    name: String,
    entries: Vec<DictionaryEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsage {
    remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryChat {
    cwd: String,
    session_id: String,
}

type GitDiffSnapshots = HashMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    worktree_setup_scripts: Vec<WorktreeSetupScript>,
    #[serde(default = "default_agent")]
    default_agent: String,
    default_model: String,
    #[serde(default)]
    hidden_models: Vec<String>,
    default_thinking: String,
    #[serde(default)]
    default_fast_mode: bool,
    #[serde(default = "default_context_window_cap", deserialize_with = "deserialize_context_window_cap")]
    context_window_cap: u64,
    #[serde(default = "default_context_window_cap_enabled")]
    context_window_cap_enabled: bool,
    auto_compaction: bool,
    auto_retry: bool,
    #[serde(default)]
    debug_mode: bool,
    #[serde(default = "default_keybindings")]
    keybindings: HashMap<String, String>,
    tools: Vec<Value>,
    skills: Vec<Value>,
    mcp_servers: Vec<Value>,
    #[serde(default)]
    hosts: Vec<RemoteHost>,
    #[serde(default)]
    dictionaries: Vec<PromptDictionary>,
    #[serde(default)]
    active_dictionary_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeSetupScript { id: String, name: String, script: String, enabled: bool }

fn default_pi_path() -> String { "pi".into() }
fn default_context_window_cap() -> u64 { 200_000 }
fn default_context_window_cap_enabled() -> bool { true }
fn deserialize_context_window_cap<'de, D>(deserializer: D) -> Result<u64, D::Error> where D: Deserializer<'de> {
    let value = Value::deserialize(deserializer)?;
    value.as_u64().ok_or_else(|| de::Error::custom("Context window cap must be a whole number"))
}
const DEFAULT_MODEL: &str = "openai-codex/gpt-5.6-sol";

fn default_keybindings() -> HashMap<String, String> {
    [
        ("newConversation", "Ctrl+N"),
        ("toggleConversations", "Ctrl+B"),
        ("toggleTerminal", "Ctrl+J"),
        ("toggleDebugMode", "Ctrl+D"),
        ("focusComposer", "Ctrl+E"),
        ("openSettings", "Ctrl+,"),
    ].into_iter().map(|(action, shortcut)| (action.into(), shortcut.into())).collect()
}

fn home_dir() -> Result<PathBuf, String> {
    #[cfg(feature = "webdriver")]
    if let Some(path) = std::env::var_os("PIOP_TEST_HOME") { return Ok(PathBuf::from(path)); }
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

fn pi_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("PIOP_PI_PATH").or_else(|| std::env::var_os("PI_DESKTOP_PI_PATH")) { return PathBuf::from(path); }
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

fn codex_usage_values(response: &Value) -> Option<CodexUsage> {
    let limits = response.pointer("/rateLimitsByLimitId/codex").or_else(|| response.get("rateLimits"))?;
    let (used, reset_at) = ["primary", "secondary"].iter().filter_map(|window| {
        let value = limits.get(window)?;
        Some((value.get("usedPercent")?.as_f64()?, value.get("resetsAt").and_then(Value::as_u64)))
    }).max_by(|left, right| left.0.total_cmp(&right.0))?;
    Some(CodexUsage { remaining_percent: (100.0 - used.clamp(0.0, 100.0)).round() as u8, reset_at })
}

#[tauri::command(async)]
fn codex_usage() -> Result<CodexUsage, String> {
    let mut child = Command::new(codex_executable()).arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("Codex stdin was unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout was unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) { if sender.send(line).is_err() { break; } });
        let deadline = Instant::now() + Duration::from_secs(8);
        writeln!(stdin, "{}", json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"piop","title":"piop","version":env!("CARGO_PKG_VERSION")},"capabilities":null}})).map_err(|error| error.to_string())?;
        codex_response(&receiver, 1, deadline)?;
        writeln!(stdin, "{}", json!({"method":"initialized"})).map_err(|error| error.to_string())?;
        writeln!(stdin, "{}", json!({"method":"account/rateLimits/read","id":2})).map_err(|error| error.to_string())?;
        let response = codex_response(&receiver, 2, deadline)?;
        codex_usage_values(&response).ok_or_else(|| "Codex usage is unavailable".into())
    })();
    let _ = child.kill(); let _ = child.wait(); result
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("settings.json");
    if !path.exists() {
        let legacy = app.path().app_config_dir().map_err(|error| error.to_string())?.join("settings.json");
        match fs::read(&legacy) {
            Ok(body) => {
                atomic_write_private(&path, &body)?;
                fs::remove_file(&legacy).map_err(|error| format!("Settings migrated, but could not remove old settings: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not migrate settings: {error}")),
        }
    }
    set_private_file_permissions(&path)?;
    Ok(path)
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o600 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn atomic_write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Configuration file has no parent directory")?;
    ensure_private_dir(parent)?;
    if path.exists() {
        set_private_file_permissions(path)?;
        match fs::read(path) {
            Ok(current) if current == body => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary = parent.join(format!(".{}.{}.tmp", path.file_name().and_then(|name| name.to_str()).unwrap_or("config"), Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
        file.write_all(body).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        if let Ok(directory) = fs::File::open(parent) { let _ = directory.sync_all(); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn validate_dictionaries(settings: &AppSettings) -> Result<(), String> {
    let mut ids = HashSet::new();
    for dictionary in &settings.dictionaries { if dictionary.id.trim().is_empty() || !ids.insert(dictionary.id.as_str()) { return Err("Every dictionary needs a unique id".into()); } }
    let mut active_ids = HashSet::new();
    for id in &settings.active_dictionary_ids { if !ids.contains(id.as_str()) { return Err("Active dictionary was not found".into()); } if !active_ids.insert(id.as_str()) { return Err("A dictionary can only be active once".into()); } }
    let mut keys = HashSet::new();
    for dictionary in settings.dictionaries.iter().filter(|dictionary| active_ids.contains(dictionary.id.as_str())) {
        for entry in &dictionary.entries { let key = entry.word.trim(); if key.is_empty() { continue; } if !keys.insert(key) { return Err(format!("Key '{key}' appears more than once in active dictionaries")); } }
    }
    Ok(())
}

fn canonical_shortcut(shortcut: &str) -> Result<Option<String>, String> {
    let parts: Vec<String> = shortcut.split('+').map(|part| part.trim().to_lowercase()).filter(|part| !part.is_empty()).collect();
    if parts.is_empty() { return Ok(None); }
    let modifiers = ["ctrl", "meta", "alt", "shift", "mod"];
    let key = parts.iter().find(|part| !modifiers.contains(&part.as_str())).ok_or_else(|| format!("Shortcut '{shortcut}' needs a key"))?;
    let protected = parts.iter().any(|part| matches!(part.as_str(), "ctrl" | "meta" | "alt" | "mod"));
    if key.chars().count() == 1 && !protected { return Err(format!("Shortcut '{shortcut}' needs Ctrl, Alt, or Meta")); }
    let mut canonical: Vec<&str> = modifiers.iter().copied().filter(|modifier| parts.iter().any(|part| part == modifier)).collect(); canonical.push(key); Ok(Some(canonical.join("+")))
}

fn migrate_keybindings(settings: &mut AppSettings) {
    // Retired actions can retain shortcuts now reserved by the app (e.g. conversation search).
    let supported = default_keybindings();
    settings.keybindings.retain(|action, _| supported.contains_key(action));
    if settings.keybindings.get("focusComposer").map(String::as_str) == Some("Ctrl+L") {
        settings.keybindings.insert("focusComposer".into(), "Ctrl+E".into());
    }
}

fn validate_keybindings(settings: &AppSettings) -> Result<(), String> {
    let mut shortcuts = HashSet::new();
    for shortcut in settings.keybindings.values() { if let Some(canonical) = canonical_shortcut(shortcut)? { if matches!(canonical.as_str(), "ctrl+g" | "meta+g" | "mod+g") { return Err(format!("Shortcut '{shortcut}' is reserved for conversation search")); } if !shortcuts.insert(canonical) { return Err(format!("Shortcut '{shortcut}' is assigned more than once")); } } }
    Ok(())
}

fn validate_mcp_servers(settings: &AppSettings) -> Result<(), String> {
    if settings.mcp_servers.len() > MAX_MCP_SERVERS { return Err(format!("At most {MAX_MCP_SERVERS} MCP servers can be configured")); }
    let mut ids = HashSet::new();
    for server in &settings.mcp_servers {
        let id = server.get("id").and_then(Value::as_str).unwrap_or(""); let name = server.get("name").and_then(Value::as_str).unwrap_or("").trim();
        if id.trim().is_empty() || !ids.insert(id) { return Err("Every MCP server needs a unique id".into()); }
        if name.is_empty() { return Err("Every MCP server needs a name".into()); }
        if let Some(timeout) = server.get("startupTimeoutSec") {
            if !timeout.as_u64().map(|seconds| (1..=600).contains(&seconds)).unwrap_or(false) {
                return Err(format!("{name}: startup timeout must be a whole number between 1 and 600 seconds"));
            }
        }
        match server.get("transport").and_then(Value::as_str).unwrap_or("stdio") {
            "stdio" => if server.get("command").and_then(Value::as_str).unwrap_or("").trim().is_empty() { return Err(format!("{name}: command can't be empty")); },
            "http" => {
                let raw_url = server.get("url").and_then(Value::as_str).unwrap_or("").trim(); let parsed = tauri::Url::parse(raw_url).map_err(|_| format!("{name}: enter a valid HTTP URL"))?;
                if !matches!(parsed.scheme(), "http" | "https") { return Err(format!("{name}: URL must use HTTP or HTTPS")); }
                if let Some(headers) = server.get("headers") {
                    let parsed = match headers { Value::Null => None, Value::String(value) if value.trim().is_empty() => None, Value::String(value) => Some(serde_json::from_str::<Value>(value).map_err(|_| format!("{name}: headers must be valid JSON"))?), Value::Object(_) => Some(headers.clone()), _ => return Err(format!("{name}: headers must be a JSON object containing string values")) };
                    if let Some(parsed) = parsed { let object = parsed.as_object().ok_or_else(|| format!("{name}: headers must be a JSON object containing string values"))?; if object.values().any(|value| !value.is_string()) { return Err(format!("{name}: headers must be a JSON object containing string values")); } }
                }
            }
            transport => return Err(format!("{name}: unsupported MCP transport '{transport}'")),
        }
    }
    Ok(())
}

fn prepare_mcp_bridge(settings: &AppSettings) -> Result<(PathBuf, PathBuf), String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("pi-desktop-mcp-bridge.ts");
    let config_path = dir.join("mcp-servers.json");
    atomic_write_private(&extension_path, include_str!("../resources/mcp-bridge.bundle.mjs").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?)?;
    Ok((extension_path, config_path))
}

fn runtime_settings(settings: &AppSettings) -> Value {
    json!({ "tools": enabled_tool_names(settings), "skills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "mcpServers": settings.mcp_servers, "contextWindowCap": settings.context_window_cap, "contextWindowCapEnabled": settings.context_window_cap_enabled })
}

fn prepare_runtime_settings(settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("runtime-settings.ts");
    atomic_write_private(&path, include_str!("../../extensions/pi-runtime-settings/index.ts").as_bytes())?;
    atomic_write_private(&dir.join("runtime-settings.json"), &serde_json::to_vec(&runtime_settings(settings)).map_err(|error| error.to_string())?)?;
    Ok(path)
}

fn prepare_session_broker() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("session-broker.ts");
    atomic_write_private(&path, include_str!("../resources/session-broker.ts").as_bytes())?;
    Ok(path)
}

fn prepare_hooks_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    ensure_private_dir(&dir.join("hooks"))?;
    let path = dir.join("hook-loader.ts");
    atomic_write_private(&dir.join("hook-stats.ts"), include_str!("../../extensions/piop-hooks/hook-stats.ts").as_bytes())?;
    atomic_write_private(&path, include_str!("../../extensions/piop-hooks/index.ts").as_bytes())?;
    Ok(path)
}

#[tauri::command(async)]
fn list_hooks(app: AppHandle, host_id: String) -> Result<Value, String> {
    let script = include_str!("../resources/list-hooks.cjs");
    let mut command = if host_id == "local" {
        let mut command = Command::new("node");
        command.args(["-e", script]);
        command
    } else {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, &host_id)?;
        let mut command = ssh(host);
        command.arg(format!("node -e {}", shell_quote(script)));
        command
    };
    let output = run_limited(&mut command, 4 * 1024 * 1024, "Could not list hooks")?;
    if !output.status.success() { return Err(format!("Could not list hooks: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Could not read hook list: {error}"))
}

fn prepare_trace_reader() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("pi-desktop-trace-reader.ts");
    atomic_write_private(&path, include_str!("../resources/trace-reader.ts").as_bytes())?;
    Ok(path)
}

fn prepare_codex_compaction_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("pi-desktop-codex-compaction.ts");
    atomic_write_private(&path, include_str!("../resources/codex-compaction.bundle.mjs").as_bytes())?;
    Ok(path)
}

fn prepare_fast_mode_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop/pi-openai-fast-mode-piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("index.ts");
    atomic_write_private(&path, include_str!("../resources/fast-mode.bundle.mjs").as_bytes())?;
    Ok(path)
}

fn prepare_codex_web_search_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("pi-desktop-codex-web-search.ts");
    atomic_write_private(&path, include_str!("../../extensions/pi-codex-web-search/index.ts").as_bytes())?;
    Ok(path)
}

fn prepare_context_window_cap_extension(settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop/pi-context-window-cap");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    let config_path = dir.join("config.json");
    atomic_write_private(&extension_path, include_str!("../../extensions/pi-context-window-cap/index.ts").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?)?;
    Ok(extension_path)
}

fn prepare_project_files_watch_extension() -> Result<PathBuf, String> {
    let config_dir = home_dir()?.join(".piop");
    let legacy_dir = config_dir.join("pi-git-change-context");
    if legacy_dir.exists() { fs::remove_dir_all(&legacy_dir).map_err(|error| format!("Could not remove legacy project files watch extension: {error}"))?; }
    let dir = config_dir.join("pi-project-files-watch");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    atomic_write_private(&extension_path, include_str!("../../extensions/pi-project-files-watch/index.ts").as_bytes())?;
    Ok(extension_path)
}

fn prepare_defined_agents_extension() -> Result<PathBuf, String> {
    // Older app installations left an auto-discovered orchestration entry point.
    // Preserve it outside Pi's discovery directory, along with all existing config.
    let legacy = home_dir()?.join(".pi/agent/extensions/pi-orchestration/index.ts");
    if legacy.exists() {
        let backup = home_dir()?.join(".piop/disabled-extensions");
        ensure_private_dir(&backup)?;
        fs::rename(&legacy, backup.join(format!("pi-orchestration-{}.ts", Uuid::new_v4())))
            .map_err(|error| format!("Could not disable legacy orchestration: {error}"))?;
    }
    let dir = home_dir()?.join(".piop/pi-define-agents");
    ensure_private_dir(&dir)?;
    let legacy_dir = home_dir()?.join(".pi/agent/extensions/pi-define-agents");
    let config = dir.join("config.json");
    if !config.exists() && legacy_dir.join("config.json").exists() {
        atomic_write_private(&config, &fs::read(legacy_dir.join("config.json")).map_err(|error| error.to_string())?)?;
    }
    let orchestration = home_dir()?.join(".pi/agent/extensions/pi-orchestration/config.json");
    if !config.exists() && orchestration.exists() { atomic_write_private(&config, &fs::read(orchestration).map_err(|e| e.to_string())?)?; }
    let path = dir.join("index.ts");
    atomic_write_private(&path, include_str!("../../extensions/pi-define-agents/index.ts").as_bytes())?;
    if legacy_dir.join("index.ts").exists() { fs::remove_file(legacy_dir.join("index.ts")).map_err(|error| error.to_string())?; }
    Ok(path)
}

fn prepare_btw_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".piop");
    ensure_private_dir(&dir)?;
    let path = dir.join("pi-desktop-btw.ts");
    atomic_write_private(&path, include_str!("../resources/btw.ts").as_bytes())?;
    let legacy = home_dir()?.join(".pi/agent/extensions/pi-desktop-btw.ts");
    if legacy.exists() { fs::remove_file(legacy).map_err(|error| error.to_string())?; }
    Ok(path)
}

fn default_agent() -> String { "general".into() }

fn default_settings() -> AppSettings {
    AppSettings {
        worktree_setup_scripts: vec![],
        default_agent: default_agent(),
        default_fast_mode: false,
        default_model: DEFAULT_MODEL.into(), hidden_models: vec![], default_thinking: "medium".into(), context_window_cap: default_context_window_cap(), context_window_cap_enabled: default_context_window_cap_enabled(), auto_compaction: true, auto_retry: true, debug_mode: false, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List agents by machine and session","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Send a message to another agent","enabled":true,"builtin":false}),
            json!({"name":"read_trace","description":"Extract clean user and final assistant messages from a Pi trace","enabled":true,"builtin":false}),
            codex_web_search_tool(),
        ]).collect(),
        skills: vec![], mcp_servers: vec![], hosts: vec![], dictionaries: vec![], active_dictionary_ids: vec![],
    }
}

fn codex_web_search_tool() -> Value {
    json!({"name":"web_search","description":"Search the web with Pi's Codex login and return cited answers","enabled":true,"builtin":false})
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
        .follow_links(false)
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
            "discovered": true,
            "userInvokedOnly": claude_user_only || codex_user_only,
        }));
    }

    // Pi also treats direct .md children of ~/.pi/agent/skills as skills.
    if include_root_markdown {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) || path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") || path.extension().and_then(|extension| extension.to_str()) != Some("md") { continue; }
                let content = fs::read_to_string(&path).unwrap_or_default();
                let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("skill");
                let claude_user_only = frontmatter_value(&content, "disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true"));
                discovered.push(json!({
                    "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()),
                    "path": path.to_string_lossy(),
                    "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()),
                    "enabled": true,
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

#[tauri::command(async)]
fn load_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    let mut settings = if !path.exists() { default_settings() } else { serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? };
    for (legacy, replacements) in [
        ("exec_command", &["read", "bash", "grep", "find", "ls"][..]),
        ("apply_patch", &["edit", "write"][..]),
    ] {
        let enabled = settings.tools.iter().find(|tool| tool.get("name").and_then(Value::as_str) == Some(legacy))
            .and_then(|tool| tool.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
        settings.tools.retain(|tool| tool.get("name").and_then(Value::as_str) != Some(legacy));
        for name in replacements {
            if !settings.tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some(*name)) {
                settings.tools.push(json!({"name":name,"description":"Pi built-in tool","enabled":enabled,"builtin":true}));
            }
        }
    }
    if !settings.tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some("web_search")) {
        settings.tools.push(codex_web_search_tool());
    }
    migrate_keybindings(&mut settings);
    if settings.hosts.len() > MAX_REMOTE_HOSTS { return Err(format!("Settings contain more than {MAX_REMOTE_HOSTS} remote machines")); }
    if settings.mcp_servers.len() > MAX_MCP_SERVERS { return Err(format!("Settings contain more than {MAX_MCP_SERVERS} MCP servers")); }
    merge_discovered_skills(&mut settings);
    validate_dictionaries(&settings)?;
    Ok(settings)
}

#[tauri::command(async)]
fn save_app_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    migrate_keybindings(&mut settings);
    if settings.context_window_cap < 1000 { return Err("Context window cap must be a whole number of at least 1000".into()); }
    validate_dictionaries(&settings)?;
    validate_keybindings(&settings)?;
    validate_mcp_servers(&settings)?;
    if settings.hosts.len() > MAX_REMOTE_HOSTS { return Err(format!("At most {MAX_REMOTE_HOSTS} remote machines can be configured")); }
    let mut host_ids = HashSet::new();
    let mut host_names = HashSet::from(["local".to_string()]);
    for host in &settings.hosts {
        if host.id.trim().is_empty() || !host_ids.insert(host.id.as_str()) { return Err("Every machine needs a unique id".into()); }
        let name = host.name.trim().to_lowercase();
        if name.is_empty() { return Err("Every machine needs a name".into()); }
        if !host_names.insert(name) { return Err(format!("Machine name '{}' is already in use", host.name.trim())); }
        validate_remote_host(host)?;
    }
    atomic_write_private(&settings_path(&app)?, &serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?)
}

#[tauri::command]
fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

fn desktop_sessions_dir(home: &Path) -> PathBuf { home.join(".piop/sessions") }

fn ensure_desktop_sessions_dir(home: &Path) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home);
    fs::create_dir_all(&root).map_err(|error| format!("Could not create piop session directory: {error}"))?;
    Ok(root)
}

#[derive(Serialize, Deserialize)]
struct GitSnapshotToken { root: String, tree: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktree { branch: String, path: String }

struct LimitedOutput { status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8> }

#[tauri::command]
async fn run_worktree_setup(app: AppHandle, setup_id: String, cwd: String, worktree_path: String, host_id: Option<String>) -> Result<(), String> {
    let cancelled = app.state::<PiRuntime>().worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(&setup_id).cloned().ok_or("Unknown setup")?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let settings = load_app_settings(worker_app)?;
        let host_id = host_id.as_deref().unwrap_or("local");
        let host = if host_id == "local" { None } else { Some(remote_host(&settings, host_id)?) };
        for setup in settings.worktree_setup_scripts.iter().filter(|setup| setup.enabled && !setup.script.trim().is_empty()) {
            if cancelled.load(Ordering::SeqCst) { return Err("Environment setup cancelled".into()); }
            let context = format!("Setup script '{}' failed", setup.name);
            if setup.script.len() > 32 * 1024 { return Err(format!("{context}: script exceeds 32 KiB")); }
            let completion_marker = format!("piop-setup-complete-{}", Uuid::new_v4());
            let script = format!(r#"exec 4>&1
exec 1>&2
set +e
root=$(git -C {source} rev-parse --show-toplevel) || exit 1
PIOP_SOURCE_TREE_PATH=$(cd -- "$root" && pwd -P) || exit 1
cd -- {target} || exit 1
PIOP_WORKTREE_PATH=$(pwd -P) || exit 1
export PIOP_SOURCE_TREE_PATH PIOP_WORKTREE_PATH
exec 3<&0
setup_output=$(mktemp "${{TMPDIR:-/tmp}}/piop-setup.XXXXXX") || exit 1
trap 'rm -f -- "$setup_output"' EXIT
exec 6>"$setup_output" || exit 1
# The drain inherits no SSH streams or cancellation descriptors. It can outlive
# setup while background jobs write, retaining at most 64 KiB and discarding more.
# Byte-sized reads keep short diagnostics available without waiting for EOF.
exec 5> >( trap - EXIT; exec >/dev/null 2>&1 3<&- 4>&-; dd bs=1 count=65536 >&6; exec 6>&-; cat >/dev/null )
output_pid=$!
exec 6>&-
set -m
bash -e -c {code} </dev/null >&5 2>&1 3<&- 4>&- 5>&- &
setup_pid=$!
exec 5>&-
set +m
# Keep cancellation separate from script input. EOF also stops setup if SSH disconnects.
( trap - EXIT; IFS= read -r cancel; kill -KILL -- "-$setup_pid" 2>/dev/null ) <&3 4>&- &
watcher=$!
wait "$setup_pid"
status=$?
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$output_pid" 2>/dev/null || break
    sleep 0.01
done
head -c 65536 "$setup_output" >&2
rm -f -- "$setup_output"
printf '\n%s %s\n' {marker} "$status" >&4
exit "$status""#, source = shell_quote(&cwd), target = shell_quote(&worktree_path), code = shell_quote(&setup.script), marker = shell_quote(&completion_marker));
            let mut command = if let Some(host) = host { let mut command = ssh(host); command.arg(remote_login_command(&script)); command } else { let mut command = Command::new("bash"); command.args(["-c", &script]); command };
            let (status, stderr) = run_setup_process(&mut command, &cancelled, &context, completion_marker)?;
            if status != 0 {
                let detail = String::from_utf8_lossy(&stderr);
                return Err(format!("{context} (exit status {status}):\n{}", detail.trim()));
            }
        }
        Ok(())
    }).await.map_err(|error| error.to_string());
    app.state::<PiRuntime>().worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.remove(&setup_id);
    result?
}

#[tauri::command]
fn prepare_worktree_setup(runtime: State<PiRuntime>) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.insert(id.clone(), Arc::new(AtomicBool::new(false)));
    Ok(id)
}

#[tauri::command]
fn cancel_worktree_setup(runtime: State<PiRuntime>, setup_id: String) -> Result<(), String> {
    if let Some(cancelled) = runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(&setup_id) { cancelled.store(true, Ordering::SeqCst); }
    Ok(())
}

fn run_setup_process(command: &mut Command, cancelled: &AtomicBool, context: &str, completion_marker: String) -> Result<(i32, Vec<u8>), String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("{context}: {error}"))?;
    let mut input = child.stdin.take();
    let stdout = child.stdout.take().ok_or("Setup stdout was unavailable")?;
    let (completed_tx, completed_rx) = mpsc::channel();
    thread::spawn(move || {
        let prefix = format!("{completion_marker} ");
        let mut line = Vec::new();
        // Login profiles may print output; retain only short protocol lines.
        for byte in BufReader::new(stdout).bytes() {
            let Ok(byte) = byte else { break };
            if byte == b'\n' {
                if let Some(status) = std::str::from_utf8(&line).ok().and_then(|line| line.strip_prefix(&prefix)).and_then(|status| status.parse::<i32>().ok()) {
                    let _ = completed_tx.send(status);
                    break;
                }
                line.clear();
            } else if line.len() < 256 { line.push(byte); }
        }
    });
    let mut stderr = child.stderr.take().ok_or("Setup stderr was unavailable")?;
    let retained = Arc::new(Mutex::new(Vec::new()));
    let reader_output = retained.clone();
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 { break; }
            let mut output = reader_output.lock().unwrap();
            let remaining = (64 * 1024usize).saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        let _ = done_tx.send(());
    });
    let mut cancelling_at = None;
    let status = loop {
        if cancelled.load(Ordering::SeqCst) && cancelling_at.is_none() {
            if let Some(mut input) = input.take() { let _ = input.write_all(b"cancel\n"); }
            cancelling_at = Some(Instant::now());
        }
        if cancelling_at.is_some_and(|started: Instant| started.elapsed() >= Duration::from_secs(2)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Environment setup cancelled".into());
        }
        if let Ok(status) = completed_rx.try_recv() {
            // The wrapper has finished and stopped its cancellation watcher. Only
            // close the transport without signalling the script's process group.
            let _ = child.kill();
            let _ = child.wait();
            break status;
        }
        match child.try_wait() {
            Ok(Some(status)) => break completed_rx.recv_timeout(Duration::from_millis(100)).unwrap_or_else(|_| status.code().unwrap_or(1)),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => { drop(input); let _ = child.kill(); let _ = child.wait(); return Err(format!("{context}: {error}")); }
        }
    };
    drop(input);
    if cancelled.load(Ordering::SeqCst) { return Err("Environment setup cancelled".into()); }
    // Collect final diagnostics without waiting indefinitely on inherited descriptors.
    let _ = done_rx.recv_timeout(Duration::from_millis(100));
    let stderr = retained.lock().map_err(|_| "Setup output lock was poisoned")?.clone();
    Ok((status, stderr))
}

fn run_limited(command: &mut Command, max_stdout: usize, context: &str) -> Result<LimitedOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("{context}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{context}: stdout was unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{context}: stderr was unavailable"))?;
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr; let mut retained = Vec::new(); let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => { let remaining = (64 * 1024usize).saturating_sub(retained.len()); retained.extend_from_slice(&buffer[..count.min(remaining)]); }
            }
        }
        retained
    });
    let mut bytes = Vec::new(); stdout.take((max_stdout + 1) as u64).read_to_end(&mut bytes).map_err(|error| format!("{context}: {error}"))?;
    let oversized = bytes.len() > max_stdout;
    if oversized { let _ = child.kill(); }
    let status = child.wait().map_err(|error| format!("{context}: {error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if oversized { return Err(format!("{context}: output exceeded {} MiB", max_stdout / 1024 / 1024)); }
    Ok(LimitedOutput { status, stdout: bytes, stderr })
}

fn git_root_and_objects(cwd: &str) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let requested = Path::new(cwd).canonicalize().map_err(|error| format!("Could not open project directory: {error}"))?;
    let output = run_limited(Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel", "--git-path", "objects"]), 64 * 1024, "Could not locate Git repository")?;
    if !output.status.success() { return Ok(None); }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines().map(str::to_owned);
    let root = PathBuf::from(lines.next().unwrap_or_default()).canonicalize().map_err(|error| format!("Could not resolve Git root: {error}"))?;
    if root != requested { return Ok(None); }
    let objects = PathBuf::from(lines.next().unwrap_or_default());
    let objects = if objects.is_absolute() { objects } else { root.join(objects) }.canonicalize().map_err(|error| format!("Could not resolve Git objects: {error}"))?;
    Ok(Some((root, objects)))
}

fn local_git_input_is_bounded(cwd: &str, root: &Path) -> Result<bool, String> {
    let mut output = run_limited(Command::new("git").args(["-C", cwd, "ls-files", "-z", "-m", "-o", "--exclude-standard", "--"]), MAX_GIT_PATH_LIST_BYTES, "Could not inspect Git changes")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let staged = run_limited(Command::new("git").args(["-C", cwd, "diff", "--cached", "--name-only", "-z", "--"]), MAX_GIT_PATH_LIST_BYTES, "Could not inspect staged changes")?;
    if !staged.status.success() { return Err(String::from_utf8_lossy(&staged.stderr).into_owned()); } output.stdout.extend(staged.stdout);
    let mut seen = HashSet::new(); let mut total = 0u64; let mut count = 0usize;
    for raw in output.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
        if !seen.insert(raw) { continue; }
        count += 1; if count > MAX_GIT_CHANGED_PATHS { return Ok(false); }
        let relative = String::from_utf8_lossy(raw); let path = root.join(relative.as_ref());
        let Ok(metadata) = fs::symlink_metadata(path) else { continue };
        let size = metadata.len(); if size > MAX_GIT_FILE_BYTES { return Ok(false); }
        total = total.saturating_add(size); if total > MAX_GIT_SNAPSHOT_BYTES { return Ok(false); }
    }
    Ok(true)
}

fn local_snapshot_parent() -> Result<PathBuf, String> {
    let parent = home_dir()?.join(".piop/git-snapshots"); fs::create_dir_all(&parent).map_err(|error| error.to_string())?; Ok(parent)
}


fn parse_local_snapshot(token: &str) -> Result<GitSnapshotToken, String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(token).map_err(|_| "Invalid Git snapshot token".to_string())?;
    if snapshot.tree.len() < 40 || snapshot.tree.len() > 64 || !snapshot.tree.chars().all(|character| character.is_ascii_hexdigit()) { return Err("Invalid Git snapshot tree".into()); }
    let parent = local_snapshot_parent()?.canonicalize().map_err(|error| error.to_string())?;
    let root = PathBuf::from(&snapshot.root).canonicalize().map_err(|_| "Git snapshot expired".to_string())?;
    if root.parent() != Some(parent.as_path()) || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-")) { return Err("Invalid Git snapshot location".into()); }
    Ok(GitSnapshotToken { root: root.to_string_lossy().into_owned(), tree: snapshot.tree })
}

fn local_git_tree(cwd: &str) -> Result<Option<String>, String> {
    let Some((root, repository_objects)) = git_root_and_objects(cwd)? else { return Ok(None) };
    if !local_git_input_is_bounded(cwd, &root)? { return Ok(None); }
    let snapshot_parent = local_snapshot_parent()?;
    let snapshot_root = snapshot_parent.join(format!("pi-desktop-diff-{}", Uuid::new_v4()));
    let objects = snapshot_root.join("objects"); let index = snapshot_root.join("index");
    let seed = run_limited(Command::new("git").args(["-C", cwd, "write-tree"]), 64 * 1024, "Could not read project index")?;
    if !seed.status.success() { return Err(String::from_utf8_lossy(&seed.stderr).into_owned()); }
    let seed = String::from_utf8_lossy(&seed.stdout).trim().to_owned();
    fs::create_dir_all(&objects).map_err(|error| format!("Could not create Git snapshot: {error}"))?;
    let result = (|| {
        let configure = |command: &mut Command| { command.env("GIT_INDEX_FILE", &index).env("GIT_OBJECT_DIRECTORY", &objects).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &repository_objects); };
        let mut read_tree = Command::new("git"); read_tree.args(["-C", cwd, "read-tree", &seed]); configure(&mut read_tree);
        let output = run_limited(&mut read_tree, 64 * 1024, "Could not prepare Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let mut add = Command::new("git"); add.args(["-C", cwd, "add", "-A", "--", "."]); configure(&mut add);
        let output = run_limited(&mut add, 64 * 1024, "Could not capture Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let mut write_tree = Command::new("git"); write_tree.args(["-C", cwd, "write-tree"]); configure(&mut write_tree);
        let output = run_limited(&mut write_tree, 64 * 1024, "Could not finalize Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let tree = String::from_utf8_lossy(&output.stdout).trim().to_string();
        serde_json::to_string(&GitSnapshotToken { root: snapshot_root.to_string_lossy().into_owned(), tree }).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&snapshot_root); }
    result.map(Some)
}

fn local_git_diff(cwd: &str, base_token: &str) -> Result<Option<String>, String> {
    let base = parse_local_snapshot(base_token)?;
    let Some(current_token) = local_git_tree(cwd)? else { let _ = fs::remove_dir_all(&base.root); return Ok(None) };
    let current = parse_local_snapshot(&current_token)?;
    let result = (|| {
        let Some((_, repository_objects)) = git_root_and_objects(cwd)? else { return Ok(None) };
        let alternates = std::env::join_paths([Path::new(&base.root).join("objects"), repository_objects]).map_err(|error| error.to_string())?;
        let mut command = Command::new("git"); command.args(["-C", cwd, "diff", "--no-color", "--no-ext-diff", "--find-renames", &base.tree, &current.tree, "--"])
            .env("GIT_OBJECT_DIRECTORY", Path::new(&current.root).join("objects")).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates);
        let output = run_limited(&mut command, MAX_GIT_PATCH_BYTES, "Git patch is too large")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let patch = String::from_utf8_lossy(&output.stdout).into_owned(); Ok((!patch.trim().is_empty()).then_some(patch))
    })();
    let _ = fs::remove_dir_all(&base.root); let _ = fs::remove_dir_all(&current.root); result
}

#[tauri::command(async)]
fn is_git_repository(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<bool, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let output = if host_id == "local" {
        Command::new("git").args(["-C", &cwd, "rev-parse", "--git-dir"]).output().map_err(|error| format!("Could not inspect project Git repository: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        ssh(host).arg(format!("git -C {} rev-parse --git-dir", shell_quote(&cwd))).output().map_err(|error| format!("Could not inspect Git repository on {}: {error}", host.name))?
    };
    Ok(output.status.success())
}

#[tauri::command(async)]
fn git_branch(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let output = if host_id == "local" {
        Command::new("git").args(["-C", &cwd, "rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|error| format!("Could not read project Git branch: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        ssh(host).arg(format!("git -C {} rev-parse --abbrev-ref HEAD", shell_quote(&cwd))).output().map_err(|error| format!("Could not read Git branch on {}: {error}", host.name))?
    };
    if !output.status.success() { return Ok(None); }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!branch.is_empty()).then_some(branch))
}

fn worktree_suffix(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Name can't be empty".into()); }
    if !name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')) { return Err("Name may only contain letters, numbers, dots, hyphens, and underscores".into()); }
    Ok(name)
}

fn worktree_branch_name(project: &str, name: &str) -> String {
    let mut prefix = String::new();
    let mut separator = false;
    for character in project.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            if separator && !prefix.is_empty() { prefix.push('-'); }
            prefix.push(character);
            separator = false;
        } else { separator = true; }
    }
    if prefix.is_empty() { prefix.push_str("project"); }
    format!("{prefix}-{name}")
}

fn parse_worktree_output(output: LimitedOutput, context: &str) -> Result<GitWorktree, String> {
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { context.into() } else { error });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let branch = lines.next().unwrap_or_default().to_string();
    let path = lines.next().unwrap_or_default().to_string();
    if branch.is_empty() || path.is_empty() { return Err(format!("{context}: Git returned an incomplete result")); }
    Ok(GitWorktree { branch, path })
}

fn copy_untracked_file(source_root: &Path, target_root: &Path, relative: &Path) -> Result<(), String> {
    if !relative.components().all(|component| matches!(component, std::path::Component::Normal(_))) { return Err("Git returned an invalid untracked path".into()); }
    let source = source_root.join(relative); let target = target_root.join(relative);
    let metadata = fs::symlink_metadata(&source).map_err(|error| format!("Could not inspect untracked file {}: {error}", relative.display()))?;
    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not prepare untracked file {}: {error}", relative.display()))?; }
    if metadata.file_type().is_symlink() {
        let link = fs::read_link(&source).map_err(|error| format!("Could not read untracked symlink {}: {error}", relative.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, &target).map_err(|error| format!("Could not copy untracked symlink {}: {error}", relative.display()))?;
        #[cfg(windows)]
        if source.is_dir() { std::os::windows::fs::symlink_dir(link, &target) } else { std::os::windows::fs::symlink_file(link, &target) }.map_err(|error| format!("Could not copy untracked symlink {}: {error}", relative.display()))?;
        #[cfg(not(any(unix, windows)))]
        return Err(format!("Copying untracked symlinks is unsupported on this platform: {}", relative.display()));
    } else if metadata.is_file() {
        fs::copy(&source, &target).map_err(|error| format!("Could not copy untracked file {}: {error}", relative.display()))?;
    } else if metadata.is_dir() {
        fs::create_dir_all(&target).map_err(|error| format!("Could not prepare untracked directory {}: {error}", relative.display()))?;
        for entry in fs::read_dir(&source).map_err(|error| format!("Could not read untracked directory {}: {error}", relative.display()))? {
            let entry = entry.map_err(|error| format!("Could not read untracked directory {}: {error}", relative.display()))?;
            // Nested repositories are copied as files, never with Git metadata pointing at the source.
            if entry.file_name() == ".git" { continue; }
            copy_untracked_file(source_root, target_root, &relative.join(entry.file_name()))?;
        }
    } else { return Err(format!("Unsupported untracked filesystem entry: {}", relative.display())); }
    Ok(())
}

#[cfg(unix)]
fn git_relative_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
fn git_relative_path(bytes: &[u8]) -> PathBuf { PathBuf::from(String::from_utf8_lossy(bytes).into_owned()) }

fn remove_created_worktree(root: &Path, target: &Path, branch: &str) {
    let _ = Command::new("git").arg("-C").arg(root).args(["worktree", "remove", "--force"]).arg(target).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = Command::new("git").arg("-C").arg(root).args(["branch", "-D", branch]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn local_branch_exists(root: &Path, branch: &str) -> Result<bool, String> {
    let reference = format!("refs/heads/{branch}");
    let status = Command::new("git").arg("-C").arg(root).args(["show-ref", "--verify", "--quiet", &reference]).status().map_err(|error| format!("Could not inspect Git branches: {error}"))?;
    match status.code() { Some(0) => Ok(true), Some(1) => Ok(false), _ => Err("Could not inspect Git branches".into()) }
}

fn local_worktree_is_registered(root: &Path, target: &Path) -> Result<bool, String> {
    let output = run_limited(Command::new("git").arg("-C").arg(root).args(["worktree", "list", "--porcelain", "-z"]), 1024 * 1024, "Could not inspect Git worktrees")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let prefix = "worktree "; let target = target.to_string_lossy();
    Ok(output.stdout.split(|byte| *byte == 0).any(|field| String::from_utf8_lossy(field).strip_prefix(prefix).is_some_and(|path| path == target)))
}

#[tauri::command(async)]
fn create_project_worktree(app: AppHandle, cwd: String, name: String, host_id: Option<String>) -> Result<GitWorktree, String> {
    let name = worktree_suffix(&name)?;
    let settings = load_app_settings(app)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    let host = if host_id == "local" { None } else { Some(remote_host(&settings, host_id)?) };
    let located = if let Some(host) = host {
        run_limited(ssh(host).arg(format!("git -C {} rev-parse --show-toplevel", shell_quote(&cwd))), 64 * 1024, "Could not locate Git repository")?
    } else {
        run_limited(Command::new("git").args(["-C", &cwd, "rev-parse", "--show-toplevel"]), 64 * 1024, "Could not locate Git repository")?
    };
    if !located.status.success() { return Err("Project is not a Git repository".into()); }
    let root = PathBuf::from(String::from_utf8_lossy(&located.stdout).trim());
    let project = root.file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
    let branch = worktree_branch_name(&project, name);
    let target = root.parent().ok_or("Git repository has no parent directory")?.join(&branch);
    let output = if let Some(host) = host {
        run_limited(ssh(host).arg(format!("git -C {} worktree add -b {} {} HEAD", shell_quote(&root.to_string_lossy()), shell_quote(&branch), shell_quote(&target.to_string_lossy()))), 64 * 1024, "Could not create Git worktree")?
    } else {
        run_limited(Command::new("git").arg("-C").arg(&root).args(["worktree", "add", "-b", &branch]).arg(&target).arg("HEAD"), 64 * 1024, "Could not create Git worktree")?
    };
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not create Git worktree".into() } else { error });
    }
    Ok(GitWorktree { branch, path: target.to_string_lossy().into_owned() })
}

#[tauri::command(async)]
fn create_git_worktree(app: AppHandle, cwd: String, name: String, host_id: Option<String>) -> Result<GitWorktree, String> {
    let name = worktree_suffix(&name)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, host_id)?;
        let locate = format!("root=$(git -C {} rev-parse --show-toplevel 2>/dev/null) || exit 3; cd \"$root\" && pwd -P", shell_quote(&cwd));
        let located = run_limited(ssh(host).arg(locate), 64 * 1024, &format!("Could not locate Git repository on {}", host.name))?;
        if !located.status.success() {
            if located.status.code() == Some(3) { return Err("Project is not a Git repository".into()); }
            let error = String::from_utf8_lossy(&located.stderr).trim().to_string();
            return Err(if error.is_empty() { format!("Could not locate Git repository on {}", host.name) } else { error });
        }
        let root = String::from_utf8_lossy(&located.stdout).trim().to_string();
        let project = Path::new(&root).file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
        let branch = worktree_branch_name(&project, name);
        let script = format!(r#"root={root}; branch={branch}; git check-ref-format --branch "$branch" >/dev/null || {{ printf 'Invalid Git branch name: %s' "$branch" >&2; exit 1; }}; git -C "$root" show-ref --verify --quiet "refs/heads/$branch" && {{ printf 'Git branch already exists: %s' "$branch" >&2; exit 1; }}; [ $? -eq 1 ] || {{ printf 'Could not inspect Git branches' >&2; exit 1; }}; parent=$(dirname -- "$root"); target="$parent/$branch"; if [ -e "$target" ] || [ -L "$target" ]; then printf 'Worktree directory already exists: %s' "$target" >&2; exit 1; fi; worktrees=$(git -C "$root" worktree list --porcelain) || {{ printf 'Could not inspect Git worktrees' >&2; exit 1; }}; printf '%s\n' "$worktrees" | grep -Fqx "worktree $target" && {{ printf 'Git worktree is already registered: %s' "$target" >&2; exit 1; }}; [ $? -eq 1 ] || {{ printf 'Could not inspect Git worktrees' >&2; exit 1; }}; temporary=$(mktemp -d "${{TMPDIR:-/tmp}}/pi-desktop-worktree.XXXXXX") || exit 1; created=0; cleanup() {{ status=$?; rm -rf -- "$temporary"; if [ "$status" -ne 0 ] && [ "$created" -eq 1 ]; then git -C "$root" worktree remove --force "$target" >/dev/null 2>&1; git -C "$root" branch -D "$branch" >/dev/null 2>&1; fi; exit "$status"; }}; trap cleanup EXIT; has_head=0; if git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1; then has_head=1; fi; : > "$temporary/changes.patch"; if [ "$has_head" -eq 1 ]; then mkfifo "$temporary/patch.pipe" || exit 1; git -C "$root" diff --binary --no-textconv --no-ext-diff HEAD -- > "$temporary/patch.pipe" 2> "$temporary/diff-error" & diff_pid=$!; head -c {patch_plus_one} < "$temporary/patch.pipe" > "$temporary/changes.patch"; wait "$diff_pid"; diff_status=$?; rm -f -- "$temporary/patch.pipe"; patch_bytes=$(wc -c < "$temporary/changes.patch"); [ "$patch_bytes" -le {max_patch} ] || {{ printf 'Git changes are too large to copy' >&2; exit 1; }}; [ "$diff_status" -eq 0 ] || {{ cat "$temporary/diff-error" >&2; printf 'Could not capture Git changes' >&2; exit 1; }}; fi; git -C "$root" ls-files -z --others --exclude-standard $(test "$has_head" -eq 0 && printf %s --cached) -- > "$temporary/untracked" || exit 1; created=1; if [ "$has_head" -eq 1 ]; then git -C "$root" worktree add -b "$branch" "$target" >/dev/null || exit 1; else git -C "$root" worktree add --orphan -b "$branch" "$target" >/dev/null || exit 1; fi; created=1; if [ -s "$temporary/changes.patch" ]; then git -C "$target" apply --whitespace=nowarn "$temporary/changes.patch" || exit 1; fi; if [ -s "$temporary/untracked" ]; then tar -C "$root" --exclude=.git --null -T "$temporary/untracked" -cf "$temporary/untracked.tar" || exit 1; tar -C "$target" -xf "$temporary/untracked.tar" || exit 1; fi; printf '%s\n%s\n' "$branch" "$target""#,
            root = shell_quote(&root), branch = shell_quote(&branch),
            patch_plus_one = MAX_GIT_PATCH_BYTES + 1, max_patch = MAX_GIT_PATCH_BYTES);
        let output = run_limited(ssh(host).arg(script), 64 * 1024, &format!("Could not create Git worktree on {}", host.name))?;
        return parse_worktree_output(output, "Could not create Git worktree");
    }

    let root_output = run_limited(Command::new("git").args(["-C", &cwd, "rev-parse", "--show-toplevel"]), 64 * 1024, "Could not locate Git repository")?;
    if !root_output.status.success() { return Err("Project is not a Git repository".into()); }
    let root = PathBuf::from(String::from_utf8_lossy(&root_output.stdout).trim()).canonicalize().map_err(|error| format!("Could not resolve Git repository: {error}"))?;
    let project = root.file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
    let branch = worktree_branch_name(&project, name);
    let valid = Command::new("git").args(["check-ref-format", "--branch", &branch]).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| format!("Could not validate Git branch: {error}"))?;
    if !valid.success() { return Err(format!("Invalid Git branch name: {branch}")); }
    if local_branch_exists(&root, &branch)? { return Err(format!("Git branch already exists: {branch}")); }
    let parent = root.parent().ok_or("Git repository has no parent directory")?;
    let target = parent.join(&branch);
    if fs::symlink_metadata(&target).is_ok() { return Err(format!("Worktree directory already exists: {}", target.display())); }
    if local_worktree_is_registered(&root, &target)? { return Err(format!("Git worktree is already registered: {}", target.display())); }
    let has_head = Command::new("git").arg("-C").arg(&root).args(["rev-parse", "--verify", "HEAD"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| format!("Could not inspect Git HEAD: {error}"))?.success();
    let patch = if has_head {
        let output = run_limited(Command::new("git").arg("-C").arg(&root).args(["diff", "--binary", "--no-textconv", "--no-ext-diff", "HEAD", "--"]), MAX_GIT_PATCH_BYTES, "Git changes are too large to copy")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        output.stdout
    } else { Vec::new() };
    let mut files = Command::new("git"); files.arg("-C").arg(&root).args(["ls-files", "-z", "--others", "--exclude-standard"]); if !has_head { files.arg("--cached"); } files.arg("--");
    let untracked = run_limited(&mut files, MAX_GIT_PATH_LIST_BYTES, "Untracked file list is too large to copy")?;
    if !untracked.status.success() { return Err(String::from_utf8_lossy(&untracked.stderr).trim().to_string()); }
    let mut add_worktree = Command::new("git"); add_worktree.arg("-C").arg(&root).args(["worktree", "add"]);
    if !has_head { add_worktree.arg("--orphan"); }
    add_worktree.args(["-b", &branch]).arg(&target);
    let output = run_limited(&mut add_worktree, 64 * 1024, "Could not create Git worktree")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if local_worktree_is_registered(&root, &target).unwrap_or(false) { let _ = Command::new("git").arg("-C").arg(&root).args(["worktree", "remove", "--force"]).arg(&target).status(); }
        let _ = Command::new("git").arg("-C").arg(&root).args(["branch", "-D", &branch]).status();
        return Err(if error.is_empty() { "Could not create Git worktree".into() } else { error });
    }
    let copy_result = (|| {
        if !patch.is_empty() {
            let patch_path = std::env::temp_dir().join(format!("pi-desktop-worktree-{}.patch", Uuid::new_v4()));
            fs::write(&patch_path, &patch).map_err(|error| format!("Could not prepare Git changes for copying: {error}"))?;
            let applied = run_limited(Command::new("git").arg("-C").arg(&target).args(["apply", "--whitespace=nowarn"]).arg(&patch_path), 64 * 1024, "Could not copy Git changes");
            let _ = fs::remove_file(&patch_path);
            let applied = applied?;
            if !applied.status.success() { return Err(String::from_utf8_lossy(&applied.stderr).trim().to_string()); }
        }
        for raw in untracked.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
            copy_untracked_file(&root, &target, &git_relative_path(raw))?;
        }
        Ok(())
    })();
    if let Err(error) = copy_result { remove_created_worktree(&root, &target, &branch); return Err(error); }
    Ok(GitWorktree { branch, path: target.to_string_lossy().into_owned() })
}

fn valid_remote_snapshot(snapshot: &GitSnapshotToken) -> bool {
    let path = Path::new(&snapshot.root);
    path.is_absolute()
        && path.components().all(|component| matches!(component, std::path::Component::RootDir | std::path::Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-"))
        && snapshot.tree.len() >= 40 && snapshot.tree.len() <= 64 && snapshot.tree.chars().all(|character| character.is_ascii_hexdigit())
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let script = format!("cd {} && node -e {}", shell_quote(cwd), shell_quote(include_str!("../resources/capture-git-tree.cjs")));
    let mut command = ssh(host); command.arg(remote_login_command(&script)); let output = run_limited(&mut command, 64 * 1024, &format!("Could not capture Git snapshot on {}", host.name))?;
    match output.status.code() { Some(3 | 4 | 6) => return Ok(None), _ => {} }
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines().map(str::to_owned);
    let snapshot = GitSnapshotToken { root: lines.next().unwrap_or_default(), tree: lines.next().unwrap_or_default() };
    if !valid_remote_snapshot(&snapshot) { return Err("Remote Git snapshot was invalid".into()); }
    serde_json::to_string(&snapshot).map(Some).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn capture_git_tree(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); if host_id == "local" { return local_git_tree(&cwd); }
    let settings = load_app_settings(app)?; remote_git_tree(remote_host(&settings, &host_id)?, &cwd)
}

#[tauri::command(async)]
fn discard_git_tree(app: AppHandle, snapshot: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { let snapshot = parse_local_snapshot(&snapshot)?; return fs::remove_dir_all(snapshot.root).map_err(|error| format!("Could not discard Git snapshot: {error}")); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let snapshot: GitSnapshotToken = serde_json::from_str(&snapshot).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&snapshot) { return Err("Invalid remote Git snapshot location".into()); }
    let root = shell_quote(&snapshot.root);
    let script = format!("parent=$(cd \"$HOME/.piop/git-snapshots\" && pwd -P) || exit 7; snap=$(cd {root} && pwd -P) || exit 7; [ \"$(dirname -- \"$snap\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snap\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; rm -rf -- \"$snap\"");
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not discard Git snapshot on {}: {error}", host.name))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[tauri::command(async)]
fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { return local_git_diff(&cwd, &base_tree); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let base: GitSnapshotToken = serde_json::from_str(&base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) { return Err("Invalid remote Git snapshot location".into()); }
    let Some(current_token) = remote_git_tree(host, &cwd)? else { return Ok(None) };
    let current: GitSnapshotToken = serde_json::from_str(&current_token).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    let script = format!("cd {} || exit 2; parent=$(cd \"$HOME/.piop/git-snapshots\" && pwd -P) || exit 7; base=$(cd {} && pwd -P) || exit 7; [ \"$(dirname -- \"$base\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$base\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; trap 'rm -rf -- \"$base\" {}' EXIT; repo_objects=$(git rev-parse --git-path objects) || exit 3; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 3; GIT_OBJECT_DIRECTORY={} GIT_ALTERNATE_OBJECT_DIRECTORIES=\"$base/objects:$repo_objects\" git diff --no-color --no-ext-diff --find-renames {} {} --", shell_quote(&cwd), shell_quote(&base.root), shell_quote(&current.root), shell_quote(&format!("{}/objects", current.root)), shell_quote(&base.tree), shell_quote(&current.tree));
    let mut command = ssh(host); command.arg(script); let output = run_limited(&mut command, MAX_GIT_PATCH_BYTES, &format!("Git patch on {} is too large", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(patch))
}

fn local_git_diffs_path(session_path: &str) -> Result<PathBuf, String> { Ok(local_desktop_session_file(session_path)?.with_extension("diffs.json")) }

fn remote_session_sidecar_script(session_path: &str, action: &str) -> String {
    format!("session=$(readlink -f -- {}) || exit 7; sessions=$(cd \"$HOME/.piop/sessions\" && pwd -P) || exit 7; case \"$session\" in \"$sessions\"/*.jsonl) ;; *) exit 7;; esac; sidecar=${{session%.jsonl}}.diffs.json; {action}", shell_quote(session_path))
}

#[tauri::command(async)]
fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<GitDiffSnapshots, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let content = if host_id == "local" {
        let candidate = PathBuf::from(&session_path);
        if !candidate.exists() {
            let root = ensure_desktop_sessions_dir(&home_dir()?)?.canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
            let parent = candidate.parent().ok_or("Session path has no parent directory")?.canonicalize().map_err(|error| format!("Could not locate session directory: {error}"))?;
            if !candidate.is_absolute() || !parent.starts_with(&root) || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") { return Err("Only piop session files can be accessed".into()); }
            return Ok(HashMap::new());
        }
        let path = local_git_diffs_path(&session_path)?;
        if !path.exists() { return Ok(HashMap::new()); }
        if fs::metadata(&path).map_err(|error| format!("Could not inspect saved diffs: {error}"))?.len() > MAX_GIT_DIFFS_BYTES as u64 { return Err("Saved diffs exceed the 16 MiB limit".into()); }
        fs::read_to_string(&path).map_err(|error| format!("Could not read saved diffs: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let mut command = ssh(host); command.arg(remote_session_sidecar_script(&session_path, "if [ -f \"$sidecar\" ]; then cat -- \"$sidecar\"; else printf '{}'; fi"));
        let output = run_limited(&mut command, MAX_GIT_DIFFS_BYTES, &format!("Saved diffs on {} exceed the limit", host.name))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Saved remote diffs were not valid UTF-8".to_string())?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

#[tauri::command(async)]
fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let body = serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?;
    if body.len() > MAX_GIT_DIFFS_BYTES { return Err("Diff history exceeds the 16 MiB limit".into()); }
    if host_id == "local" { return atomic_write_private(&local_git_diffs_path(&session_path)?, body.as_bytes()).map_err(|error| format!("Could not save diffs: {error}")); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let action = "umask 077; temporary=$(mktemp \"$sidecar.XXXXXX\") || exit 1; trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\" && chmod 600 -- \"$temporary\" && mv -f -- \"$temporary\" \"$sidecar\"";
    let mut child = ssh(host).arg(remote_session_sidecar_script(&session_path, action)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let write = child.stdin.take().ok_or("SSH stdin unavailable")?.write_all(body.as_bytes());
    let output = child.wait_with_output().map_err(|e| e.to_string())?; write.map_err(|e| e.to_string())?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

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

fn user_ssh_config() -> Option<PathBuf> { home_dir().ok().map(|home| home.join(".ssh/config")).filter(|path| path.is_file()) }

fn remote_login_command(command: &str) -> String { format!("bash -lc {}", shell_quote(command)) }

fn ssh_base() -> Command {
    let mut command = Command::new("ssh");
    if let Some(config) = user_ssh_config() { command.arg("-F").arg(config); }
    command.args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5"]); command
}

fn ssh(host: &RemoteHost) -> Command {
    let mut command = ssh_base(); command.arg(&host.target); command
}

fn remote_pi_path(path: &str) -> String {
    if path == "pi" { return "\"$(bash -lc 'command -v pi')\"".into(); }
    path.strip_prefix("~/").map(|rest| format!("$HOME/{}", rest)).unwrap_or_else(|| shell_quote(path))
}

fn remote_directory_path(path: Option<&str>) -> String {
    match path.map(str::trim).filter(|path| !path.is_empty()) {
        None | Some("~") => "\"$HOME\"".into(),
        Some(path) if path.starts_with("~/") => format!("$HOME/{}", shell_quote(&path[2..])),
        Some(path) => shell_quote(path),
    }
}

fn remove_ephemeral_session(session: EphemeralSession) {
    match session {
        EphemeralSession::Local(path) => { let _ = fs::remove_file(path); }
        EphemeralSession::Remote { host, path } => { let _ = ssh(&host).arg(format!("rm -f -- {}", shell_quote(&path))).status(); }
    }
}

fn create_ephemeral_fork(settings: &AppSettings, host_id: &str, source_path: &str) -> Result<(String, EphemeralSession), String> {
    if host_id == "local" {
        let source = local_desktop_session_file(source_path)?;
        let path = std::env::temp_dir().join(format!("pi-desktop-btw-{}.jsonl", Uuid::new_v4()));
        let output = Command::new("node").args(["-e", include_str!("../resources/fork-session.cjs")]).arg(source).arg(&path).arg(Uuid::new_v4().to_string()).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        return Ok((path.to_string_lossy().into_owned(), EphemeralSession::Local(path)));
    }
    let host = remote_host(settings, host_id)?.clone();
    let destination = format!("/tmp/pi-desktop-btw-{}.jsonl", Uuid::new_v4());
    let remote = format!("node -e {} {} {} {} && printf %s {}", shell_quote(include_str!("../resources/fork-session.cjs")), shell_quote(source_path), shell_quote(&destination), shell_quote(&Uuid::new_v4().to_string()), shell_quote(&destination));
    let output = ssh(&host).arg(remote_login_command(&remote)).output().map_err(|error| format!("Could not create temporary side conversation on {}: {error}", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("Temporary side conversation path was unavailable".into()); }
    Ok((path.clone(), EphemeralSession::Remote { host, path }))
}

fn enabled_tool_names(settings: &AppSettings) -> Vec<&str> {
    settings.tools.iter().filter(|tool| tool.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect()
}

fn broker_environment(broker: &BrokerRuntime) -> Result<(u16, String), String> {
    let port = *broker.port.lock().map_err(|_| "Session broker lock was poisoned")?;
    if port == 0 { return Err("Session broker is not ready".into()); }
    Ok((port, broker.token.clone()))
}

fn claim_agent(broker: &BrokerRuntime, host_id: &str, session_id: &str) -> Result<BusyAgent, String> {
    let key = format!("{host_id}\0{session_id}");
    let mut busy = broker.busy.lock().map_err(|_| "Session broker lock was poisoned")?;
    if !busy.insert(key.clone()) { return Err(format!("Agent {host_id}/{session_id} is already responding")); }
    Ok(BusyAgent { key, busy: broker.busy.clone() })
}

fn remote_broker_port() -> u16 {
    let bytes = Uuid::new_v4(); let bytes = bytes.as_bytes();
    20_000 + (u16::from_be_bytes([bytes[0], bytes[1]]) % 30_000)
}

fn remote_broker_command(host: &RemoteHost, local_port: u16, remote_port: u16) -> Command {
    let mut command = ssh_base();
    command.args(["-o", "ExitOnForwardFailure=yes", "-R", &format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}"), &host.target]);
    command
}

fn stage_remote_extensions(host: &RemoteHost, settings: &AppSettings) -> Result<(), String> {
    let disable = format!("if [ -f \"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\" ]; then mkdir -p -m 700 \"$HOME/.piop/disabled-extensions\" && mv -- \"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\" \"$HOME/.piop/disabled-extensions/pi-orchestration-{}.ts\"; fi", Uuid::new_v4());
    let output = ssh(host).arg(disable).output().map_err(|error| format!("Could not disable legacy orchestration on {}: {error}", host.name))?;
    if !output.status.success() { return Err(format!("Could not disable legacy orchestration on {}: {}", host.name, String::from_utf8_lossy(&output.stderr))); }
    let runtime_settings_extension = shell_quote(include_str!("../../extensions/pi-runtime-settings/index.ts"));
    let runtime_settings_config = shell_quote(&serde_json::to_string(&runtime_settings(settings)).map_err(|error| error.to_string())?);
    let hook_stats = shell_quote(include_str!("../../extensions/piop-hooks/hook-stats.ts"));
    let hooks = shell_quote(include_str!("../../extensions/piop-hooks/index.ts"));
    let broker = shell_quote(include_str!("../resources/session-broker.ts"));
    let trace_reader = shell_quote(include_str!("../resources/trace-reader.ts"));
    let btw = shell_quote(include_str!("../resources/btw.ts"));
    let defined_agents = shell_quote(include_str!("../../extensions/pi-define-agents/index.ts"));
    let context_window_cap = shell_quote(include_str!("../../extensions/pi-context-window-cap/index.ts"));
    let codex_web_search = shell_quote(include_str!("../../extensions/pi-codex-web-search/index.ts"));
    let codex_compaction = shell_quote(include_str!("../resources/codex-compaction.bundle.mjs"));
    let fast_mode = shell_quote(include_str!("../resources/fast-mode.bundle.mjs"));
    let project_files_watch = shell_quote(include_str!("../../extensions/pi-project-files-watch/index.ts"));
    let context_window_config = shell_quote(&serde_json::to_string_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?);
    let mcp_bridge = shell_quote(include_str!("../resources/mcp-bridge.bundle.mjs"));
    let mcp_config = shell_quote(&serde_json::to_string_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?);
    let remote = format!("umask 077 && rm -rf -- \"$HOME/.piop/pi-git-change-context\" && mkdir -p -m 700 \"$HOME/.piop/sessions\" \"$HOME/.piop/pi-context-window-cap\" \"$HOME/.piop/pi-project-files-watch\" \"$HOME/.piop/pi-define-agents\" && chmod 700 \"$HOME/.piop\" \"$HOME/.piop/sessions\" \"$HOME/.piop/pi-context-window-cap\" \"$HOME/.piop/pi-project-files-watch\" \"$HOME/.piop/pi-define-agents\" && mkdir -p -m 700 \"$HOME/.piop/hooks\" && printf %s {hook_stats} > \"$HOME/.piop/hook-stats.ts\" && printf %s {hooks} > \"$HOME/.piop/hook-loader.ts\" && printf %s {broker} > \"$HOME/.piop/session-broker.ts\" && printf %s {trace_reader} > \"$HOME/.piop/pi-desktop-trace-reader.ts\" && printf %s {mcp_bridge} > \"$HOME/.piop/pi-desktop-mcp-bridge.ts\" && printf %s {mcp_config} > \"$HOME/.piop/mcp-servers.json\" && printf %s {context_window_cap} > \"$HOME/.piop/pi-context-window-cap/index.ts\" && printf %s {context_window_config} > \"$HOME/.piop/pi-context-window-cap/config.json\" && printf %s {project_files_watch} > \"$HOME/.piop/pi-project-files-watch/index.ts\" && printf %s {codex_web_search} > \"$HOME/.piop/pi-desktop-codex-web-search.ts\" && printf %s {codex_compaction} > \"$HOME/.piop/pi-desktop-codex-compaction.ts\" && printf %s {btw} > \"$HOME/.piop/pi-desktop-btw.ts\" && printf %s {defined_agents} > \"$HOME/.piop/pi-define-agents/index.ts\" && chmod 600 -- \"$HOME/.piop/pi-desktop-codex-web-search.ts\" \"$HOME/.piop/pi-desktop-codex-compaction.ts\" \"$HOME/.piop/session-broker.ts\" \"$HOME/.piop/pi-desktop-trace-reader.ts\" \"$HOME/.piop/pi-desktop-mcp-bridge.ts\" \"$HOME/.piop/mcp-servers.json\" \"$HOME/.piop/pi-context-window-cap/index.ts\" \"$HOME/.piop/pi-context-window-cap/config.json\" \"$HOME/.piop/pi-project-files-watch/index.ts\" \"$HOME/.piop/pi-desktop-btw.ts\" \"$HOME/.piop/pi-define-agents/index.ts\"");
    let remote = format!(r#"{remote} && if [ ! -f "$HOME/.piop/pi-define-agents/config.json" ] && [ -f "$HOME/.pi/agent/extensions/pi-define-agents/config.json" ]; then cp "$HOME/.pi/agent/extensions/pi-define-agents/config.json" "$HOME/.piop/pi-define-agents/config.json"; fi && if [ ! -f "$HOME/.piop/pi-define-agents/config.json" ] && [ -f "$HOME/.pi/agent/extensions/pi-orchestration/config.json" ]; then cp "$HOME/.pi/agent/extensions/pi-orchestration/config.json" "$HOME/.piop/pi-define-agents/config.json"; fi && rm -f -- "$HOME/.pi/agent/extensions/pi-define-agents/index.ts" "$HOME/.pi/agent/extensions/pi-desktop-btw.ts""#);
    let remote = format!(r#"{remote} && mkdir -p -m 700 "$HOME/.piop/pi-openai-fast-mode-piop" && printf %s {fast_mode} > "$HOME/.piop/pi-openai-fast-mode-piop/index.ts" && chmod 600 "$HOME/.piop/pi-openai-fast-mode-piop/index.ts""#);
    let remote = format!(r#"{remote} && printf %s {runtime_settings_extension} > "$HOME/.piop/runtime-settings.ts" && printf %s {runtime_settings_config} > "$HOME/.piop/runtime-settings.json" && chmod 600 "$HOME/.piop/runtime-settings.ts" "$HOME/.piop/runtime-settings.json""#);
    // Bundled extensions can exceed the OS limit for a single command argument.
    let mut child = ssh(host).arg("sh -s").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("Could not install piop extensions on {}: {error}", host.name))?;
    let mut stdin = child.stdin.take().ok_or("Remote extension staging stdin was unavailable")?;
    let writer = thread::spawn(move || stdin.write_all(remote.as_bytes()));
    let output = child.wait_with_output().map_err(|error| format!("Could not install piop extensions on {}: {error}", host.name))?;
    let written = writer.join().map_err(|_| "Remote extension staging writer failed")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    written.map_err(|error| format!("Could not send piop extensions to {}: {error}", host.name))
}

enum PiLaunch<'a> {
    Rpc { cwd: Option<&'a str>, session_path: Option<&'a str>, session_id: Option<&'a str>, fork_path: Option<&'a str>, no_session: bool },
    Print { cwd: &'a str, session_path: &'a str },
}

fn build_pi_command(broker: &BrokerRuntime, settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>) -> Result<Command, String> {
    let (broker_port, broker_token) = broker_environment(broker)?;
    let desktop_home = home_dir()?;
    let is_rpc = matches!(launch, PiLaunch::Rpc { .. });
    let default_model = std::env::var("PI_DESKTOP_E2E_MODEL").ok().filter(|model| !model.trim().is_empty()).unwrap_or_else(|| settings.default_model.clone());
    if host_id == "local" {
        let (mcp_extension, mcp_config) = prepare_mcp_bridge(settings)?; let context_window_cap_extension = prepare_context_window_cap_extension(settings)?; let project_files_watch_extension = prepare_project_files_watch_extension()?; let trace_reader_extension = prepare_trace_reader()?; let codex_compaction_extension = prepare_codex_compaction_extension()?; let codex_web_search_extension = prepare_codex_web_search_extension()?; let defined_agents_extension = prepare_defined_agents_extension()?; let pi_path = pi_executable();
        let session_dir = ensure_desktop_sessions_dir(&desktop_home)?;
        let mut command = Command::new(&pi_path); command.arg(if is_rpc { "--mode" } else { "--print" }); if is_rpc { command.arg("rpc"); }
        command.arg("--extension").arg(prepare_runtime_settings(settings)?).arg("--session-dir").arg(session_dir).arg("--approve").arg("--no-skills").arg("--extension").arg(prepare_hooks_extension()?).arg("--extension").arg(mcp_extension).arg("--extension").arg(prepare_session_broker()?).arg("--extension").arg(&trace_reader_extension).arg("--extension").arg(&context_window_cap_extension).arg("--extension").arg(&project_files_watch_extension).arg("--extension").arg(prepare_fast_mode_extension()?).arg("--extension").arg(&codex_compaction_extension).arg("--extension").arg(&codex_web_search_extension).arg("--extension").arg(&defined_agents_extension)
            .env("PI_DESKTOP_DEFINED_AGENTS_EXTENSION", &defined_agents_extension).env("PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION", &codex_web_search_extension).env("PI_DESKTOP_CODEX_COMPACTION_EXTENSION", &codex_compaction_extension).env("PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION", &context_window_cap_extension).env("PI_DESKTOP_TRACE_READER_EXTENSION", &trace_reader_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config).env("PI_DESKTOP_BROKER_URL", format!("http://127.0.0.1:{broker_port}")).env("PI_DESKTOP_BROKER_TOKEN", &broker_token);
        match launch {
            PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => {
                let working_dir = match cwd { Some("~") => home_dir()?, Some(path) => PathBuf::from(path), None => std::env::current_dir().map_err(|error| error.to_string())? };
                command.arg("--extension").arg(prepare_btw_extension()?);
                command.current_dir(working_dir).env("PI_DESKTOP_BTW", "1").env("PI_DESKTOP_PI_EXECUTABLE", &pi_path);
                if let Some(path) = fork_path { command.arg("--fork").arg(path); } else if let Some(path) = session_path { command.arg("--session").arg(path); } else if let Some(id) = session_id { command.arg("--session-id").arg(id); }
                if no_session { command.arg("--no-session"); }
            }
            PiLaunch::Print { cwd, session_path, .. } => { command.current_dir(cwd).arg("--session").arg(session_path); }
        }
        if !is_rpc && !default_model.trim().is_empty() { command.arg("--model").arg(default_model.trim()); }
        if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
        return Ok(command);
    }
    let host = remote_host(settings, host_id)?; stage_remote_extensions(host, settings)?; let remote_port = remote_broker_port(); let remote_pi = remote_pi_path(&host.pi_path);
    let mut arguments = vec![remote_pi.clone()]; if is_rpc { arguments.extend(["--mode".into(), "rpc".into()]); } else { arguments.push("--print".into()); }
    arguments.extend(["--extension".into(), "\"$HOME/.piop/runtime-settings.ts\"".into(), "--extension".into(), "\"$HOME/.piop/hook-loader.ts\"".into()]);
    arguments.extend(["--session-dir".into(), "\"$HOME/.piop/sessions\"".into(), "--approve".into(), "--no-skills".into(), "--extension".into(), "\"$HOME/.piop/pi-desktop-mcp-bridge.ts\"".into(), "--extension".into(), "\"$HOME/.piop/session-broker.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-desktop-trace-reader.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-context-window-cap/index.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-project-files-watch/index.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-define-agents/index.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-desktop-codex-compaction.ts\"".into(), "--extension".into(), "\"$HOME/.piop/pi-desktop-codex-web-search.ts\"".into()]);
    arguments.extend(["--extension".into(), "\"$HOME/.piop/pi-openai-fast-mode-piop/index.ts\"".into()]);
    if is_rpc { arguments.extend(["--extension".into(), "\"$HOME/.piop/pi-desktop-btw.ts\"".into()]); }
    let cwd = match launch {
        PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => { if let Some(path) = fork_path { arguments.extend(["--fork".into(), shell_quote(path)]); } else if let Some(path) = session_path { arguments.extend(["--session".into(), shell_quote(path)]); } else if let Some(id) = session_id { arguments.extend(["--session-id".into(), shell_quote(id)]); } if no_session { arguments.push("--no-session".into()); } cwd },
        PiLaunch::Print { cwd, session_path, .. } => { arguments.extend(["--session".into(), shell_quote(session_path)]); Some(cwd) },
    };
    if !is_rpc && !default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(default_model.trim())]); }
    if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
    let rpc_environment = if is_rpc { format!(" PI_DESKTOP_BTW=1 PI_DESKTOP_PI_EXECUTABLE={remote_pi}") } else { String::new() };
    let remote = format!("cd {} && PI_DESKTOP_DEFINED_AGENTS_EXTENSION=\"$HOME/.piop/pi-define-agents/index.ts\" PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION=\"$HOME/.piop/pi-desktop-codex-web-search.ts\" PI_DESKTOP_CODEX_COMPACTION_EXTENSION=\"$HOME/.piop/pi-desktop-codex-compaction.ts\" PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION=\"$HOME/.piop/pi-context-window-cap/index.ts\" PI_DESKTOP_TRACE_READER_EXTENSION=\"$HOME/.piop/pi-desktop-trace-reader.ts\" PI_DESKTOP_MCP_CONFIG=\"$HOME/.piop/mcp-servers.json\" PI_DESKTOP_BROKER_URL={} PI_DESKTOP_BROKER_TOKEN={}{} exec {}", remote_directory_path(cwd), shell_quote(&format!("http://127.0.0.1:{remote_port}")), shell_quote(&broker_token), rpc_environment, arguments.join(" "));
    let mut command = remote_broker_command(host, broker_port, remote_port); command.arg(remote_login_command(&remote)); Ok(command)
}

#[tauri::command(async)]
fn start_pi(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, no_session: Option<bool>, host_id: Option<String>) -> Result<(), String> {
    // Identify a fresh session before launch, even if its first state reply never arrives.
    let session_id = session_id.or_else(|| (session_path.is_none() && fork_path.is_none()).then(|| Uuid::new_v4().to_string()));
    let stale = {
        let mut processes = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        match processes.get_mut(&runtime_id).map(|process| process.child.try_wait()) {
            Some(Ok(None)) => return Ok(()),
            Some(_) => processes.remove(&runtime_id),
            None => None,
        }
    };
    if let Some(mut process) = stale { let _ = process.child.wait(); }
    let settings = load_app_settings(app.clone())?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let saved_ephemeral = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.get(&runtime_id).cloned();
    let ephemeral = no_session.unwrap_or(false) || saved_ephemeral.is_some();
    let session_path = if ephemeral { None } else { session_path.as_deref().map(|path| desktop_session_file(&settings, &host_id, path)).transpose()? };
    let fork_path = fork_path.as_deref().map(|path| desktop_session_file(&settings, &host_id, path)).transpose()?;
    let (ephemeral_path, ephemeral_session) = if let Some(saved) = saved_ephemeral {
        let path = match &saved { EphemeralSession::Local(path) => path.to_string_lossy().into_owned(), EphemeralSession::Remote { path, .. } => path.clone() }; (Some(path), Some(saved))
    } else if ephemeral {
        match fork_path.as_deref() {
            Some(source_path) => { let (path, cleanup) = create_ephemeral_fork(&settings, &host_id, source_path)?; (Some(path), Some(cleanup)) }
            None => (None, None),
        }
    } else { (None, None) };
    if let Some(session) = ephemeral_session { runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.insert(runtime_id.clone(), session); }
    let claim_id = if ephemeral { None } else if let Some(id) = session_id.as_deref() { Some(id.to_string()) } else if let Some(path) = session_path.as_deref() {
        let header = if host_id == "local" { let mut line = String::new(); BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?).read_line(&mut line).map_err(|e| e.to_string())?; line }
        else { { let output = run_limited(ssh(remote_host(&settings, &host_id)?).arg(format!("head -n 1 -- {}", shell_quote(path))), 64 * 1024, "Could not read session identity")?; if !output.status.success() { return Err("Could not read session identity".into()); } String::from_utf8(output.stdout).map_err(|e| e.to_string())? } };
        Some(serde_json::from_str::<Value>(&header).map_err(|e| e.to_string())?.get("id").and_then(Value::as_str).ok_or("Missing session identity")?.to_string())
    } else { None };
    let session_claim = claim_id.as_deref().map(|id| claim_agent(&broker, &host_id, id)).transpose()?;
    let launch_session_path = ephemeral_path.as_deref().or(session_path.as_deref());
    let launch_fork_path = if ephemeral_path.is_some() { None } else { fork_path.as_deref() };
    let mut command = match build_pi_command(&broker, &settings, &host_id, PiLaunch::Rpc { cwd: cwd.as_deref(), session_path: launch_session_path, session_id: session_id.as_deref(), fork_path: launch_fork_path, no_session: ephemeral && ephemeral_path.is_none() }) {
        Ok(command) => command,
        Err(error) => return Err(error),
    };
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(format!("Could not start pi: {error}")),
    };
    let generation = Uuid::new_v4();
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("Pi stdin was unavailable")?));
    let stdout = child.stdout.take().ok_or("Pi stdout was unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi stderr was unavailable")?;
    let blank_cleanup = BlankSessionCleanup { path: session_path.clone(), id: session_id.clone(), host: if host_id == "local" { None } else { Some(remote_host(&settings, &host_id)?.clone()) }, submitted: ephemeral };
    // Commands queued behind extension startup must allow the selected MCP to boot.
    let command_timeout = Duration::from_secs(settings.mcp_servers.iter()
        .filter(|server| server.get("enabled").and_then(Value::as_bool) == Some(true))
        .map(|server| server.get("startupTimeoutSec").and_then(Value::as_u64).unwrap_or(10).clamp(1, 600))
        .max().unwrap_or(0) + 30);
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { generation, claim: session_claim, child, stdin: stdin.clone(), blank_cleanup, command_timeout });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id.clone(), AgentAddress { host_id: host_id.clone(), session_id: session_id.clone(), session_path: session_path.clone(), worktree: None, presence_id: None, working: false });
    let pending = runtime.pending.clone(); let processes = runtime.processes.clone(); let active_agents = runtime.active_agents.clone(); let event_app = app.clone(); let event_runtime_id = runtime_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n') {
            if !processes.lock().ok().is_some_and(|values| values.get(&event_runtime_id).is_some_and(|p| p.generation == generation)) { break; }
            let Ok(bytes) = line else { break }; let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if value.get("type").and_then(Value::as_str) == Some("extension_ui_request") && value.get("method").and_then(Value::as_str) == Some("setStatus")
                && matches!(value.get("statusKey").and_then(Value::as_str), Some("pi-desktop-control-response" | "pi-desktop-pause-state")) {
                let Some(payload) = value.get("statusText").and_then(Value::as_str).and_then(|text| text.strip_prefix("json:")).and_then(|text| serde_json::from_str::<Value>(text).ok()) else { continue };
                value = payload;
            }
            if let Ok(mut agents) = active_agents.lock() {
                if let Some(agent) = agents.get_mut(&event_runtime_id) {
                    match value.get("type").and_then(Value::as_str) {
                        Some("agent_start") => agent.working = true,
                        Some("agent_settled") => agent.working = false,
                        Some("extension_ui_request") if value.get("statusKey").and_then(Value::as_str) == Some("pi-desktop-worktree-presence") => {
                            if let Some(presence) = value.get("statusText").and_then(Value::as_str).and_then(|text| serde_json::from_str::<Value>(text).ok()) {
                                agent.worktree = presence.get("worktree").and_then(Value::as_str).map(str::to_owned);
                                agent.presence_id = presence.get("id").and_then(Value::as_str).map(str::to_owned);
                            }
                            continue;
                        },
                        _ => {},
                    }
                }
            }
            if value.get("type") == Some(&Value::String("response".into())) {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(control_id) = id.strip_suffix(":desktop-control") {
                        if value.get("success").and_then(Value::as_bool) == Some(false) {
                            if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&(event_runtime_id.clone(), control_id.to_string()))) {
                                let _ = sender.send(Err(value.get("error").and_then(Value::as_str).unwrap_or("Pi control failed").to_string()));
                            }
                        }
                        continue;
                    }
                    if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&(event_runtime_id.clone(), id.to_string()))) {
                        let result = if value.get("success").and_then(Value::as_bool).unwrap_or(false) { Ok(value.get("data").cloned().unwrap_or(Value::Null)) } else { Err(value.get("error").and_then(Value::as_str).unwrap_or("Pi command failed").to_string()) };
                        let _ = sender.send(result); continue;
                    }
                }
            }
            let _ = event_app.emit("pi://event", json!({"runtimeId":event_runtime_id,"event":value}));
        }
        let exited = processes.lock().ok().and_then(|mut values| {
            if !values.get(&event_runtime_id).is_some_and(|p| p.generation == generation) { return None; }
            if let Ok(mut agents) = active_agents.lock() { agents.remove(&event_runtime_id); }
            fail_pending(&pending, &event_runtime_id, "Pi disconnected before responding");
            let _ = event_app.emit("pi://event", json!({"runtimeId":event_runtime_id,"event":{"type":"disconnected"}}));
            values.remove(&event_runtime_id)
        });
        if let Some(mut process) = exited { let _ = process.child.wait(); cleanup_blank_session(process.blank_cleanup); }

    });
    let error_app = app.clone(); let error_runtime_id = runtime_id.clone();
    thread::spawn(move || for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = error_app.emit("pi://stderr", json!({"runtimeId":error_runtime_id,"line":line})); });
    Ok(())
}

#[tauri::command(async)]
fn stop_pi(runtime: State<PiRuntime>, runtime_id: String, discard_blank: Option<bool>) -> Result<(), String> {
    let process = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(&runtime_id);
    if let Some(mut process) = process { let _ = process.child.kill(); let _ = process.child.wait(); if discard_blank.unwrap_or(false) { cleanup_blank_session(process.blank_cleanup); } }
    if discard_blank.unwrap_or(false) { if let Some(session) = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.remove(&runtime_id) { remove_ephemeral_session(session); } }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(&runtime_id);
    fail_pending(&runtime.pending, &runtime_id, "Pi disconnected before responding");
    Ok(())
}

fn execute_pi_command(runtime: &PiRuntime, runtime_id: &str, mut command: Value) -> Result<Value, String> {
    let abort = command.get("type").and_then(Value::as_str) == Some("abort");
    let resume = command.get("type").and_then(Value::as_str) == Some("resume");
    let fire_and_forget = command.get("type").and_then(Value::as_str) == Some("extension_ui_response");
    let id = command.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
    command.as_object_mut().ok_or("RPC command must be an object")?.insert("id".into(), Value::String(id.clone()));
    let desktop_action = match command.get("type").and_then(Value::as_str) { Some("pause") => Some("pause"), Some("resume") => Some("resume"), Some("abort") => Some("stop"), Some("get_pause_state") => Some("state"), _ => None };
    if let Some(action) = desktop_action {
        let control = serde_json::to_string(&json!({"id":id,"action":action})).map_err(|error| error.to_string())?;
        command = json!({"id":format!("{id}:desktop-control"),"type":"prompt","message":format!("/pi-desktop-control {control}")});
    }
    if command.get("type").and_then(Value::as_str) == Some("runtime_settings") {
        let request = serde_json::to_string(&command).map_err(|error| error.to_string())?;
        command = json!({"id":format!("{id}:desktop-control"),"type":"prompt","message":format!("/piop-runtime-settings {request}")});
    }
    if command.get("type").and_then(Value::as_str) == Some("branch_checkpoint") {
        let request = serde_json::to_string(&command).map_err(|error| error.to_string())?;
        command = json!({"id":format!("{id}:desktop-control"),"type":"prompt","message":format!("/pi-desktop-branch-checkpoint {request}")});
    }
    let (sender, receiver) = mpsc::channel();
    let started = Instant::now();
    let (stdin, command_timeout, generation) = {
        let processes = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        let process = processes.get(runtime_id).ok_or("Pi is not running")?;
        (process.stdin.clone(), if abort { Duration::from_secs(5) } else { process.command_timeout }, process.generation)
    };
    runtime.pending.lock().map_err(|_| "Pending command lock was poisoned")?.insert((runtime_id.to_string(), id.clone()), sender);
    let (write_sender, write_receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| {
            let mut stdin = stdin.lock().map_err(|_| "Pi stdin lock was poisoned".to_string())?;
            serde_json::to_writer(&mut *stdin, &command).map_err(|error| error.to_string())?;
            stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
        })();
        let _ = write_sender.send(result);
    });
    let result = (|| {
        write_receiver.recv_timeout(command_timeout).map_err(|_| "Pi command timed out".to_string())??;
        if fire_and_forget { return Ok(Value::Null); }
        receiver.recv_timeout(command_timeout.saturating_sub(started.elapsed())).map_err(|_| "Pi command timed out".to_string())?
    })();
    runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.to_string(), id)));
    if result.as_ref().err().is_some_and(|e| e == "Pi command timed out") {
        if let Ok(mut processes) = runtime.processes.lock() { if let Some(process) = processes.get_mut(runtime_id).filter(|p| p.generation == generation) { let _ = process.child.kill(); } }
    }
    let result = result?;
    if resume {
        if let Some(message) = result.get("resumeMessage").and_then(Value::as_str) {
            execute_pi_command(runtime, runtime_id, json!({"type":"prompt","message":message}))?;
        }
    }
    Ok(result)
}

fn update_active_agent(runtime: &PiRuntime, broker: &BrokerRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
    if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(runtime_id) {
        if let Some(path) = state.get("sessionFile").and_then(Value::as_str) { process.blank_cleanup.path = Some(path.to_owned()); }
        if let Some(id) = state.get("sessionId").and_then(Value::as_str) {
            let host_id = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get(runtime_id).map(|agent| agent.host_id.clone()).unwrap_or_else(|| "local".into());
            let key = format!("{host_id}\0{id}");
            if process.claim.as_ref().map(|claim| &claim.key) != Some(&key) { process.claim = Some(claim_agent(broker, &host_id, id)?); }
            process.blank_cleanup.id = Some(id.to_owned());
        }
    }
    let mut agents = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?;
    let Some(agent) = agents.get_mut(runtime_id) else { return Ok(()); };
    agent.session_id = state.get("sessionId").and_then(Value::as_str).map(str::to_owned);
    agent.session_path = state.get("sessionFile").and_then(Value::as_str).map(str::to_owned);
    Ok(())
}

#[tauri::command(async)]
fn pi_command(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, mut command: Value) -> Result<Value, String> {
    let command_type = command.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut switch_claim = None;
    if command_type == "switch_session" {
        let path = command.get("sessionPath").and_then(Value::as_str).ok_or("Session path is required")?;
        let host_id = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?
            .get(&runtime_id).map(|agent| agent.host_id.clone()).ok_or("Unknown Pi runtime")?;
        let path = desktop_session_file(&load_app_settings(app.clone())?, &host_id, path)?;
        let sessions = collect_sessions(&app, &app.state::<SessionIndexRuntime>())?;
        let session = sessions.iter().find(|s| s.host_id == host_id && s.path == path).ok_or("Session identity is unavailable")?;
        let already_owned = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(&runtime_id).and_then(|p| p.claim.as_ref()).is_some_and(|claim| claim.key == format!("{host_id}\0{}", session.id));
        if !already_owned { switch_claim = Some(claim_agent(&broker, &host_id, &session.id)?); }
        command["sessionPath"] = Value::String(path);
    }
    let internal_status = command.get("message").and_then(Value::as_str).is_some_and(|message| message == "/pi-desktop-fast-status" || message == "/pi-desktop-fast-status refresh");
    if matches!(command_type.as_str(), "prompt" | "steer" | "follow_up") && !internal_status {
        if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(&runtime_id) { process.blank_cleanup.submitted = true; }
    }
    let mut result = execute_pi_command(&runtime, &runtime_id, command)?;
    if result.get("cancelled").and_then(Value::as_bool) != Some(true) { if let Some(claim) = switch_claim { if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(&runtime_id) { process.claim = Some(claim); } } }
    if command_type == "get_state" {
        update_active_agent(&runtime, &broker, &runtime_id, &result)?;
        let pause = execute_pi_command(&runtime, &runtime_id, json!({"type":"get_pause_state"}))?;
        if let (Some(state), Some(fields)) = (result.as_object_mut(), pause.as_object()) { state.extend(fields.clone()); }
        if result.get("isPaused").and_then(Value::as_bool) == Some(true) && result.get("isPausing").and_then(Value::as_bool) != Some(true) { result["isStreaming"] = Value::Bool(false); }
    }
    else if matches!(command_type.as_str(), "fork" | "clone" | "new_session" | "switch_session") {
        if let Ok(state) = execute_pi_command(&runtime, &runtime_id, json!({"type":"get_state"})) { update_active_agent(&runtime, &broker, &runtime_id, &state)?; }
    }
    Ok(result)
}

#[tauri::command]
fn start_terminal(app: AppHandle, runtime: State<TerminalRuntime>, terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: Option<String>) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if processes.contains_key(&terminal_id) { return Ok(()); }
    if processes.values().filter(|process| process.session_key == session_key).count() >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals may run for one conversation")); }
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
        if let Some(config) = user_ssh_config() { command.arg("-F"); command.arg(config); }
        command.args(["-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", &host.target, &format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))]); command
    };
    command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(command).map_err(|error| format!("Could not start terminal shell: {error}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let event_app = app.clone(); let event_id = terminal_id.clone(); let terminal_processes = runtime.processes.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let data = decode_terminal_bytes(&mut pending_utf8, &buffer[..length], false);
                    if !data.is_empty() { let _ = event_app.emit("pi://event", json!({ "type": "terminal_output", "terminalId": event_id, "data": data })); }
                }
                Err(_) => break,
            }
        }
        let tail = decode_terminal_bytes(&mut pending_utf8, &[], true);
        if !tail.is_empty() { let _ = event_app.emit("pi://event", json!({ "type": "terminal_output", "terminalId": event_id, "data": tail })); }
        if let Some(mut process) = terminal_processes.lock().ok().and_then(|mut values| values.remove(&event_id)) { let _ = process.child.wait(); }
        let _ = event_app.emit("pi://event", json!({ "type": "terminal_exit", "terminalId": event_id }));
    });
    let (input, queued) = mpsc::sync_channel::<String>(32);
    thread::spawn(move || { while let Ok(data) = queued.recv() { if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() { break; } } });
    processes.insert(terminal_id, TerminalProcess { session_key, master: pair.master, child, writer: input });
    Ok(())
}

fn decode_terminal_bytes(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
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

#[tauri::command]
fn write_terminal(runtime: State<TerminalRuntime>, terminal_id: String, data: String) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get_mut(&terminal_id).ok_or("Terminal is not running")?;
    if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB; paste a smaller block".into()); }
    process.writer.try_send(data).map_err(|_| "Terminal input is busy; wait or close the terminal".to_string())
}

#[tauri::command]
fn resize_terminal(runtime: State<TerminalRuntime>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get(&terminal_id).ok_or("Terminal is not running")?;
    process.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn close_terminal(runtime: State<TerminalRuntime>, terminal_id: String) -> Result<(), String> {
    if let Some(mut process) = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.remove(&terminal_id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    Ok(())
}

fn stop_terminals(runtime: &TerminalRuntime, terminal_ids: &[String]) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    for id in terminal_ids {
        if let Some(mut process) = processes.remove(id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    }
    Ok(())
}

fn open_system_resource(target: &std::ffi::OsStr) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else if cfg!(target_os = "windows") { "explorer" } else { "xdg-open" };
    let mut child = Command::new(program).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy()))?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[tauri::command(async)]
fn read_dropped_file(path: String) -> Result<Value, String> {
    let path = Path::new(&path);
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Drop files, not folders".to_string()); }
    let limit = 10 * 1024 * 1024;
    if metadata.len() > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let name = path.file_name().ok_or("Attachment has no filename")?.to_string_lossy();
    Ok(json!({ "name": name, "data": data }))
}

#[tauri::command(async)]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() { return Err("Only HTTP and HTTPS links can be opened in the browser".into()); }
    open_system_resource(std::ffi::OsStr::new(parsed.as_str()))
}

#[tauri::command(async)]
fn open_project_directory(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, host_id.as_deref().unwrap_or_default())?;
        return Err(format!("Opening project directories on {} is not supported by the local file manager", host.name));
    }
    let path = PathBuf::from(cwd);
    if !path.is_dir() { return Err(format!("Project directory does not exist: {}", path.display())); }
    open_system_resource(path.as_os_str())
}


fn unix_timestamp(time: SystemTime) -> u64 { time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() }

// Inspect each distinct directory once per refresh, batching remote checks into one SSH call per batch.
fn inspect_session_projects(sessions: &mut [SessionSummary], host: Option<&RemoteHost>) -> Result<(), String> {
    let directories = sessions.iter().map(|session| session.cwd.clone()).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    let script = r#"for path do
        if [ ! -d "$path" ]; then printf 'missing\000\000'; continue; fi
        git_dir=$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null) || { printf 'no-repo\000\000'; continue; }
        common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { printf 'unknown\000\000'; continue; }
        if [ "$git_dir" = "$common_dir" ]; then printf 'main\000'; else printf 'worktree\000'; fi
        project_root=$(git -C "$path" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
        printf '%s\000' "$project_root"
    done"#;
    let mut projects = HashMap::new();
    for batch in directories.chunks(128) {
        let mut command = if let Some(host) = host {
            let arguments = batch.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" ");
            let mut command = ssh(host);
            command.arg(format!("sh -c {} sh {arguments}", shell_quote(script)));
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", script, "sh"]).args(batch);
            command
        };
        let output = run_limited(&mut command, MAX_GIT_PATH_LIST_BYTES, "Could not inspect session projects")?;
        if !output.status.success() { return Err(format!("Could not inspect session projects: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        let fields = output.stdout.strip_suffix(&[0]).ok_or("Incomplete session project details")?.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != batch.len() * 2 { return Err("Could not inspect every session project".into()); }
        for (path, details) in batch.iter().zip(fields.chunks_exact(2)) {
            let flag = details[0];
            let project_root = (!details[1].is_empty()).then(|| String::from_utf8_lossy(details[1]).into_owned());
            let kind = match flag { b"no-repo" => Some(ProjectKind::NoRepo), b"main" => Some(ProjectKind::Main), b"worktree" => Some(ProjectKind::Worktree), _ => None };
            projects.insert(path.as_str(), (flag != b"missing", kind, project_root));
        }
    }
    for session in sessions {
        if let Some((exists, kind, project_root)) = projects.get(session.cwd.as_str()) { session.cwd_exists = *exists; session.project_kind = *kind; session.project_root = project_root.clone(); }
    }
    Ok(())
}

fn read_session_summaries(candidates: &[(String, String, u64, u64)], host: Option<&RemoteHost>) -> Result<HashMap<String, CachedSession>, String> {
    let script = include_str!("../resources/index-sessions.cjs");
    let mut result = HashMap::new(); let mut cursor = 0;
    while cursor < candidates.len() {
        let mut end = cursor; let mut argument_bytes = 0;
        while end < candidates.len() && end - cursor < 128 {
            let size = shell_quote(&candidates[end].0).len() + 1;
            if end > cursor && argument_bytes + size > 16 * 1024 { break; }
            argument_bytes += size; end += 1;
        }
        let batch = &candidates[cursor..end];
        let mut command = if let Some(host) = host {
            let mut command = ssh(host); command.arg(remote_login_command(&format!("node -e {} {}", shell_quote(script), batch.iter().map(|item| shell_quote(&item.0)).collect::<Vec<_>>().join(" ")))); command
        } else { let mut command = Command::new("node"); command.args(["-e", script]).args(batch.iter().map(|item| &item.0)); command };
        let output = run_limited(&mut command, MAX_SESSION_INDEX_BATCH_BYTES, "Could not read session summaries")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        for line in output.stdout.split(|byte| *byte == b'\n') {
            let Ok(value) = serde_json::from_slice::<Value>(line) else { continue };
            let Some(path) = value.get("path").and_then(Value::as_str) else { continue };
            let Some((_, fingerprint, modified_at, _)) = batch.iter().find(|item| item.0 == path) else { continue };
            let string = |key| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let cwd = string("cwd"); let project = Path::new(&cwd).file_name().and_then(|name| name.to_str()).unwrap_or("Workspace").to_owned();
            let summary = SessionSummary { group_id: None, id: string("id"), path: path.to_owned(), name: string("name"), project, cwd, cwd_exists: true, project_kind: None, project_root: None, modified_at: *modified_at, preview: string("preview"), message_count: value.get("messageCount").and_then(Value::as_u64).unwrap_or(0) as usize, api_cost: value.get("apiCost").and_then(Value::as_f64).unwrap_or(0.0), host_id: host.map(|host| host.id.clone()).unwrap_or_else(|| "local".into()), host_name: host.map(|host| host.name.clone()).unwrap_or_else(|| "Local".into()) };
            result.insert(path.to_owned(), CachedSession { fingerprint: fingerprint.clone(), summary });
        }
        cursor = end;
    }
    Ok(result)
}

fn list_local_sessions(index: &SessionIndexRuntime, root: &Path) -> Result<Vec<SessionSummary>, String> {
    let mut cache = index.local.lock().map_err(|_| "Local session index lock was poisoned")?;
    let mut seen = HashSet::new(); let mut changed = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")) {
        let path = entry.path().to_path_buf(); let Ok(metadata) = entry.metadata() else { continue };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let fingerprint = format!("{}:{}", modified.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos(), metadata.len());
        seen.insert(path.clone());
        if cache.get(&path).is_none_or(|cached| cached.fingerprint != fingerprint) { changed.push((path.to_string_lossy().into_owned(), fingerprint, unix_timestamp(modified), metadata.len())); }
    }
    for (path, summary) in read_session_summaries(&changed, None)? { cache.insert(PathBuf::from(path), summary); }
    cache.retain(|path, _| seen.contains(path)); let mut sessions = cache.values().map(|cached| cached.summary.clone()).collect::<Vec<_>>(); drop(cache);
    inspect_session_projects(&mut sessions, None)?; Ok(sessions)
}

fn list_remote_sessions(index: &SessionIndexRuntime, host: &RemoteHost) -> Result<Vec<SessionSummary>, String> {
    let output = run_limited(ssh(host).arg(r#"mkdir -p "$HOME/.piop/sessions" && find "$HOME/.piop/sessions" -type f -name '*.jsonl' -printf '%p\000%T@\000%s\000' 2>/dev/null"#), MAX_SESSION_INDEX_BATCH_BYTES, "Could not list remote sessions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let metadata = fields.chunks_exact(3).filter_map(|frame| {
        let path = String::from_utf8_lossy(frame[0]).into_owned(); let modified = String::from_utf8_lossy(frame[1]); let size = String::from_utf8_lossy(frame[2]).parse().ok()?;
        Some((path, format!("{modified}:{size}"), modified.split('.').next()?.parse().ok()?, size))
    }).collect::<Vec<(String, String, u64, u64)>>();
    let previous = index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.get(&host.id).cloned().unwrap_or_default();
    let changed = metadata.iter().filter(|(path, fingerprint, _, _)| previous.get(path).is_none_or(|cached| cached.fingerprint != *fingerprint)).cloned().collect::<Vec<_>>();
    let mut parsed = read_session_summaries(&changed, Some(host))?;

    let mut next = HashMap::new(); let mut sessions = Vec::new();
    for (path, _, _, _) in metadata {
        let Some(mut cached) = parsed.remove(&path).or_else(|| previous.get(&path).cloned()) else { continue };
        cached.summary.host_name = host.name.clone(); sessions.push(cached.summary.clone()); next.insert(path, cached);
    }
    inspect_session_projects(&mut sessions, Some(host))?;
    index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.insert(host.id.clone(), next); Ok(sessions)
}

#[tauri::command(async)]
fn home_directory(app: AppHandle, host_id: String) -> Result<String, String> {
    if host_id == "local" { let home = home_dir()?; return Ok(home.canonicalize().unwrap_or(home).to_string_lossy().into_owned()); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let output = ssh(host).arg("cd \"$HOME\" && pwd -P").output().map_err(|error| format!("Could not resolve home on {}: {error}", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path).ok_or_else(|| "Remote home directory was unavailable".into())
}

fn create_local_temporary_chat(home: &Path, session_id: &str) -> Result<PathBuf, String> {
    let cwd = home.join(".piop/tmp").join(session_id);
    fs::create_dir_all(&cwd).map_err(|error| format!("Could not create temporary chat directory: {error}"))?;
    fs::write(cwd.join(".pi-desktop-temporary-chat"), b"").map_err(|error| format!("Could not mark temporary chat directory: {error}"))?;
    Ok(cwd)
}

fn temporary_chat_id(path: &str) -> Option<&str> {
    let value = Path::new(path); let id = value.file_name()?.to_str()?;
    Uuid::parse_str(id).ok()?;
    (value.parent()?.file_name()?.to_str()? == "tmp" && value.parent()?.parent()?.file_name()?.to_str()? == ".piop").then_some(id)
}

#[tauri::command(async)]
fn remove_temporary_chat(app: AppHandle, path: String, host_id: String) -> Result<(), String> {
    temporary_chat_id(&path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    if host_id == "local" {
        let expected_root = home_dir()?.join(".piop/tmp");
        let candidate = PathBuf::from(&path);
        if candidate.parent() != Some(expected_root.as_path()) { return Err("Refusing to remove a directory outside the temporary chat root".into()); }
        if !candidate.join(".pi-desktop-temporary-chat").is_file() { return Err("Refusing to remove an unmarked directory".into()); }
        if candidate.exists() { fs::remove_dir_all(candidate).map_err(|error| format!("Could not remove temporary chat directory: {error}"))?; }
        return Ok(());
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let script = format!("candidate={}; root=\"$HOME/.piop/tmp\"; [ \"$(dirname -- \"$candidate\")\" = \"$root\" ] && [ -f \"$candidate/.pi-desktop-temporary-chat\" ] && rm -rf -- \"$candidate\"", shell_quote(&path));
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not remove temporary chat directory on {}: {error}", host.name))?;
    if !output.status.success() { return Err(format!("Could not remove temporary chat directory on {}: {}", host.name, String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}

#[tauri::command(async)]
fn validate_project_directory(app: AppHandle, path: String, host_id: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    if host_id == "local" {
        let metadata = fs::metadata(&path).map_err(|error| format!("Could not open project directory: {error}"))?;
        if !metadata.is_dir() { return Err("Project path is not a directory".into()); }
        return Ok(path);
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let output = ssh(host).arg(format!("test -d {0} && cd {0} && pwd -P", shell_quote(&path))).output().map_err(|error| format!("Could not validate project directory on {}: {error}", host.name))?;
    if !output.status.success() { return Err(format!("Could not open project directory on {}: {}", host.name, String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(path)
}

#[tauri::command(async)]
fn create_temporary_chat(app: AppHandle, host_id: String, e2e: Option<bool>) -> Result<TemporaryChat, String> {
    let session_id = Uuid::new_v4().to_string();
    let cwd = if host_id == "local" {
        let cwd = create_local_temporary_chat(&home_dir()?, &session_id)?;
        if cfg!(feature = "webdriver") && e2e.unwrap_or(false) { fs::write(cwd.join(".pi-e2e-test"), b"").map_err(|error| format!("Could not mark temporary test chat: {error}"))?; }
        cwd.to_string_lossy().into_owned()
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let remote = format!("mkdir -p \"$HOME/.piop/tmp/{session_id}\" && : > \"$HOME/.piop/tmp/{session_id}/.pi-desktop-temporary-chat\" && cd \"$HOME/.piop/tmp/{session_id}\" && pwd -P");
        let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not create temporary chat directory on {}: {error}", host.name))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() { return Err("Remote temporary chat directory was unavailable".into()); }
        path
    };
    Ok(TemporaryChat { cwd, session_id })
}

#[tauri::command(async)]
fn list_directories(app: AppHandle, host_id: String, path: Option<String>) -> Result<DirectoryListing, String> {
    if host_id == "local" {
        let requested = path.filter(|value| !value.trim().is_empty()).map(PathBuf::from).unwrap_or(home_dir()?);
        let current = requested.canonicalize().map_err(|error| format!("Could not browse {}: {error}", requested.display()))?;
        if !current.is_dir() { return Err(format!("{} is not a directory", current.display())); }
        let entries = fs::read_dir(&current).map_err(|error| format!("Could not browse {}: {error}", current.display()))?;
        let mut directories: Vec<String> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|entry| entry.is_dir()).map(|entry| entry.to_string_lossy().into_owned()).collect();
        directories.sort_by_key(|directory| directory.to_lowercase());
        return Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories });
    }
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

fn collect_sessions(app: &AppHandle, index: &SessionIndexRuntime) -> Result<Vec<SessionSummary>, String> {
    let home = home_dir()?; let root = ensure_desktop_sessions_dir(&home)?;
    let mut sessions = list_local_sessions(index, &root)?;
    let hosts = load_app_settings(app.clone())?.hosts;
    thread::scope(|scope| {
        let queue = Arc::new(Mutex::new(hosts));
        let (sender, receiver) = mpsc::channel();
        for _ in 0..MAX_REMOTE_HOSTS.min(4).min(queue.lock().map(|items| items.len()).unwrap_or(0)) {
            let queue = queue.clone(); let sender = sender.clone();
            scope.spawn(move || loop {
                let host = queue.lock().ok().and_then(|mut items| items.pop());
                let Some(host) = host else { break };
                let _ = sender.send(list_remote_sessions(index, &host));
            });
        }
        drop(sender);
        for result in receiver { if let Ok(mut remote) = result { sessions.append(&mut remote); } }
    });
    session_groups::attach_assignments(&mut sessions)?;
    sessions.sort_by(|left, right| right.modified_at.cmp(&left.modified_at)); Ok(sessions)
}

#[tauri::command(async)]
fn list_sessions(app: AppHandle, index: State<SessionIndexRuntime>) -> Result<Vec<SessionSummary>, String> { collect_sessions(&app, &index) }

fn local_desktop_session_file(session_path: &str) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(&home_dir()?).canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only piop session files can be accessed".into()); }
    Ok(source)
}

fn desktop_session_file(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    if host_id == "local" { return Ok(local_desktop_session_file(path)?.to_string_lossy().into_owned()); }
    let host = remote_host(settings, host_id)?;
    let script = format!(r#"root=$(cd "$HOME/.piop/sessions" && pwd -P) && session=$(realpath -- {}) && [ -f "$session" ] && case "$session" in "$root"/*.jsonl) printf '%s' "$session" ;; *) exit 1 ;; esac"#, shell_quote(path));
    let output = run_limited(ssh(host).arg(script), MAX_GIT_PATH_LIST_BYTES, "Could not locate Piop session")?;
    if !output.status.success() { return Err("Only Piop session files in ~/.piop/sessions can be opened".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command(async)]
fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, terminal_ids: Vec<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let file_name = Path::new(&session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
        let destination = format!("{}-{file_name}", Uuid::new_v4());
        let diff_destination = Path::new(&destination).with_extension("diffs.json").to_string_lossy().into_owned();
        let remote = format!(r#"root=$(cd "$HOME/.piop/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) archive="$HOME/.piop/archived"; mkdir -p "$archive" || exit 1; diff=${{target%.jsonl}}.diffs.json; diff_target="$archive"/{}; moved_diff=0; if [ -f "$diff" ]; then mv -- "$diff" "$diff_target" || exit 1; moved_diff=1; fi; if ! mv -- "$target" "$archive"/{}; then if [ "$moved_diff" = 1 ]; then mv -- "$diff_target" "$diff" || true; fi; exit 1; fi ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(&session_path), shell_quote(&diff_destination), shell_quote(&destination));
        let output = ssh(host).arg(remote).output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let _ = stop_terminals(&runtime, &terminal_ids);
        return Ok(());
    }
    let source = local_desktop_session_file(&session_path)?;
    let archive_dir = home_dir()?.join(".piop/archived");
    fs::create_dir_all(&archive_dir).map_err(|error| format!("Could not create archive directory: {error}"))?;
    let file_name = source.file_name().ok_or("Session path has no file name")?;
    let mut destination = archive_dir.join(file_name);
    if destination.exists() {
        let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("session");
        let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("jsonl");
        destination = archive_dir.join(format!("{stem}-{}.{}", Uuid::new_v4(), extension));
    }
    let diff_source = source.with_extension("diffs.json"); let diff_destination = destination.with_extension("diffs.json");
    let moved_diff = if diff_source.exists() {
        if let Err(error) = fs::rename(&diff_source, &diff_destination) { return Err(format!("Could not archive session diffs: {error}")); }
        true
    } else { false };
    if let Err(error) = fs::rename(&source, &destination) {
        if moved_diff { let _ = fs::rename(&diff_destination, &diff_source); }
        return Err(format!("Could not archive session: {error}"));
    }
    let _ = stop_terminals(&runtime, &terminal_ids);
    Ok(())
}

#[tauri::command(async)]
fn delete_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let settings = load_app_settings(app)?;
    let path = desktop_session_file(&settings, &host_id, &session_path)?;
    if runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .any(|agent| agent.host_id == host_id && agent.session_path.as_deref() == Some(path.as_str())) {
        return Err("Close the session before deleting it".into());
    }
    let active_session_ids: Vec<String> = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .filter(|agent| agent.host_id == host_id).filter_map(|agent| agent.session_id.clone()).collect();
    let arguments = json!({ "path": path, "activeSessionIds": active_session_ids, "root": if host_id == "local" { Some(desktop_sessions_dir(&home_dir()?)) } else { None } }).to_string();
    let script = include_str!("../resources/delete-session.cjs");
    let mut command = if host_id == "local" {
        let mut command = Command::new("node");
        command.args(["-e", script, &arguments]);
        command
    } else {
        let host = remote_host(&settings, &host_id)?;
        let mut command = ssh(host);
        command.arg(remote_login_command(&format!("node -e {} {}", shell_quote(script), shell_quote(&arguments))));
        command
    };
    let output = run_limited(&mut command, 256 * 1024, "Could not delete session")?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not delete session".into() } else { error })
}

#[tauri::command(async)]
fn relocate_session(app: AppHandle, session_path: String, cwd: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let session = shell_quote(&session_path); let replacement = shell_quote(cwd.trim());
        let script = format!(r#"root=$(cd "$HOME/.piop/sessions" && pwd -P) || exit 1; path=$(realpath -- {session}) || exit 1; case "$path" in "$root"/*.jsonl) ;; *) printf 'Refusing to relocate a non-desktop session file' >&2; exit 1 ;; esac; replacement={replacement}; [ -d "$replacement" ] || {{ printf 'Project directory does not exist: %s' "$replacement" >&2; exit 1; }}; node -e 'const fs=require("fs"); const [path,cwd]=process.argv.slice(1); const content=fs.readFileSync(path,"utf8"); const newline=content.indexOf("\n"); const first=newline<0?content:content.slice(0,newline); const rest=newline<0?"":content.slice(newline+1); const header=JSON.parse(first); if(header.type!=="session") throw new Error("Invalid session header"); header.cwd=cwd; const temporary=path+"."+process.pid+".tmp"; try {{ fs.writeFileSync(temporary,JSON.stringify(header)+(newline<0?"":"\n"+rest),{{mode:fs.statSync(path).mode}}); fs.renameSync(temporary,path); }} catch(error) {{ try {{ fs.unlinkSync(temporary); }} catch {{}} throw error; }}' "$path" "$replacement""#);
        let output = run_limited(ssh(host).arg(remote_login_command(&script)), 64 * 1024, &format!("Could not relocate conversation on {}", host.name))?;
        if output.status.success() { return Ok(()); }
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("Could not relocate conversation on {}", host.name) } else { error });
    }
    let replacement = PathBuf::from(cwd.trim());
    if !replacement.is_dir() { return Err(format!("Project directory does not exist: {}", replacement.display())); }
    let path = local_desktop_session_file(&session_path)?;
    let content = fs::read_to_string(&path).map_err(|error| format!("Could not read session: {error}"))?;
    let (first, rest) = content.split_once('\n').unwrap_or((&content, ""));
    let mut header: Value = serde_json::from_str(first).map_err(|error| format!("Invalid session header: {error}"))?;
    if header.get("type").and_then(Value::as_str) != Some("session") { return Err("File is not a Pi session".into()); }
    header.as_object_mut().ok_or("Invalid session header")?.insert("cwd".into(), Value::String(replacement.to_string_lossy().into_owned()));
    let first = serde_json::to_string(&header).map_err(|error| error.to_string())?;
    let updated = if rest.is_empty() { first } else { format!("{first}\n{rest}") };
    let permissions = fs::metadata(&path).map_err(|error| format!("Could not inspect session: {error}"))?.permissions();
    let temporary = path.with_extension(format!("jsonl.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| format!("Could not prepare relocated session: {error}"))?;
        file.set_permissions(permissions).map_err(|error| format!("Could not preserve session permissions: {error}"))?;
        file.write_all(updated.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| format!("Could not write relocated session: {error}"))?;
        fs::rename(&temporary, &path).map_err(|error| format!("Could not commit relocated session: {error}"))
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn resolve_agent<'a>(sessions: &'a [SessionSummary], host_id: &str, session_id: &str, active: &[AgentAddress]) -> Result<&'a SessionSummary, String> {
    let session = sessions.iter().find(|session| session.host_id == host_id && session.id == session_id).ok_or_else(|| format!("Agent {host_id}/{session_id} was not found"))?;
    // ponytail: A resident per-session worker can replace this guard if measured startup latency warrants that extra lifecycle.
    if active.iter().any(|agent| agent_is_active(session, agent)) {
        return Err("Cannot message the session currently open in piop".into());
    }
    Ok(session)
}

fn agent_is_active(session: &SessionSummary, agent: &AgentAddress) -> bool {
    agent.host_id == session.host_id && (agent.session_id.as_deref() == Some(session.id.as_str()) || agent.session_path.as_deref() == Some(session.path.as_str()))
}

fn dispatch_agent_message(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, message: &str, request_id: &str, deadline_ms: u64) -> Result<String, String> {
    let remaining = deadline_ms.saturating_sub(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64);
    if remaining == 0 || broker.closing.load(Ordering::SeqCst) { return Err("Agent message expired or app is closing".into()); }
    let deadline = Instant::now() + Duration::from_millis(remaining.min(120_000));
    let settings = load_app_settings(app.clone())?;
    let mut command = build_pi_command(broker, &settings, &session.host_id, PiLaunch::Print { cwd: &session.cwd, session_path: &session.path })?;
    let output_root = std::env::temp_dir().join(format!("pi-desktop-broker-{}", Uuid::new_v4()));
    ensure_private_dir(&output_root).map_err(|error| format!("Could not prepare agent message: {error}"))?;
    let stdout_path = output_root.join("stdout"); let stderr_path = output_root.join("stderr");
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("Could not capture agent output: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("Could not capture agent errors: {error}"))?;
    command.stdin(Stdio::piped()).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.remove(request_id) { let _ = fs::remove_dir_all(&output_root); return Err("Agent message was cancelled".into()); }
    let spawned = command.spawn();
    let child = match spawned { Ok(child) => Arc::new(Mutex::new(child)), Err(error) => { let _ = fs::remove_dir_all(&output_root); return Err(format!("Could not message agent: {error}")); } };
    match broker.jobs.lock() { Ok(mut jobs) => { if broker.closing.load(Ordering::SeqCst) { if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); } return Err("App is closing".into()); } jobs.insert(request_id.to_string(), child.clone()); }, Err(_) => { if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); } let _ = fs::remove_dir_all(&output_root); return Err("Broker job lock was poisoned".into()); } }
    let stdin = child.lock().map_err(|_| "Agent process lock was poisoned")?.stdin.take();
    let message = message.to_owned(); thread::spawn(move || { if let Some(mut stdin) = stdin { let _ = stdin.write_all(message.as_bytes()); } });
    let status = loop {
        if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.contains(request_id) {
            if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
            break Err("Agent message was cancelled".to_string());
        }
        let status = child.lock().map_err(|_| "Agent process lock was poisoned")?.try_wait().map_err(|error| format!("Could not wait for agent: {error}"))?;
        if let Some(status) = status { break Ok(status); }
        let output_bytes = fs::metadata(&stdout_path).map(|metadata| metadata.len()).unwrap_or(0)
            .saturating_add(fs::metadata(&stderr_path).map(|metadata| metadata.len()).unwrap_or(0));
        if output_bytes > MAX_AGENT_OUTPUT_BYTES {
            if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
            break Err("Agent output exceeded the 16 MiB limit".to_string());
        }
        if Instant::now() >= deadline {
            if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
            break Err("Agent message timed out after 120 seconds".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    };
    broker.jobs.lock().ok().map(|mut jobs| jobs.remove(request_id));
    broker.cancelled.lock().ok().map(|mut cancelled| cancelled.remove(request_id));
    let status = match status { Ok(status) => status, Err(error) => { let _ = fs::remove_dir_all(&output_root); return Err(error); } };
    let output_bytes = fs::metadata(&stdout_path).map(|metadata| metadata.len()).unwrap_or(0)
        .saturating_add(fs::metadata(&stderr_path).map(|metadata| metadata.len()).unwrap_or(0));
    if output_bytes > MAX_AGENT_OUTPUT_BYTES { let _ = fs::remove_dir_all(&output_root); return Err("Agent output exceeded the 16 MiB limit".into()); }
    let stdout = fs::read(&stdout_path).unwrap_or_default(); let stderr = fs::read(&stderr_path).unwrap_or_default(); let _ = fs::remove_dir_all(&output_root);
    if !status.success() { return Err(String::from_utf8_lossy(&stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

fn broker_response(mut stream: TcpStream, status: &str, body: Value) {
    let payload = body.to_string();
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
}

fn read_broker_line(reader: &mut BufReader<TcpStream>, remaining: &mut usize) -> Result<String, String> {
    if *remaining == 0 { return Err("Request headers are too large".into()); }
    let mut line = String::new();
    let count = reader.take((*remaining + 1) as u64).read_line(&mut line).map_err(|error| error.to_string())?;
    if count > *remaining { return Err("Request headers are too large".into()); }
    *remaining -= count;
    Ok(line)
}

fn handle_broker_request(app: AppHandle, broker: BrokerRuntime, stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut header_bytes = BROKER_HEADER_BYTES;
    let request_line = read_broker_line(&mut reader, &mut header_bytes)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or(""); let path = parts.next().unwrap_or("");
    let mut authorized = false; let mut content_length = 0usize;
    loop {
        let line = read_broker_line(&mut reader, &mut header_bytes)?;
        if line == "\r\n" || line.is_empty() { break; }
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.eq_ignore_ascii_case("authorization") { authorized = value.trim() == format!("Bearer {}", broker.token); }
        if name.eq_ignore_ascii_case("content-length") { content_length = value.trim().parse().unwrap_or(0); }
    }
    if !authorized { broker_response(stream, "401 Unauthorized", json!({"error":"Unauthorized"})); return Ok(()); }
    if content_length > BROKER_BODY_BYTES { broker_response(stream, "413 Payload Too Large", json!({"error":"Message is too large"})); return Ok(()); }
    let mut body = vec![0; content_length]; reader.read_exact(&mut body).map_err(|error| error.to_string())?;
    if method == "POST" && path == "/message" {
        let mut count = broker.message_count.lock().map_err(|_| "Broker job count lock was poisoned")?;
        if *count >= BROKER_WORKERS || broker.closing.load(Ordering::SeqCst) { broker_response(stream, "503 Service Unavailable", json!({"error":"Session broker is busy"})); return Ok(()); }
        *count += 1; drop(count);
        thread::spawn(move || {
            let session_index = app.state::<SessionIndexRuntime>();
            let result: Result<Value, String> = (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid message request".to_string())?;
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let host_id = value.get("hostId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("hostId is required")?;
            let session_id = value.get("sessionId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("sessionId is required")?;
            let message = value.get("message").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("message is required")?;
            let sessions = collect_sessions(&app, &session_index)?;
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            let session = resolve_agent(&sessions, host_id, session_id, &active)?;
            let _claim = claim_agent(&broker, host_id, session_id)?;
            dispatch_agent_message(&app, &broker, session, message, request_id, value.get("deadline").and_then(Value::as_u64).unwrap_or_else(|| SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 120_000)).map(|reply| json!({"reply":reply}))
        })();
            if let Ok(mut count) = broker.message_count.lock() { *count = count.saturating_sub(1); }
            match result { Ok(data) => broker_response(stream, "200 OK", json!({"data":data})), Err(error) => broker_response(stream, "400 Bad Request", json!({"error":error})) }
        });
        return Ok(());
    }
    let session_index = app.state::<SessionIndexRuntime>();
    let result = match (method, path) {
        ("GET", "/agents") => {
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            collect_sessions(&app, &session_index).map(|sessions| json!(sessions.into_iter().map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
        },
        ("POST", "/worktree-agents") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid worktree request")?;
            let id = value.get("id").and_then(Value::as_str).ok_or("Agent identity is required")?;
            let runtime = app.state::<PiRuntime>();
            let agents = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?;
            let caller = agents.values().find(|agent| agent.presence_id.as_deref() == Some(id)).ok_or("Could not identify this agent; try again")?;
            let root = caller.worktree.as_deref().ok_or("Could not identify this worktree")?;
            let others: Vec<_> = agents.values().filter(|agent| agent.presence_id.as_deref() != Some(id) && agent.host_id == caller.host_id && agent.working && agent.worktree.as_deref() == Some(root))
                .map(|agent| json!({"sessionId":agent.session_id})).collect();
            Ok(json!(others))
        })(),
        ("POST", "/cancel") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid cancellation request".to_string())?;
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let mut cancelled = broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?;
            if cancelled.len() >= BROKER_QUEUE_DEPTH * 2 { cancelled.clear(); }
            cancelled.insert(request_id.to_string()); drop(cancelled);
            if let Some(child) = broker.jobs.lock().map_err(|_| "Broker job lock was poisoned")?.get(request_id) { if let Ok(mut child) = child.lock() { let _ = child.kill(); } }
            Ok(json!({"cancelled":true}))
        })(),
        _ => Err("Unknown session broker endpoint".into()),
    };
    match result { Ok(data) => broker_response(stream, "200 OK", json!({"data":data})), Err(error) => broker_response(stream, "400 Bad Request", json!({"error":error})) }
    Ok(())
}

fn start_session_broker(app: AppHandle, broker: BrokerRuntime) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("Could not start session broker: {error}"))?;
    *broker.port.lock().map_err(|_| "Session broker lock was poisoned")? = listener.local_addr().map_err(|error| error.to_string())?.port();
    thread::spawn(move || {
        let (sender, receiver) = mpsc::sync_channel::<TcpStream>(BROKER_QUEUE_DEPTH);
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..BROKER_WORKERS {
            let receiver = receiver.clone(); let app = app.clone(); let broker = broker.clone();
            thread::spawn(move || loop {
                let stream = match receiver.lock() { Ok(receiver) => receiver.recv(), Err(_) => return };
                let Ok(stream) = stream else { return };
                let _ = handle_broker_request(app.clone(), broker.clone(), stream);
            });
        }
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            if let Err(mpsc::TrySendError::Full(stream)) = sender.try_send(stream) { broker_response(stream, "503 Service Unavailable", json!({"error":"Session broker is busy"})); }
        }
    });
    Ok(())
}

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    let (context, start_window) = {
        let mut context = context;
        let window = context.config_mut().app.windows.first_mut().expect("Missing main window configuration");
        let start_window = window.visible.then(|| (window.label.clone(), window.focus));
        // Configure GTK's focus-on-map policy before the first show. Keeping the window
        // hidden also lets Tao apply decorations before GNOME chooses its geometry.
        window.visible = false;
        if let Ok(value) = std::env::var("PI_WINDOW_BOUNDS") {
            #[derive(Deserialize)]
            struct WindowBounds { x: i32, y: i32, width: u32, height: u32 }
            let bounds: WindowBounds = serde_json::from_str(&value).expect("Invalid PI_WINDOW_BOUNDS");
            window.x = Some(f64::from(bounds.x));
            window.y = Some(f64::from(bounds.y));
            window.width = f64::from(bounds.width);
            window.height = f64::from(bounds.height);
            window.decorations = false;
        }
        (context, start_window)
    };
    let broker = BrokerRuntime::default();
    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder.plugin(tauri_plugin_dialog::init()).manage(PiRuntime::default()).manage(TerminalRuntime::default()).manage(SessionIndexRuntime::default()).manage(broker.clone()).setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(target_os = "linux")]
        if let Some((label, focus)) = start_window.as_ref() {
            use gtk::prelude::GtkWindowExt;
            let window = app.get_webview_window(label).ok_or("Missing main window")?;
            window.gtk_window()?.set_focus_on_map(*focus);
            window.show()?;
        }
        start_session_broker(app.handle().clone(), broker.clone()).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
        Ok(())
    }).invoke_handler(tauri::generate_handler![start_pi, stop_pi, pi_command, start_terminal, write_terminal, resize_terminal, close_terminal, list_sessions, load_session_groups, change_session_groups, list_hooks, home_directory, create_temporary_chat, remove_temporary_chat, validate_project_directory, list_directories, is_git_repository, git_branch, create_project_worktree, create_git_worktree, prepare_worktree_setup, cancel_worktree_setup, run_worktree_setup, capture_git_tree, discard_git_tree, load_git_diff, load_git_diffs, save_git_diffs, archive_session, delete_session, relocate_session, open_project_directory, open_external_url, read_dropped_file, load_app_settings, save_app_settings, codex_usage]).build(context).expect("error while building piop").run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let broker = app.state::<BrokerRuntime>(); broker.closing.store(true, Ordering::SeqCst);
            let jobs = broker.jobs.lock().map(|mut jobs| jobs.drain().map(|(_, child)| child).collect::<Vec<_>>()).unwrap_or_default();
            for child in jobs { if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); } }
            // The webview cannot await cleanup during pagehide. Own shutdown here.
            let runtime = app.state::<PiRuntime>();
            let processes = runtime.processes.lock().map(|mut processes| processes.drain().map(|(_, process)| process).collect::<Vec<_>>()).unwrap_or_default();
            for mut process in processes {
                let _ = process.child.kill();
                let _ = process.child.wait();

                cleanup_blank_session(process.blank_cleanup);
            }
            let ephemeral = runtime.ephemeral_sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()).unwrap_or_default();
            for session in ephemeral { remove_ephemeral_session(session); }
        }
    });
}
