use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

struct PiProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    ephemeral_session: Option<EphemeralSession>,
}

enum EphemeralSession {
    Local(PathBuf),
    Remote { host: RemoteHost, path: String },
}

struct TerminalProcess {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
    writer: Box<dyn Write + Send>,
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

#[derive(Default)]
struct PiRuntime {
    processes: Arc<Mutex<HashMap<String, PiProcess>>>,
    pending: Arc<Mutex<HashMap<(String, String), mpsc::Sender<Result<Value, String>>>>>,
    active_agents: Arc<Mutex<HashMap<String, AgentAddress>>>,
}

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String> }

#[derive(Clone)]
struct BrokerRuntime {
    port: Arc<Mutex<u16>>,
    token: String,
    busy: Arc<Mutex<HashSet<String>>>,
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl Default for BrokerRuntime {
    fn default() -> Self {
        Self {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    path: String,
    name: String,
    project: String,
    cwd: String,
    cwd_exists: bool,
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
    default_model: String,
    default_thinking: String,
    #[serde(default = "default_context_window_cap", deserialize_with = "deserialize_context_window_cap")]
    context_window_cap: u64,
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

fn default_pi_path() -> String { "pi".into() }
fn default_context_window_cap() -> u64 { 200_000 }
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
        writeln!(stdin, "{}", json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"pi-desktop","title":"Pi Desktop","version":env!("CARGO_PKG_VERSION")},"capabilities":null}})).map_err(|error| error.to_string())?;
        codex_response(&receiver, 1, deadline)?;
        writeln!(stdin, "{}", json!({"method":"initialized"})).map_err(|error| error.to_string())?;
        writeln!(stdin, "{}", json!({"method":"account/rateLimits/read","id":2})).map_err(|error| error.to_string())?;
        let response = codex_response(&receiver, 2, deadline)?;
        codex_usage_values(&response).ok_or_else(|| "Codex usage is unavailable".into())
    })();
    let _ = child.kill(); let _ = child.wait(); result
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("settings.json"))
}

fn validate_dictionaries(settings: &AppSettings) -> Result<(), String> {
    let mut ids = HashSet::new();
    for dictionary in &settings.dictionaries { if dictionary.id.trim().is_empty() || !ids.insert(dictionary.id.as_str()) { return Err("Every dictionary needs a unique id".into()); } }
    let mut active_ids = HashSet::new();
    for id in &settings.active_dictionary_ids { if !ids.contains(id.as_str()) { return Err("Active dictionary was not found".into()); } if !active_ids.insert(id.as_str()) { return Err("A dictionary can only be active once".into()); } }
    let mut keys = HashSet::new();
    for dictionary in settings.dictionaries.iter().filter(|dictionary| active_ids.contains(dictionary.id.as_str())) {
        for entry in &dictionary.entries { let key = entry.word.trim().to_lowercase(); if key.is_empty() { continue; } if !keys.insert(key) { return Err(format!("Key '{}' appears more than once in active dictionaries", entry.word.trim())); } }
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

fn validate_keybindings(settings: &AppSettings) -> Result<(), String> {
    let mut shortcuts = HashSet::new();
    for shortcut in settings.keybindings.values() { if let Some(canonical) = canonical_shortcut(shortcut)? { if !shortcuts.insert(canonical) { return Err(format!("Shortcut '{shortcut}' is assigned more than once")); } } }
    Ok(())
}

fn validate_mcp_servers(settings: &AppSettings) -> Result<(), String> {
    if settings.mcp_servers.len() > MAX_MCP_SERVERS { return Err(format!("At most {MAX_MCP_SERVERS} MCP servers can be configured")); }
    let mut ids = HashSet::new();
    for server in &settings.mcp_servers {
        let id = server.get("id").and_then(Value::as_str).unwrap_or(""); let name = server.get("name").and_then(Value::as_str).unwrap_or("").trim();
        if id.trim().is_empty() || !ids.insert(id) { return Err("Every MCP server needs a unique id".into()); }
        if name.is_empty() { return Err("Every MCP server needs a name".into()); }
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

fn prepare_mcp_bridge(app: &AppHandle, settings: &AppSettings) -> Result<(PathBuf, PathBuf), String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let extension_path = dir.join("pi-desktop-mcp-bridge.ts");
    let config_path = dir.join("mcp-servers.json");
    fs::write(&extension_path, include_str!("../resources/mcp-bridge.bundle.mjs")).map_err(|error| error.to_string())?;
    fs::write(&config_path, serde_json::to_vec_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok((extension_path, config_path))
}

fn prepare_session_broker(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("pi-desktop-session-broker.ts");
    fs::write(&path, include_str!("../resources/session-broker.ts")).map_err(|error| error.to_string())?;
    Ok(path)
}

fn prepare_trace_reader(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("pi-desktop-trace-reader.ts");
    fs::write(&path, include_str!("../resources/trace-reader.ts")).map_err(|error| error.to_string())?;
    Ok(path)
}

fn prepare_context_window_cap_extension(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?.join("pi-context-window-cap");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let extension_path = dir.join("index.ts");
    let config_path = dir.join("config.json");
    fs::write(&extension_path, include_str!("../../extensions/pi-context-window-cap/index.ts")).map_err(|error| error.to_string())?;
    fs::write(&config_path, serde_json::to_vec_pretty(&json!({ "contextWindowCap": settings.context_window_cap })).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(extension_path)
}

fn prepare_btw_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".pi/agent/extensions");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("pi-desktop-btw.ts");
    fs::write(&path, include_str!("../resources/btw.ts")).map_err(|error| error.to_string())?;
    Ok(path)
}

fn default_settings() -> AppSettings {
    AppSettings {
        default_model: DEFAULT_MODEL.into(), default_thinking: "medium".into(), context_window_cap: default_context_window_cap(), auto_compaction: true, auto_retry: true, debug_mode: false, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List agents by machine and session","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Send a message to another agent","enabled":true,"builtin":false}),
            json!({"name":"read_trace","description":"Extract clean user and final assistant messages from a Pi trace","enabled":true,"builtin":false}),
        ]).collect(),
        skills: vec![], mcp_servers: vec![], hosts: vec![], dictionaries: vec![], active_dictionary_ids: vec![],
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
    if settings.hosts.len() > MAX_REMOTE_HOSTS { return Err(format!("Settings contain more than {MAX_REMOTE_HOSTS} remote machines")); }
    if settings.mcp_servers.len() > MAX_MCP_SERVERS { return Err(format!("Settings contain more than {MAX_MCP_SERVERS} MCP servers")); }
    merge_discovered_skills(&mut settings);
    validate_dictionaries(&settings)?;
    Ok(settings)
}

#[tauri::command(async)]
fn save_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
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
    fs::write(settings_path(&app)?, serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[tauri::command]
fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

fn desktop_sessions_dir(home: &Path) -> PathBuf { home.join(".pi-desktop/sessions") }

fn ensure_desktop_sessions_dir(home: &Path) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home);
    fs::create_dir_all(&root).map_err(|error| format!("Could not create Pi Desktop session directory: {error}"))?;
    Ok(root)
}

#[derive(Serialize, Deserialize)]
struct GitSnapshotToken { root: String, tree: String }

struct LimitedOutput { status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8> }

fn run_limited(command: &mut Command, max_stdout: usize, context: &str) -> Result<LimitedOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("{context}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{context}: stdout was unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{context}: stderr was unavailable"))?;
    let stderr_reader = thread::spawn(move || { let mut bytes = Vec::new(); let _ = stderr.take(64 * 1024).read_to_end(&mut bytes); bytes });
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
    let output = run_limited(Command::new("git").args(["-C", cwd, "ls-files", "-z", "-m", "-o", "--exclude-standard", "--"]), MAX_GIT_PATH_LIST_BYTES, "Could not inspect Git changes")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let mut total = 0u64; let mut count = 0usize;
    for raw in output.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
        count += 1; if count > MAX_GIT_CHANGED_PATHS { return Ok(false); }
        let relative = String::from_utf8_lossy(raw); let path = root.join(relative.as_ref());
        let Ok(metadata) = fs::symlink_metadata(path) else { continue };
        let size = metadata.len(); if size > MAX_GIT_FILE_BYTES { return Ok(false); }
        total = total.saturating_add(size); if total > MAX_GIT_SNAPSHOT_BYTES { return Ok(false); }
    }
    Ok(true)
}

fn local_snapshot_parent() -> Result<PathBuf, String> {
    let parent = home_dir()?.join(".pi-desktop/git-snapshots"); fs::create_dir_all(&parent).map_err(|error| error.to_string())?; Ok(parent)
}

fn prune_local_snapshots(parent: &Path) {
    let mut snapshots: Vec<_> = fs::read_dir(parent).into_iter().flatten().filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) && entry.file_name().to_string_lossy().starts_with("pi-desktop-diff-"))
        .filter_map(|entry| Some((entry.path(), entry.metadata().ok()?.modified().ok()?))).collect();
    snapshots.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    for (index, (path, modified)) in snapshots.into_iter().enumerate() {
        let stale = SystemTime::now().duration_since(modified).unwrap_or_default() > Duration::from_secs(24 * 60 * 60);
        if stale || index >= 32 { let _ = fs::remove_dir_all(path); }
    }
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
    let snapshot_parent = local_snapshot_parent()?; prune_local_snapshots(&snapshot_parent);
    let snapshot_root = snapshot_parent.join(format!("pi-desktop-diff-{}", Uuid::new_v4()));
    let objects = snapshot_root.join("objects"); let index = snapshot_root.join("index");
    fs::create_dir_all(&objects).map_err(|error| format!("Could not create Git snapshot: {error}"))?;
    let has_head = Command::new("git").args(["-C", cwd, "rev-parse", "--verify", "HEAD"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|status| status.success()).unwrap_or(false);
    let result = (|| {
        let configure = |command: &mut Command| { command.env("GIT_INDEX_FILE", &index).env("GIT_OBJECT_DIRECTORY", &objects).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &repository_objects); };
        let mut read_tree = Command::new("git"); read_tree.args(["-C", cwd, "read-tree"]); if has_head { read_tree.arg("HEAD"); } else { read_tree.arg("--empty"); } configure(&mut read_tree);
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
fn git_branch() -> Result<Option<String>, String> {
    let output = Command::new("git").args(["-C", env!("CARGO_MANIFEST_DIR"), "rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|error| format!("Could not read Pi Desktop Git branch: {error}"))?;
    if !output.status.success() { return Ok(None); }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!branch.is_empty()).then_some(branch))
}

fn valid_remote_snapshot(snapshot: &GitSnapshotToken) -> bool {
    snapshot.root.contains("/.pi-desktop/git-snapshots/pi-desktop-diff-") && snapshot.root.rsplit('/').next().is_some_and(|name| name.starts_with("pi-desktop-diff-")) && snapshot.tree.len() >= 40 && snapshot.tree.len() <= 64 && snapshot.tree.chars().all(|character| character.is_ascii_hexdigit())
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let directory = shell_quote(cwd);
    let name = format!("pi-desktop-diff-{}", Uuid::new_v4());
    let script = format!("cd {directory} || exit 2; root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3; [ \"$(pwd -P)\" = \"$(cd \"$root\" && pwd -P)\" ] || exit 4; parent=\"$HOME/.pi-desktop/git-snapshots\"; mkdir -p \"$parent\" || exit 5; find \"$parent\" -mindepth 1 -maxdepth 1 -type d -name 'pi-desktop-diff-*' -mmin +60 -exec rm -rf -- {{}} + 2>/dev/null; snap=\"$parent/{name}\"; mkdir -p \"$snap/objects\" || exit 5; trap 'test -n \"$failed\" && rm -rf -- \"$snap\"' EXIT; repo_objects=$(git rev-parse --git-path objects) || exit 5; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 5; export GIT_INDEX_FILE=\"$snap/index\" GIT_OBJECT_DIRECTORY=\"$snap/objects\" GIT_ALTERNATE_OBJECT_DIRECTORIES=\"$repo_objects\"; if git rev-parse --verify HEAD >/dev/null 2>&1; then git read-tree HEAD; else git read-tree --empty; fi && git add -A -- . && tree=$(git write-tree) || {{ failed=1; exit 5; }}; size=$(du -sk \"$snap\" | awk '{{print $1}}'); if [ \"${{size:-999999}}\" -gt 32768 ]; then failed=1; exit 6; fi; printf '%s\n%s\n' \"$(cd \"$snap\" && pwd -P)\" \"$tree\"");
    let mut command = ssh(host); command.arg(script); let output = run_limited(&mut command, 64 * 1024, &format!("Could not capture Git snapshot on {}", host.name))?;
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
    let output = ssh(host).arg(format!("rm -rf -- {}", shell_quote(&snapshot.root))).output().map_err(|error| format!("Could not discard Git snapshot on {}: {error}", host.name))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[tauri::command(async)]
fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { return local_git_diff(&cwd, &base_tree); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let base: GitSnapshotToken = serde_json::from_str(&base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) { return Err("Invalid remote Git snapshot location".into()); }
    let Some(current_token) = remote_git_tree(host, &cwd)? else { let _ = ssh(host).arg(format!("rm -rf -- {}", shell_quote(&base.root))).status(); return Ok(None) };
    let current: GitSnapshotToken = serde_json::from_str(&current_token).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    let script = format!("cd {} || exit 2; trap 'rm -rf -- {} {}' EXIT; repo_objects=$(git rev-parse --git-path objects) || exit 3; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 3; GIT_OBJECT_DIRECTORY={} GIT_ALTERNATE_OBJECT_DIRECTORIES={}:\"$repo_objects\" git diff --no-color --no-ext-diff --find-renames {} {} --", shell_quote(&cwd), shell_quote(&base.root), shell_quote(&current.root), shell_quote(&format!("{}/objects", current.root)), shell_quote(&format!("{}/objects", base.root)), shell_quote(&base.tree), shell_quote(&current.tree));
    let mut command = ssh(host); command.arg(script); let output = run_limited(&mut command, MAX_GIT_PATCH_BYTES, &format!("Git patch on {} is too large", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(patch))
}

fn git_diffs_path(session_path: &str) -> PathBuf { Path::new(session_path).with_extension("diffs.json") }

#[tauri::command(async)]
fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<GitDiffSnapshots, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); let path = git_diffs_path(&session_path);
    let content = if host_id == "local" {
        if !path.exists() { return Ok(HashMap::new()); }
        if fs::metadata(&path).map_err(|error| format!("Could not inspect saved diffs: {error}"))?.len() > MAX_GIT_DIFFS_BYTES as u64 { return Err("Saved diffs exceed the 16 MiB limit".into()); }
        fs::read_to_string(&path).map_err(|error| format!("Could not read saved diffs: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let mut command = ssh(host); command.arg(format!("if [ -f {0} ]; then cat -- {0}; else printf '{{}}'; fi", shell_quote(&path.to_string_lossy())));
        let output = run_limited(&mut command, MAX_GIT_DIFFS_BYTES, &format!("Saved diffs on {} exceed the limit", host.name))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Saved remote diffs were not valid UTF-8".to_string())?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

#[tauri::command(async)]
fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); let path = git_diffs_path(&session_path);
    let body = serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?;
    if body.len() > MAX_GIT_DIFFS_BYTES { return Err("Diff history exceeds the 16 MiB limit".into()); }
    if host_id == "local" { return fs::write(path, body).map_err(|error| format!("Could not save diffs: {error}")); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let output = ssh(host).arg(format!("printf %s {} > {}", shell_quote(&body), shell_quote(&path.to_string_lossy()))).output().map_err(|error| format!("Could not save diffs on {}: {error}", host.name))?;
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
        fs::copy(source, &path).map_err(|error| format!("Could not create temporary side conversation: {error}"))?;
        return Ok((path.to_string_lossy().into_owned(), EphemeralSession::Local(path)));
    }
    let host = remote_host(settings, host_id)?.clone();
    let remote = format!(r#"root=$(cd "$HOME/.pi-desktop/sessions" && pwd -P) && source=$(realpath -- {}) && case "$source" in "$root"/*.jsonl) temporary=$(mktemp "${{TMPDIR:-/tmp}}/pi-desktop-btw.XXXXXX") && cp -- "$source" "$temporary" && printf %s "$temporary" ;; *) printf 'Refusing to fork a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(source_path));
    let output = ssh(&host).arg(remote).output().map_err(|error| format!("Could not create temporary side conversation on {}: {error}", host.name))?;
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
    let broker = shell_quote(include_str!("../resources/session-broker.ts"));
    let trace_reader = shell_quote(include_str!("../resources/trace-reader.ts"));
    let btw = shell_quote(include_str!("../resources/btw.ts"));
    let orchestration = shell_quote(include_str!("../../extensions/pi-orchestration/index.ts"));
    let context_window_cap = shell_quote(include_str!("../../extensions/pi-context-window-cap/index.ts"));
    let context_window_config = shell_quote(&serde_json::to_string_pretty(&json!({ "contextWindowCap": settings.context_window_cap })).map_err(|error| error.to_string())?);
    let mcp_bridge = shell_quote(include_str!("../resources/mcp-bridge.bundle.mjs"));
    let mcp_config = shell_quote(&serde_json::to_string_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?);
    let remote = format!("mkdir -p \"$HOME/.pi-desktop/sessions\" \"$HOME/.pi-desktop/pi-context-window-cap\" \"$HOME/.pi/agent/extensions/pi-orchestration\" && printf %s {broker} > \"$HOME/.pi-desktop/session-broker.ts\" && printf %s {trace_reader} > \"$HOME/.pi-desktop/pi-desktop-trace-reader.ts\" && printf %s {mcp_bridge} > \"$HOME/.pi-desktop/pi-desktop-mcp-bridge.ts\" && printf %s {mcp_config} > \"$HOME/.pi-desktop/mcp-servers.json\" && printf %s {context_window_cap} > \"$HOME/.pi-desktop/pi-context-window-cap/index.ts\" && printf %s {context_window_config} > \"$HOME/.pi-desktop/pi-context-window-cap/config.json\" && printf %s {btw} > \"$HOME/.pi/agent/extensions/pi-desktop-btw.ts\" && printf %s {orchestration} > \"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\"");
    let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not install Pi Desktop extensions on {}: {error}", host.name))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

enum PiLaunch<'a> {
    Rpc { cwd: Option<&'a str>, session_path: Option<&'a str>, session_id: Option<&'a str>, fork_path: Option<&'a str>, no_session: bool },
    Print { cwd: &'a str, session_path: &'a str, message: &'a str },
}

fn build_pi_command(app: &AppHandle, broker: &BrokerRuntime, settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>) -> Result<Command, String> {
    let (broker_port, broker_token) = broker_environment(broker)?;
    let enabled_tools = enabled_tool_names(settings); let allowed_tools = serde_json::to_string(&enabled_tools).unwrap_or_else(|_| "[]".into());
    let disabled_tools: Vec<&str> = settings.tools.iter().filter(|tool| !tool.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
    let desktop_home = home_dir()?;
    let local_skills: Vec<PathBuf> = settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, &desktop_home))).collect();
    let local_skills = serde_json::to_string(&local_skills).unwrap_or_else(|_| "[]".into());
    let remote_skills: Vec<&str> = settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect();
    let remote_skills = serde_json::to_string(&remote_skills).unwrap_or_else(|_| "[]".into());
    let is_rpc = matches!(launch, PiLaunch::Rpc { .. }); let print_message = match &launch { PiLaunch::Print { message, .. } => Some(*message), PiLaunch::Rpc { .. } => None };
    let default_model = std::env::var("PI_DESKTOP_E2E_MODEL").ok().filter(|model| !model.trim().is_empty()).unwrap_or_else(|| settings.default_model.clone());
    if host_id == "local" {
        let (mcp_extension, mcp_config) = prepare_mcp_bridge(app, settings)?; let context_window_cap_extension = prepare_context_window_cap_extension(app, settings)?; let trace_reader_extension = prepare_trace_reader(app)?; let pi_path = pi_executable();
        let session_dir = ensure_desktop_sessions_dir(&desktop_home)?;
        let mut command = Command::new(&pi_path); command.arg(if is_rpc { "--mode" } else { "--print" }); if is_rpc { command.arg("rpc"); }
        command.arg("--session-dir").arg(session_dir).arg("--approve").arg("--no-skills").arg("--extension").arg(mcp_extension).arg("--extension").arg(prepare_session_broker(app)?).arg("--extension").arg(&trace_reader_extension).arg("--extension").arg(&context_window_cap_extension)
            .env("PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION", &context_window_cap_extension).env("PI_DESKTOP_TRACE_READER_EXTENSION", &trace_reader_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config).env("PI_DESKTOP_BROKER_URL", format!("http://127.0.0.1:{broker_port}")).env("PI_DESKTOP_BROKER_TOKEN", &broker_token).env("PI_DESKTOP_ALLOWED_TOOLS", &allowed_tools).env("PI_DESKTOP_SKILL_PATHS", &local_skills);
        match launch {
            PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => {
                let working_dir = match cwd { Some("~") => home_dir()?, Some(path) => PathBuf::from(path), None => std::env::current_dir().map_err(|error| error.to_string())? };
                prepare_btw_extension()?;
                command.current_dir(working_dir).env("PI_DESKTOP_BTW", "1").env("PI_DESKTOP_PI_EXECUTABLE", &pi_path);
                if let Some(path) = fork_path { command.arg("--fork").arg(path); } else if let Some(path) = session_path { command.arg("--session").arg(path); } else if let Some(id) = session_id { command.arg("--session-id").arg(id); }
                if no_session { command.arg("--no-session"); }
            }
            PiLaunch::Print { cwd, session_path, .. } => { command.current_dir(cwd).arg("--session").arg(session_path); }
        }
        if !disabled_tools.is_empty() { command.arg("--exclude-tools").arg(disabled_tools.join(",")); }
        if !is_rpc && !default_model.trim().is_empty() { command.arg("--model").arg(default_model.trim()); }
        if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
        if let Some(message) = print_message { command.arg(message); }
        return Ok(command);
    }
    let host = remote_host(settings, host_id)?; stage_remote_extensions(host, settings)?; let remote_port = remote_broker_port(); let remote_pi = remote_pi_path(&host.pi_path);
    let mut arguments = vec![remote_pi.clone()]; if is_rpc { arguments.extend(["--mode".into(), "rpc".into()]); } else { arguments.push("--print".into()); }
    arguments.extend(["--session-dir".into(), "\"$HOME/.pi-desktop/sessions\"".into(), "--approve".into(), "--no-skills".into(), "--extension".into(), "\"$HOME/.pi-desktop/pi-desktop-mcp-bridge.ts\"".into(), "--extension".into(), "\"$HOME/.pi-desktop/session-broker.ts\"".into(), "--extension".into(), "\"$HOME/.pi-desktop/pi-desktop-trace-reader.ts\"".into(), "--extension".into(), "\"$HOME/.pi-desktop/pi-context-window-cap/index.ts\"".into(), "--extension".into(), "\"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\"".into()]);
    let cwd = match launch {
        PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => { if let Some(path) = fork_path { arguments.extend(["--fork".into(), shell_quote(path)]); } else if let Some(path) = session_path { arguments.extend(["--session".into(), shell_quote(path)]); } else if let Some(id) = session_id { arguments.extend(["--session-id".into(), shell_quote(id)]); } if no_session { arguments.push("--no-session".into()); } cwd },
        PiLaunch::Print { cwd, session_path, .. } => { arguments.extend(["--session".into(), shell_quote(session_path)]); Some(cwd) },
    };
    if !disabled_tools.is_empty() { arguments.extend(["--exclude-tools".into(), shell_quote(&disabled_tools.join(","))]); }
    if !is_rpc && !default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(default_model.trim())]); }
    if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
    if let Some(message) = print_message { arguments.push(shell_quote(message)); }
    let rpc_environment = if is_rpc { format!(" PI_DESKTOP_BTW=1 PI_DESKTOP_PI_EXECUTABLE={remote_pi}") } else { String::new() };
    let remote = format!("cd {} && PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION=\"$HOME/.pi-desktop/pi-context-window-cap/index.ts\" PI_DESKTOP_TRACE_READER_EXTENSION=\"$HOME/.pi-desktop/pi-desktop-trace-reader.ts\" PI_DESKTOP_MCP_CONFIG=\"$HOME/.pi-desktop/mcp-servers.json\" PI_DESKTOP_BROKER_URL={} PI_DESKTOP_BROKER_TOKEN={} PI_DESKTOP_ALLOWED_TOOLS={} PI_DESKTOP_SKILL_PATHS={}{} exec {}", remote_directory_path(cwd), shell_quote(&format!("http://127.0.0.1:{remote_port}")), shell_quote(&broker_token), shell_quote(&allowed_tools), shell_quote(&remote_skills), rpc_environment, arguments.join(" "));
    let mut command = remote_broker_command(host, broker_port, remote_port); command.arg(remote); Ok(command)
}

#[tauri::command(async)]
fn start_pi(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, no_session: Option<bool>, host_id: Option<String>) -> Result<(), String> {
    let stale = {
        let mut processes = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        match processes.get_mut(&runtime_id).map(|process| process.child.try_wait()) {
            Some(Ok(None)) => return Ok(()),
            Some(_) => processes.remove(&runtime_id),
            None => None,
        }
    };
    if let Some(mut process) = stale { let _ = process.child.wait(); if let Some(session) = process.ephemeral_session { remove_ephemeral_session(session); } }
    let settings = load_app_settings(app.clone())?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let ephemeral = no_session.unwrap_or(false);
    let (ephemeral_path, ephemeral_session) = if ephemeral {
        match fork_path.as_deref() {
            Some(source_path) => { let (path, cleanup) = create_ephemeral_fork(&settings, &host_id, source_path)?; (Some(path), Some(cleanup)) }
            None => (None, None),
        }
    } else { (None, None) };
    let launch_session_path = ephemeral_path.as_deref().or(session_path.as_deref());
    let launch_fork_path = if ephemeral_path.is_some() { None } else { fork_path.as_deref() };
    let mut command = match build_pi_command(&app, &broker, &settings, &host_id, PiLaunch::Rpc { cwd: cwd.as_deref(), session_path: launch_session_path, session_id: session_id.as_deref(), fork_path: launch_fork_path, no_session: ephemeral && ephemeral_path.is_none() }) {
        Ok(command) => command,
        Err(error) => { if let Some(cleanup) = ephemeral_session { remove_ephemeral_session(cleanup); } return Err(error); }
    };
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => { if let Some(cleanup) = ephemeral_session { remove_ephemeral_session(cleanup); } return Err(format!("Could not start pi: {error}")); }
    };
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("Pi stdin was unavailable")?));
    let stdout = child.stdout.take().ok_or("Pi stdout was unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi stderr was unavailable")?;
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { child, stdin: stdin.clone(), ephemeral_session });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id.clone(), AgentAddress { host_id: host_id.clone(), session_id: session_id.clone(), session_path: session_path.clone() });
    let pending = runtime.pending.clone(); let processes = runtime.processes.clone(); let active_agents = runtime.active_agents.clone(); let event_app = app.clone(); let event_runtime_id = runtime_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n') {
            let Ok(bytes) = line else { break }; let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if value.get("type") == Some(&Value::String("response".into())) {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&(event_runtime_id.clone(), id.to_string()))) {
                        let result = if value.get("success").and_then(Value::as_bool).unwrap_or(false) { Ok(value.get("data").cloned().unwrap_or(Value::Null)) } else { Err(value.get("error").and_then(Value::as_str).unwrap_or("Pi command failed").to_string()) };
                        let _ = sender.send(result); continue;
                    }
                }
            }
            let _ = event_app.emit("pi://event", json!({"runtimeId":event_runtime_id,"event":value}));
        }
        let exited = processes.lock().ok().and_then(|mut values| values.remove(&event_runtime_id));
        if let Some(mut process) = exited { let _ = process.child.wait(); if let Some(session) = process.ephemeral_session { remove_ephemeral_session(session); } }
        if let Ok(mut agents) = active_agents.lock() { agents.remove(&event_runtime_id); }
        fail_pending(&pending, &event_runtime_id, "Pi disconnected before responding");
        let _ = event_app.emit("pi://event", json!({"runtimeId":event_runtime_id,"event":{"type":"disconnected"}}));
    });
    let error_app = app.clone(); let error_runtime_id = runtime_id.clone();
    thread::spawn(move || for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = error_app.emit("pi://stderr", json!({"runtimeId":error_runtime_id,"line":line})); });
    Ok(())
}

#[tauri::command(async)]
fn stop_pi(runtime: State<PiRuntime>, runtime_id: String) -> Result<(), String> {
    let process = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(&runtime_id);
    if let Some(mut process) = process { let _ = process.child.kill(); let _ = process.child.wait(); if let Some(session) = process.ephemeral_session { remove_ephemeral_session(session); } }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(&runtime_id);
    fail_pending(&runtime.pending, &runtime_id, "Pi disconnected before responding");
    Ok(())
}

fn execute_pi_command(runtime: &PiRuntime, runtime_id: &str, mut command: Value) -> Result<Value, String> {
    let fire_and_forget = command.get("type").and_then(Value::as_str) == Some("extension_ui_response");
    let id = command.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
    command.as_object_mut().ok_or("RPC command must be an object")?.insert("id".into(), Value::String(id.clone()));
    let (sender, receiver) = mpsc::channel();
    runtime.pending.lock().map_err(|_| "Pending command lock was poisoned")?.insert((runtime_id.to_string(), id.clone()), sender);
    let write_result = (|| {
        let process_guard = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        let process = process_guard.get(runtime_id).ok_or("Pi is not running")?;
        let mut stdin = process.stdin.lock().map_err(|_| "Pi stdin lock was poisoned")?;
        serde_json::to_writer(&mut *stdin, &command).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
    })();
    if let Err(error) = write_result { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.to_string(), id.clone()))); return Err(error); }
    if fire_and_forget { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.to_string(), id.clone()))); return Ok(Value::Null); }
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.to_string(), id))); "Pi command timed out".to_string() })?
}

fn update_active_agent(runtime: &PiRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
    let mut agents = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?;
    let Some(agent) = agents.get_mut(runtime_id) else { return Ok(()); };
    agent.session_id = state.get("sessionId").and_then(Value::as_str).map(str::to_owned);
    agent.session_path = state.get("sessionFile").and_then(Value::as_str).map(str::to_owned);
    Ok(())
}

#[tauri::command(async)]
fn pi_command(runtime: State<PiRuntime>, runtime_id: String, command: Value) -> Result<Value, String> {
    let command_type = command.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let result = execute_pi_command(&runtime, &runtime_id, command)?;
    if command_type == "get_state" { update_active_agent(&runtime, &runtime_id, &result)?; }
    else if matches!(command_type.as_str(), "fork" | "clone" | "new_session") {
        if let Ok(state) = execute_pi_command(&runtime, &runtime_id, json!({"type":"get_state"})) { update_active_agent(&runtime, &runtime_id, &state)?; }
    }
    Ok(result)
}

#[tauri::command]
fn start_terminal(app: AppHandle, runtime: State<TerminalRuntime>, terminal_id: String, cwd: String, cols: u16, rows: u16, host_id: Option<String>) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if processes.contains_key(&terminal_id) { return Ok(()); }
    if processes.len() >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals may run at once")); }
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
    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
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
    processes.insert(terminal_id, TerminalProcess { master: pair.master, child, writer });
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
    process.writer.write_all(data.as_bytes()).and_then(|_| process.writer.flush()).map_err(|error| error.to_string())
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

fn open_system_path(path: &Path) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else if cfg!(target_os = "windows") { "explorer" } else { "xdg-open" };
    Command::new(program).arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    Ok(())
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
    open_system_path(&path)
}

fn text_content(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| if part.get("type") == Some(&Value::String("text".into())) { part.get("text").and_then(Value::as_str) } else { None }).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

fn unix_timestamp(time: SystemTime) -> u64 { time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() }

fn parse_session_content(path: &Path, content: &str, modified: SystemTime, cwd_exists: bool, host_id: &str, host_name: &str) -> Option<SessionSummary> {
    let mut lines = content.lines(); let header: Value = serde_json::from_str(lines.next()?).ok()?;
    if header.get("type")?.as_str()? != "session" { return None; }
    let cwd = header.get("cwd").and_then(Value::as_str).unwrap_or("Unknown project").to_string();
    let id = header.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut name = None; let mut first_user_message = String::new(); let mut preview = String::new(); let mut message_count = 0; let mut api_cost = 0.0;
    for line in lines { let Ok(entry) = serde_json::from_str::<Value>(line) else { continue }; if entry.get("type").and_then(Value::as_str) == Some("session_info") { name = entry.get("name").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned); } if entry.get("type").and_then(Value::as_str) == Some("message") { message_count += 1; if let Some(message) = entry.get("message") { let text = text_content(message); if !text.is_empty() { if first_user_message.is_empty() && message.get("role").and_then(Value::as_str) == Some("user") { first_user_message = text.clone(); } preview = text; } if message.get("role").and_then(Value::as_str) == Some("assistant") { api_cost += message.pointer("/usage/cost/total").and_then(Value::as_f64).filter(|cost| cost.is_finite() && *cost >= 0.0).unwrap_or(0.0); } } } }
    let name = name.unwrap_or_else(|| if first_user_message.is_empty() { "Untitled session".into() } else { first_user_message });
    let project = Path::new(&cwd).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").to_string();
    Some(SessionSummary { id, path: path.to_string_lossy().into_owned(), name, project, cwd, cwd_exists, modified_at: unix_timestamp(modified), preview: preview.chars().take(100).collect(), message_count, api_cost, host_id: host_id.into(), host_name: host_name.into() })
}

fn list_local_sessions(index: &SessionIndexRuntime, root: &Path) -> Result<Vec<SessionSummary>, String> {
    let mut cache = index.local.lock().map_err(|_| "Local session index lock was poisoned")?;
    let mut seen = HashSet::new(); let mut sessions = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")) {
        let path = entry.path().to_path_buf(); let Ok(metadata) = entry.metadata() else { continue };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let fingerprint = format!("{}:{}", modified.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos(), metadata.len());
        seen.insert(path.clone());
        let mut summary = if let Some(cached) = cache.get(&path).filter(|cached| cached.fingerprint == fingerprint) { cached.summary.clone() } else {
            let Ok(content) = fs::read_to_string(&path) else { continue };
            let Some(summary) = parse_session_content(&path, &content, modified, true, "local", "Local") else { continue };
            cache.insert(path.clone(), CachedSession { fingerprint, summary: summary.clone() }); summary
        };
        summary.cwd_exists = Path::new(&summary.cwd).is_dir(); sessions.push(summary);
    }
    cache.retain(|path, _| seen.contains(path)); Ok(sessions)
}

fn list_remote_sessions(index: &SessionIndexRuntime, host: &RemoteHost) -> Result<Vec<SessionSummary>, String> {
    let script = r#"mkdir -p "$HOME/.pi-desktop/sessions" && find "$HOME/.pi-desktop/sessions" -type f -name '*.jsonl' -printf '%p\000%T@\000%s\000' 2>/dev/null"#;
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not run ssh for {}: {error}", host.name))?;
    if !output.status.success() { return Err(format!("Could not list sessions on {}: {}", host.name, String::from_utf8_lossy(&output.stderr).trim())); }
    let fields: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).filter(|field| !field.is_empty()).collect();
    let metadata: Vec<(String, String, u64)> = fields.chunks(3).filter_map(|frame| {
        if frame.len() != 3 { return None; }
        let path = String::from_utf8_lossy(frame[0]).into_owned(); let modified = String::from_utf8_lossy(frame[1]).into_owned(); let size = String::from_utf8_lossy(frame[2]).into_owned();
        let seconds = modified.split('.').next().and_then(|value| value.parse().ok()).unwrap_or(0);
        Some((path, format!("{modified}:{size}"), seconds))
    }).collect();
    let previous = index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.get(&host.id).cloned().unwrap_or_default();
    let changed: Vec<_> = metadata.iter().filter(|(path, fingerprint, _)| previous.get(path).is_none_or(|cached| cached.fingerprint != *fingerprint)).collect();
    let mut parsed = HashMap::new();
    for batch in changed.chunks(128) {
        let paths = batch.iter().map(|(path, _, _)| shell_quote(path)).collect::<Vec<_>>().join(" ");
        let command = format!(r#"sh -c 'for path do printf "%s\000" "$path"; cat -- "$path"; printf "\000"; done' sh {paths}"#);
        let output = ssh(host).arg(command).output().map_err(|error| format!("Could not update session index on {}: {error}", host.name))?;
        if !output.status.success() { return Err(format!("Could not update session index on {}: {}", host.name, String::from_utf8_lossy(&output.stderr).trim())); }
        let frames: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
        for frame in frames.chunks(2) {
            if frame.len() != 2 || frame[0].is_empty() { continue; }
            let path = String::from_utf8_lossy(frame[0]).into_owned(); let Some((_, _, seconds)) = metadata.iter().find(|(candidate, _, _)| candidate == &path) else { continue };
            let content = String::from_utf8_lossy(frame[1]); let path_buf = PathBuf::from(&path);
            if let Some(summary) = parse_session_content(&path_buf, &content, SystemTime::UNIX_EPOCH + Duration::from_secs(*seconds), true, &host.id, &host.name) { parsed.insert(path, summary); }
        }
    }
    let mut next = HashMap::new(); let mut sessions = Vec::new();
    for (path, fingerprint, _) in metadata {
        let mut summary = if let Some(summary) = parsed.remove(&path) { summary } else if let Some(cached) = previous.get(&path) { cached.summary.clone() } else { continue };
        summary.host_name = host.name.clone(); sessions.push(summary.clone()); next.insert(path, CachedSession { fingerprint, summary });
    }
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
    let cwd = home.join("pi-desktop/tmp").join(session_id);
    fs::create_dir_all(&cwd).map_err(|error| format!("Could not create temporary chat directory: {error}"))?;
    fs::write(cwd.join(".pi-desktop-temporary-chat"), b"").map_err(|error| format!("Could not mark temporary chat directory: {error}"))?;
    Ok(cwd)
}

fn temporary_chat_id(path: &str) -> Option<&str> {
    let value = Path::new(path); let id = value.file_name()?.to_str()?;
    Uuid::parse_str(id).ok()?;
    (value.parent()?.file_name()?.to_str()? == "tmp" && value.parent()?.parent()?.file_name()?.to_str()? == "pi-desktop").then_some(id)
}

#[tauri::command(async)]
fn remove_temporary_chat(app: AppHandle, path: String, host_id: String) -> Result<(), String> {
    temporary_chat_id(&path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    if host_id == "local" {
        let expected_root = home_dir()?.join("pi-desktop/tmp");
        let candidate = PathBuf::from(&path);
        if candidate.parent() != Some(expected_root.as_path()) { return Err("Refusing to remove a directory outside the temporary chat root".into()); }
        if !candidate.join(".pi-desktop-temporary-chat").is_file() { return Err("Refusing to remove an unmarked directory".into()); }
        if candidate.exists() { fs::remove_dir_all(candidate).map_err(|error| format!("Could not remove temporary chat directory: {error}"))?; }
        return Ok(());
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let script = format!("candidate={}; root=\"$HOME/pi-desktop/tmp\"; [ \"$(dirname -- \"$candidate\")\" = \"$root\" ] && [ -f \"$candidate/.pi-desktop-temporary-chat\" ] && rm -rf -- \"$candidate\"", shell_quote(&path));
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
        let remote = format!("mkdir -p \"$HOME/pi-desktop/tmp/{session_id}\" && : > \"$HOME/pi-desktop/tmp/{session_id}/.pi-desktop-temporary-chat\" && cd \"$HOME/pi-desktop/tmp/{session_id}\" && pwd -P");
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
    sessions.sort_by(|left, right| right.modified_at.cmp(&left.modified_at)); Ok(sessions)
}

#[tauri::command(async)]
fn list_sessions(app: AppHandle, index: State<SessionIndexRuntime>) -> Result<Vec<SessionSummary>, String> { collect_sessions(&app, &index) }

fn local_desktop_session_file(session_path: &str) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(&home_dir()?).canonicalize().map_err(|error| format!("Could not locate Pi Desktop sessions: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only Pi Desktop session files can be accessed".into()); }
    Ok(source)
}

#[tauri::command(async)]
fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, terminal_ids: Vec<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let file_name = Path::new(&session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
        let destination = format!("{}-{file_name}", Uuid::new_v4());
        let diff_destination = Path::new(&destination).with_extension("diffs.json").to_string_lossy().into_owned();
        let remote = format!(r#"root=$(cd "$HOME/.pi-desktop/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) archive="$HOME/.pi-desktop/archived"; mkdir -p "$archive" || exit 1; diff=${{target%.jsonl}}.diffs.json; diff_target="$archive"/{}; moved_diff=0; if [ -f "$diff" ]; then mv -- "$diff" "$diff_target" || exit 1; moved_diff=1; fi; if ! mv -- "$target" "$archive"/{}; then if [ "$moved_diff" = 1 ]; then mv -- "$diff_target" "$diff" || true; fi; exit 1; fi ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(&session_path), shell_quote(&diff_destination), shell_quote(&destination));
        let output = ssh(host).arg(remote).output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let _ = stop_terminals(&runtime, &terminal_ids);
        return Ok(());
    }
    let source = local_desktop_session_file(&session_path)?;
    let archive_dir = home_dir()?.join(".pi-desktop/archived");
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
fn delete_session(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let remote = format!(r#"root=$(cd "$HOME/.pi-desktop/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) diff=${{target%.jsonl}}.diffs.json; rm -- "$target"; rm -f -- "$diff" ;; *) printf 'Refusing to delete a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(&session_path));
        let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not delete session on {}: {error}", host.name))?;
        return output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let source = local_desktop_session_file(&session_path)?;
    fs::remove_file(&source).map_err(|error| format!("Could not delete session: {error}"))?;
    let diff_path = source.with_extension("diffs.json"); if diff_path.exists() { fs::remove_file(diff_path).map_err(|error| format!("Session deleted, but its diffs could not be deleted: {error}"))?; }
    Ok(())
}

#[tauri::command(async)]
fn relocate_session(session_path: String, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" { return Err("Relocating remote sessions is not supported yet".into()); }
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
        return Err("Cannot message the session currently open in Pi Desktop".into());
    }
    Ok(session)
}

fn agent_is_active(session: &SessionSummary, agent: &AgentAddress) -> bool {
    agent.host_id == session.host_id && (agent.session_id.as_deref() == Some(session.id.as_str()) || agent.session_path.as_deref() == Some(session.path.as_str()))
}

fn dispatch_agent_message(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, message: &str, request_id: &str) -> Result<String, String> {
    let settings = load_app_settings(app.clone())?;
    let mut command = build_pi_command(app, broker, &settings, &session.host_id, PiLaunch::Print { cwd: &session.cwd, session_path: &session.path, message })?;
    let output_root = std::env::temp_dir().join(format!("pi-desktop-broker-{}", Uuid::new_v4()));
    fs::create_dir(&output_root).map_err(|error| format!("Could not prepare agent message: {error}"))?;
    let stdout_path = output_root.join("stdout"); let stderr_path = output_root.join("stderr");
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("Could not capture agent output: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("Could not capture agent errors: {error}"))?;
    command.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.remove(request_id) { let _ = fs::remove_dir_all(&output_root); return Err("Agent message was cancelled".into()); }
    let spawned = command.spawn();
    let child = match spawned { Ok(child) => Arc::new(Mutex::new(child)), Err(error) => { let _ = fs::remove_dir_all(&output_root); return Err(format!("Could not message agent: {error}")); } };
    match broker.jobs.lock() { Ok(mut jobs) => { jobs.insert(request_id.to_string(), child.clone()); }, Err(_) => { if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); } let _ = fs::remove_dir_all(&output_root); return Err("Broker job lock was poisoned".into()); } }
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.contains(request_id) {
            if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
            break Err("Agent message was cancelled".to_string());
        }
        let status = child.lock().map_err(|_| "Agent process lock was poisoned")?.try_wait().map_err(|error| format!("Could not wait for agent: {error}"))?;
        if let Some(status) = status { break Ok(status); }
        if Instant::now() >= deadline {
            if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
            break Err("Agent message timed out after 120 seconds".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    };
    broker.jobs.lock().ok().map(|mut jobs| jobs.remove(request_id));
    broker.cancelled.lock().ok().map(|mut cancelled| cancelled.remove(request_id));
    let stdout = fs::read(&stdout_path).unwrap_or_default(); let stderr = fs::read(&stderr_path).unwrap_or_default(); let _ = fs::remove_dir_all(&output_root);
    let status = status?;
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
    let session_index = app.state::<SessionIndexRuntime>();
    let result = match (method, path) {
        ("GET", "/agents") => {
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            collect_sessions(&app, &session_index).map(|sessions| json!(sessions.into_iter().map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
        },
        ("POST", "/message") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid message request".to_string())?;
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let host_id = value.get("hostId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("hostId is required")?;
            let session_id = value.get("sessionId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("sessionId is required")?;
            let message = value.get("message").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("message is required")?;
            let sessions = collect_sessions(&app, &session_index)?;
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            let session = resolve_agent(&sessions, host_id, session_id, &active)?;
            let _claim = claim_agent(&broker, host_id, session_id)?;
            dispatch_agent_message(&app, &broker, session, message, request_id).map(|reply| json!({"reply":reply}))
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

fn apply_start_bounds(app: &AppHandle) {
    let Ok(bounds) = std::env::var("PI_START_BOUNDS") else { return };
    let mut values = bounds.split(',');
    let (Some(x), Some(y), Some(width), Some(height), None) = (values.next(), values.next(), values.next(), values.next(), values.next()) else { return };
    let (Ok(x), Ok(y), Ok(width), Ok(height)) = (x.parse::<i32>(), y.parse::<i32>(), width.parse::<u32>(), height.parse::<u32>()) else { return };
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

pub fn run() {
    let broker = BrokerRuntime::default();
    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder.plugin(tauri_plugin_dialog::init()).manage(PiRuntime::default()).manage(TerminalRuntime::default()).manage(SessionIndexRuntime::default()).manage(broker.clone()).setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
        start_session_broker(app.handle().clone(), broker.clone()).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
        let app_handle = app.handle().clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            apply_start_bounds(&app_handle);
        });
        Ok(())
    }).invoke_handler(tauri::generate_handler![start_pi, stop_pi, pi_command, start_terminal, write_terminal, resize_terminal, close_terminal, list_sessions, home_directory, create_temporary_chat, remove_temporary_chat, validate_project_directory, list_directories, git_branch, capture_git_tree, discard_git_tree, load_git_diff, load_git_diffs, save_git_diffs, archive_session, delete_session, relocate_session, open_project_directory, load_app_settings, save_app_settings, codex_usage]).run(tauri::generate_context!()).expect("error while running Pi desktop");
}
