mod mobile;
mod mobile_commands;
mod session_groups;
mod daemon;
mod voice;
use voice::{voice_configuration, voice_start, voice_stop, voice_mute, voice_suppress, voice_context};
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
    sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
    time::{Duration, Instant, SystemTime},
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

const STORAGE_DIRECTORY: &str = if cfg!(debug_assertions) { ".piop-dev" } else { ".piop" };
const DEVELOPMENT: bool = cfg!(debug_assertions);
const APP_TITLE: &str = if DEVELOPMENT { "Piop Dev" } else { "piop" };

fn node_command() -> Command {
    let mut command = Command::new("node");
    command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY);
    command
}

struct PiProcess {
    daemon: Arc<daemon::Daemon>,
    window_label: String,
    blank_cleanup: BlankSessionCleanup,
}

struct BlankSessionCleanup { path: Option<String>, id: Option<String>, host: Option<RemoteHost>, submitted: bool }

fn cleanup_blank_session(target: BlankSessionCleanup) {
    if target.submitted { return; }
    let root = if target.host.is_none() { home_dir().ok().map(|home| home.join(STORAGE_DIRECTORY).join("sessions")) } else { None };
    cleanup_blank_session_at(target, root.as_deref());
}

fn cleanup_blank_session_at(target: BlankSessionCleanup, root: Option<&Path>) {
    if target.submitted { return; }
    let script = include_str!("../resources/cleanup-blank-session.cjs");
    let arguments = json!({"path":target.path,"id":target.id,"root":root}).to_string();
    let result = if let Some(host) = target.host {
        ssh(&host).arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments)))).output()
    } else { node_command().arg("-e").arg(script).arg(arguments).output() };
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
    cwd: String,
    host_id: String,
    window_label: String,
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
const WORKTREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct PiRuntime {
    worktree_setups: Mutex<HashMap<String, Arc<AtomicBool>>>,
    ephemeral_sessions: Mutex<HashMap<String, EphemeralSession>>,
    processes: Arc<Mutex<HashMap<String, PiProcess>>>,
    daemons: Mutex<HashMap<String, Arc<daemon::Daemon>>>,
    lifecycle: Mutex<()>,
    agent_config_revision: AtomicU64,
    agent_config_revisions: Mutex<HashMap<String, u64>>,
    active_agents: Arc<Mutex<HashMap<String, AgentAddress>>>,
}

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String>, worktree: Option<String>, presence_id: Option<String>, working: bool, messageable: bool }

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

struct BrokerWriter { child: Arc<Mutex<Child>>, _claim: BusyAgent }

impl Drop for BrokerWriter {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if !matches!(child.try_wait(), Ok(Some(_))) { let _ = child.kill(); let _ = child.wait(); }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectKind { NoRepo, Main, Worktree }

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
    last_message_at: u64,
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
struct OpencodeGoUsageWindow {
    status: String,
    remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpencodeGoUsage {
    rolling: OpencodeGoUsageWindow,
    weekly: OpencodeGoUsageWindow,
    monthly: OpencodeGoUsageWindow,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageCategory {
    id: String,
    byte_size: u64,
    item_count: usize,
    #[serde(default)]
    estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchivedConversation {
    id: String,
    path: String,
    name: String,
    cwd: String,
    modified_at: u64,
    byte_size: u64,
    deletable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    delete_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageInventory {
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStorage {
    host_id: String,
    host_name: String,
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageReport { hosts: Vec<HostStorage> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffToolPathMapping { tool_call_id: String, path: String, absolute_path: String, canonical_path: String }

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum GitDiffSnapshot {
    Legacy(String),
    Located {
        patch: String,
        #[serde(rename = "repositoryRoot")]
        repository_root: String,
        #[serde(default, rename = "toolPaths", skip_serializing_if = "Vec::is_empty")]
        tool_paths: Vec<DiffToolPathMapping>,
    },
}

type GitDiffSnapshots = HashMap<String, GitDiffSnapshot>;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    known_models: Option<Vec<String>>,
    default_thinking: String,
    #[serde(default)]
    default_fast_mode: bool,
    #[serde(default = "default_context_window_cap", deserialize_with = "deserialize_context_window_cap")]
    context_window_cap: u64,
    #[serde(default = "default_context_window_cap_enabled")]
    context_window_cap_enabled: bool,
    #[serde(default = "default_true")]
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
struct WorktreeSetupScript {
    id: String, name: String, script: String, enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup_script: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    host_id: Option<String>,
}

#[cfg(test)]
mod tests;

fn default_pi_path() -> String { "pi".into() }
 fn default_context_window_cap() -> u64 { 300_000 }
fn default_context_window_cap_enabled() -> bool { true }
fn default_true() -> bool { true }
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

fn pi_executable() -> PathBuf { pi_executable_in(home_dir().ok()) }

fn pi_executable_in(home: Option<PathBuf>) -> PathBuf {
    if let Some(home) = home {
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
    query_codex_usage(&mut Command::new(codex_executable()))
}

fn query_codex_usage(command: &mut Command) -> Result<CodexUsage, String> {
    let mut child = command.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
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

fn opencode_go_api_key() -> Option<String> {
    if let Ok(home) = home_dir() {
        let credentials = fs::read_to_string(home.join(".pi/agent/auth.json")).ok().and_then(|body| serde_json::from_str::<Value>(&body).ok());
        if let Some(key) = credentials.as_ref().and_then(|credentials| credentials.pointer("/opencode-go/key")).and_then(Value::as_str) { return Some(key.to_string()); }
    }
    std::env::var("OPENCODE_API_KEY").ok().filter(|key| !key.trim().is_empty())
}

fn opencode_go_digits(characters: &mut std::str::Chars<'_>, length: usize) -> Option<i64> {
    let mut number = 0;
    for _ in 0..length { number = number * 10 + characters.next()?.to_digit(10)? as i64; }
    Some(number)
}

fn opencode_go_expect_separator(characters: &mut std::str::Chars<'_>, separator: char) -> Option<()> {
    (characters.next()? == separator).then_some(())
}

fn opencode_go_skip_fraction(characters: &mut std::str::Chars<'_>) {
    if characters.clone().next() != Some('.') { return; }
    characters.next();
    while characters.clone().next().is_some_and(|character| character.is_ascii_digit()) { characters.next(); }
}

fn opencode_go_days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let civil = if month <= 2 { year - 1 } else { year };
    let era = civil.div_euclid(400);
    let year_of_era = civil - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2).div_euclid(5) + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era.div_euclid(4) - year_of_era.div_euclid(100) + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn opencode_go_epoch_seconds(value: &str) -> Option<u64> {
    let mut characters = value.chars();
    let year = opencode_go_digits(&mut characters, 4)?;
    opencode_go_expect_separator(&mut characters, '-')?;
    let month = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, '-')?;
    let day = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, 'T')?;
    let hour = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, ':')?;
    let minute = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, ':')?;
    let second = opencode_go_digits(&mut characters, 2)?;
    opencode_go_skip_fraction(&mut characters);
    if !matches!(characters.next()?, 'Z' | 'z') { return None; }
    let days = opencode_go_days_from_civil(year, month, day);
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok()
}

fn opencode_go_usage_window(window: &Value) -> Option<OpencodeGoUsageWindow> {
    let percent = window.get("percent")?.as_f64()?;
    let reset_at = window.get("resetsAt").and_then(Value::as_str).and_then(opencode_go_epoch_seconds);
    Some(OpencodeGoUsageWindow {
        status: window.get("status").and_then(Value::as_str).unwrap_or("ok").to_string(),
        remaining_percent: (100.0 - percent.clamp(0.0, 100.0)).round() as u8,
        reset_at,
    })
}

fn opencode_go_usage_values(response: &Value) -> Option<OpencodeGoUsage> {
    let usage = response.get("usage")?;
    Some(OpencodeGoUsage {
        rolling: opencode_go_usage_window(usage.get("rolling")?)?,
        weekly: opencode_go_usage_window(usage.get("weekly")?)?,
        monthly: opencode_go_usage_window(usage.get("monthly")?)?,
    })
}

#[tauri::command(async)]
async fn opencode_go_usage() -> Result<OpencodeGoUsage, String> {
    let api_key = opencode_go_api_key().ok_or("OpenCode Go API key is not configured")?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|error| format!("Could not create HTTP client: {error}"))?;
    let response = client.get("https://opencode.ai/zen/go/v1/usage").bearer_auth(api_key).send().await.map_err(|error| format!("OpenCode Go usage request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response.json::<Value>().await.ok().and_then(|body| body.pointer("/error/message").and_then(Value::as_str).map(String::from)).unwrap_or_else(|| status.to_string());
        return Err(format!("OpenCode Go usage is unavailable: {message}"));
    }
    let body = response.json::<Value>().await.map_err(|error| format!("OpenCode Go usage could not be read: {error}"))?;
    opencode_go_usage_values(&body).ok_or_else(|| "OpenCode Go usage is unavailable".into())
}

#[cfg(test)]
mod opencode_go_tests {
    use super::*;

    #[test]
    fn parses_usage_windows_from_the_opencode_go_gateway() {
        let response = json!({"usage":{"rolling":{"status":"ok","percent":26.7,"resetsAt":"2026-09-17T16:00:00.000Z"},"weekly":{"status":"ok","percent":55.4,"resetsAt":"2026-09-21T00:00:00Z"},"monthly":{"status":"rate-limited","percent":101,"resetsAt":"2026-09-30T00:00:00.000Z"}}});
        let usage = opencode_go_usage_values(&response).expect("usage parses");
        assert_eq!(usage.rolling.status, "ok");
        assert_eq!(usage.rolling.remaining_percent, 73);
        assert_eq!(usage.rolling.reset_at, Some(1789660800));
        assert_eq!(usage.weekly.remaining_percent, 45);
        assert_eq!(usage.weekly.reset_at, Some(1789948800));
        assert_eq!(usage.monthly.status, "rate-limited");
        assert_eq!(usage.monthly.remaining_percent, 0);
    }

    #[test]
    fn rejects_responses_without_usage_windows() {
        assert!(opencode_go_usage_values(&json!({"type":"error","error":{"type":"AuthError","message":"Unauthorized"}})).is_none());
        assert!(opencode_go_usage_values(&json!({"usage":{"rolling":{"status":"ok","percent":50}}})).is_none());
        assert!(opencode_go_usage_values(&json!({})).is_none());
    }

    #[test]
    fn converts_iso8601_reset_timestamps_to_epoch_seconds() {
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T00:00:00.000Z"), Some(1789603200));
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T11:39:50Z"), Some(1789645190));
        assert_eq!(opencode_go_epoch_seconds("2000-02-29T23:59:59Z"), Some(951868799));
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T11:39:50+02:00"), None);
        assert_eq!(opencode_go_epoch_seconds("2026-09-17 11:39:50Z"), None);
        assert_eq!(opencode_go_epoch_seconds("yesterday"), None);
    }

    #[test]
    fn settings_saved_before_new_toggles_still_load() {
        let stored = json!({"defaultModel":"openai-codex/gpt-5.6-sol","defaultThinking":"medium","contextWindowCap":200000,"contextWindowCapEnabled":true,"autoRetry":true,"tools":[],"skills":[],"mcpServers":[]});
        let settings: AppSettings = serde_json::from_value(stored).expect("older settings load");
        assert!(settings.auto_retry);
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    settings_path_at(&home_dir()?, DEVELOPMENT, || app.path().app_config_dir().map_err(|error| error.to_string()).map(|dir| dir.join("settings.json")))
}

fn settings_path_at(home: &Path, development: bool, legacy_path: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    let dir = home.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("settings.json");
    if !development && !path.exists() {
        let legacy = legacy_path()?;
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
    if path.is_dir() { return Err(format!("Configuration path is a directory: {}", path.display())); }
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
        if path.is_dir() { return Err(format!("Configuration path is a directory: {}", path.display())); }
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
        fs::rename(&temporary, path).or_else(|error| if path.is_dir() { Err(format!("Configuration path is a directory: {}", path.display())) } else { Err(error.to_string()) })?;
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
    // A single trailing "+" denotes the "+" key itself: "Ctrl++" -> ["ctrl", "+"].
    let mut raw: Vec<&str> = shortcut.split('+').collect();
    let mut plus_key = false;
    if (raw.len() > 1 && raw[raw.len() - 1].trim().is_empty()) { plus_key = true; raw.pop(); }
    let mut parts: Vec<String> = raw.iter().map(|part| part.trim().to_lowercase()).filter(|part| !part.is_empty()).collect();
    if (plus_key) { parts.push("+".to_string()); }
    if parts.is_empty() { return Ok(None); }
    let modifiers = ["ctrl", "meta", "alt", "shift", "mod"];
    let keys: Vec<&String> = parts.iter().filter(|part| !modifiers.contains(&part.as_str())).collect();
    if (keys.len() != 1) { return Err(format!("Shortcut '{shortcut}' needs exactly one key")); }
    let key = keys[0];
    if (["control", "meta", "alt", "shift", "mod"].contains(&key.as_str())) { return Err(format!("Shortcut '{shortcut}' needs a key")); }
    let protected = parts.iter().any(|part| matches!(part.as_str(), "ctrl" | "meta" | "alt" | "mod"));
    if (!protected) { return Err(format!("Shortcut '{shortcut}' needs Ctrl, Alt, or Meta")); }
    let mut canonical: Vec<&str> = modifiers.iter().copied().filter(|modifier| parts.iter().any(|part| part == modifier)).collect(); canonical.push(key); Ok(Some(canonical.join("+")))
}

fn migrate_keybindings(settings: &mut AppSettings) {
    // Retired actions can retain shortcuts now reserved by the app (e.g. conversation search).
    let supported = default_keybindings();
    settings.keybindings.retain(|action, _| supported.contains_key(action));
    for (action, shortcut) in supported {
        settings.keybindings.entry(action).or_insert(shortcut);
    }
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
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("piop-mcp-bridge.ts");
    let config_path = dir.join("mcp-servers.json");
    atomic_write_private(&extension_path, include_str!("../resources/mcp-bridge.bundle.mjs").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?)?;
    Ok((extension_path, config_path))
}

fn runtime_settings(settings: &AppSettings) -> Value {
    json!({ "tools": enabled_tool_names(settings), "skills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "mcpServers": settings.mcp_servers, "contextWindowCap": settings.context_window_cap, "contextWindowCapEnabled": settings.context_window_cap_enabled })
}

fn prepare_rtk_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("rtk.ts");
    atomic_write_private(&path, include_str!("../../extensions/piop-rtk/rtk.ts").as_bytes())?;
    atomic_write_private(&dir.join("rtk.LICENSE"), include_str!("../../extensions/piop-rtk/LICENSE").as_bytes())?;
    Ok(path)
}

fn prepare_runtime_settings(settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("runtime-settings.ts");
    atomic_write_private(&path, include_str!("../../extensions/piop-runtime-settings/index.ts").as_bytes())?;
    atomic_write_private(&dir.join("runtime-settings.json"), &serde_json::to_vec(&runtime_settings(settings)).map_err(|error| error.to_string())?)?;
    Ok(path)
}

fn prepare_session_broker() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("session-broker.ts");
    atomic_write_private(&path, include_str!("../resources/session-broker.ts").as_bytes())?;
    Ok(path)
}

fn prepare_hooks_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
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
        let mut command = node_command();
        command.args(["-e", script]);
        command
    } else {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, &host_id)?;
        let mut command = ssh(host);
        command.arg(format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {}", shell_quote(script)));
        command
    };
    query_hook_list(&mut command)
}

fn query_hook_list(command: &mut Command) -> Result<Value, String> {
    let output = run_limited(command, 4 * 1024 * 1024, "Could not list hooks")?;
    if !output.status.success() { return Err(format!("Could not list hooks: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Could not read hook list: {error}"))
}

fn prepare_trace_reader() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-trace-reader.ts");
    atomic_write_private(&path, include_str!("../resources/trace-reader.ts").as_bytes())?;
    Ok(path)
}

fn prepare_openai_cache_lineage_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-openai-cache-lineage.ts");
    atomic_write_private(&path, include_str!("../../extensions/piop-openai-cache-lineage/index.ts").as_bytes())?;
    Ok(path)
}

fn migrate_extension_directory(old: &str, new: &str) -> Result<(), String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    let source = root.join(old);
    let destination = root.join(new);
    if source.exists() && !destination.exists() {
        fs::rename(source, destination).map_err(|error| format!("Could not migrate piop extension directory: {error}"))?;
    }
    Ok(())
}

fn prepare_fast_mode_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-openai-fast-mode-piop", "piop-openai-fast-mode")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-openai-fast-mode");
    ensure_private_dir(&dir)?;
    let path = dir.join("index.ts");
    atomic_write_private(&path, include_str!("../resources/fast-mode.bundle.mjs").as_bytes())?;
    Ok(path)
}

fn prepare_codex_web_search_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-codex-web-search.ts");
    atomic_write_private(&path, include_str!("../../extensions/piop-codex-web-search/index.ts").as_bytes())?;
    Ok(path)
}

fn prepare_context_window_cap_extension(settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-context-window-cap", "piop-context-window-cap")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-context-window-cap");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    let config_path = dir.join("config.json");
    atomic_write_private(&extension_path, include_str!("../../extensions/piop-context-window-cap/index.ts").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?)?;
    Ok(extension_path)
}

fn prepare_session_cost_limit_extension(_settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-session-cost-limit", "piop-session-cost-limit")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-session-cost-limit");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    atomic_write_private(&extension_path, include_str!("../../extensions/piop-session-cost-limit/index.ts").as_bytes())?;
    Ok(extension_path)
}

const FILE_CHANGE_ASSETS: [(&str, &str); 3] = [
    ("file-changes.ts", include_str!("../../extensions/piop-diff-watch/file-changes.ts")),
    ("sitecustomize.py", include_str!("../../extensions/piop-diff-watch/sitecustomize.py")),
    ("node_fs.cjs", include_str!("../../extensions/piop-diff-watch/node_fs.cjs")),
];

fn prepare_diff_watch_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-diff-watch", "piop-diff-watch")?;
    let config_dir = home_dir()?.join(STORAGE_DIRECTORY);
    let legacy_dir = config_dir.join("pi-git-change-context");
    if legacy_dir.exists() { fs::remove_dir_all(&legacy_dir).map_err(|error| format!("Could not remove legacy diff watch extension: {error}"))?; }
    let dir = config_dir.join("piop-diff-watch");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    atomic_write_private(&extension_path, include_str!("../../extensions/piop-diff-watch/index.ts").as_bytes())?;
    for (name, content) in FILE_CHANGE_ASSETS { atomic_write_private(&dir.join(name), content.as_bytes())?; }
    Ok(extension_path)
}

fn prepare_defined_agents_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-define-agents", "piop-define-agents")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-define-agents");
    ensure_private_dir(&dir)?;
    let legacy_dir = home_dir()?.join(".pi/agent/extensions/pi-define-agents");
    let config = dir.join("config.json");
    if !DEVELOPMENT && !config.exists() && legacy_dir.join("config.json").exists() {
        atomic_write_private(&config, &fs::read(legacy_dir.join("config.json")).map_err(|error| error.to_string())?)?;
    }
    let path = dir.join("index.ts");
    atomic_write_private(&dir.join("extension-loader.ts"), include_str!("../../extensions/piop-define-agents/extension-loader.ts").as_bytes())?;
    atomic_write_private(&path, include_str!("../../extensions/piop-define-agents/index.ts").as_bytes())?;
    if !DEVELOPMENT && legacy_dir.join("index.ts").exists() { fs::remove_file(legacy_dir.join("index.ts")).map_err(|error| error.to_string())?; }
    Ok(path)
}

fn prepare_btw_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-btw.ts");
    atomic_write_private(&path, include_str!("../resources/btw.ts").as_bytes())?;
    let legacy = home_dir()?.join(".pi/agent/extensions/pi-desktop-btw.ts");
    if !DEVELOPMENT && legacy.exists() { fs::remove_file(legacy).map_err(|error| error.to_string())?; }
    Ok(path)
}

fn default_agent() -> String { "general".into() }

fn default_settings() -> AppSettings {
    AppSettings {
        worktree_setup_scripts: vec![],
        default_agent: default_agent(),
        default_fast_mode: false,
         default_model: DEFAULT_MODEL.into(), hidden_models: vec![], known_models: None, default_thinking: "medium".into(), context_window_cap: default_context_window_cap(), context_window_cap_enabled: default_context_window_cap_enabled(), auto_retry: true, debug_mode: false, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List agents by machine and session","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Send a message to another agent","enabled":true,"builtin":false}),
            json!({"name":"read_trace","description":"Extract clean user and final assistant messages from a Pi trace","enabled":true,"builtin":false}),
            codex_web_search_tool(),
        ]).collect(),
        skills: vec![], mcp_servers: vec![], hosts: vec![], dictionaries: vec![], active_dictionary_ids: vec![],
    }
}

fn session_operation_tools() -> Vec<Value> {
    [("fork_session", "Fork a conversation in any project"), ("create_worktree", "Create a Git worktree"), ("remove_worktree", "Remove an unused Git worktree")].into_iter().map(|(name, description)| json!({"name":name,"description":description,"enabled":true,"builtin":false})).collect()
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
    merge_discovered_skills_at(settings, &home);
}

fn merge_discovered_skills_at(settings: &mut AppSettings, home: &Path) {
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
    let mut settings = read_settings_at(&path)?;
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    merge_discovered_skills(&mut settings);
    validate_dictionaries(&settings)?;
    Ok(settings)
}

fn read_settings_at(path: &Path) -> Result<AppSettings, String> {
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
    Ok(settings)
}

#[tauri::command(async)]
fn save_app_settings(app: AppHandle, mut settings: AppSettings, agent_host_id: Option<String>) -> Result<Value, String> {
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    let runtime = app.state::<PiRuntime>();
    let change = save_settings_with(&runtime, settings, agent_host_id,
        || settings_path(&app),
        |settings| daemon::invalidate_changed(&app, &runtime, settings),
        |settings| daemon::update_settings(&app, &runtime, settings))?;
    let _ = app.emit("pi://settings-changed", &change);
    Ok(change)
}

fn validate_settings_for_save(settings: &AppSettings) -> Result<(), String> {
    if settings.context_window_cap < 1000 { return Err("Context window cap must be a whole number of at least 1000".into()); }
    validate_dictionaries(settings)?;
    validate_keybindings(settings)?;
    validate_mcp_servers(settings)?;
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
    Ok(())
}

fn save_settings_with(
    runtime: &PiRuntime, mut settings: AppSettings, agent_host_id: Option<String>,
    path: impl FnOnce() -> Result<PathBuf, String>,
    invalidate: impl FnOnce(&AppSettings) -> Result<(), String>,
    synchronize: impl FnOnce(&AppSettings) -> Result<(), String>,
) -> Result<Value, String> {
    migrate_keybindings(&mut settings);
    validate_settings_for_save(&settings)?;
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    atomic_write_private(&path()?, &serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?)?;
    invalidate(&settings)?;
    let mut change = json!({"settings":settings});
    if let Some(host_id) = agent_host_id {
        let revision = runtime.agent_config_revision.fetch_add(1, Ordering::SeqCst) + 1;
        runtime.agent_config_revisions.lock().map_err(|_| "Agent configuration lock was poisoned")?.insert(host_id.clone(), revision);
        change["agentConfigChange"] = json!({"hostId":host_id,"revision":revision});
    }
    synchronize(&settings)?;
    Ok(change)
}

#[tauri::command]
fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

fn desktop_sessions_dir(home: &Path) -> PathBuf { home.join(STORAGE_DIRECTORY).join("sessions") }

fn ensure_desktop_sessions_dir(home: &Path) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home);
    fs::create_dir_all(&root).map_err(|error| format!("Could not create piop session directory: {error}"))?;
    Ok(root)
}

#[derive(Serialize, Deserialize)]
struct GitSnapshotToken { root: String, tree: String, #[serde(default)] repository_root: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktree { branch: String, path: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktreeRemoval {
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    branch_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

struct LimitedOutput { status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8> }

#[derive(Clone, Copy)]
enum WorktreeScriptPhase { Setup, Cleanup }

fn run_worktree_scripts(settings: &AppSettings, cwd: &str, worktree_path: &str, host_id: &str, cancelled: &AtomicBool, phase: WorktreeScriptPhase) -> Result<(), String> {
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?) };
    let mut scripts = settings.worktree_setup_scripts.iter().filter(|setup| setup.enabled).collect::<Vec<_>>();
    if matches!(phase, WorktreeScriptPhase::Cleanup) { scripts.reverse(); }
    for setup in scripts {
        let code = match phase { WorktreeScriptPhase::Setup => setup.script.as_str(), WorktreeScriptPhase::Cleanup => setup.cleanup_script.as_deref().unwrap_or_default() };
        if code.trim().is_empty() { continue; }
        let Some(project_path) = setup.project_path.as_deref().filter(|path| !path.trim().is_empty()) else { continue; };
        if setup.host_id.as_deref().unwrap_or("local") != host_id { continue; }
        let phase_name = match phase { WorktreeScriptPhase::Setup => "Setup", WorktreeScriptPhase::Cleanup => "Cleanup" };
        if cancelled.load(Ordering::SeqCst) { return Err(match phase { WorktreeScriptPhase::Setup => "Environment setup cancelled", WorktreeScriptPhase::Cleanup => "Worktree cleanup cancelled" }.into()); }
        let context = format!("{phase_name} script '{}' failed", setup.name);
        if code.len() > 32 * 1024 { return Err(format!("{context}: script exceeds 32 KiB")); }
        let completion_marker = format!("piop-worktree-script-complete-{}", Uuid::new_v4());
        let script = format!(r#"exec 4>&1
exec 1>&2
set +e
source_common=$(git -C {source} rev-parse --path-format=absolute --git-common-dir) || exit 1
source_common=$(cd -- "$source_common" && pwd -P) || exit 1
project_common=$(git -C {project} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && project_common=$(cd -- "$project_common" && pwd -P) || project_common=
if [ "$source_common" != "$project_common" ]; then
    printf '\n%s 0\n' {marker} >&4
    exit 0
fi
root=$(git -C {source} rev-parse --show-toplevel) || exit 1
PIOP_SOURCE_TREE_PATH=$(cd -- "$root" && pwd -P) || exit 1
PIOP_WORKTREE_BRANCH=$(git -C {target} symbolic-ref --quiet --short HEAD 2>/dev/null) || PIOP_WORKTREE_BRANCH=
cd -- {target} || exit 1
PIOP_WORKTREE_PATH=$(pwd -P) || exit 1
export PIOP_SOURCE_TREE_PATH PIOP_WORKTREE_PATH PIOP_WORKTREE_BRANCH
exec 3<&0
setup_output=$(mktemp "${{TMPDIR:-/tmp}}/piop-worktree-script.XXXXXX") || exit 1
setup_owner=$BASHPID
trap '[ "$BASHPID" != "$setup_owner" ] || rm -f -- "$setup_output"' EXIT
exec 6>"$setup_output" || exit 1
# The drain inherits no SSH streams or cancellation descriptors. It can outlive
# the script while background jobs write, retaining at most 64 KiB.
exec 5> >( trap - EXIT; exec >/dev/null 2>&1 3<&- 4>&-; dd bs=1 count=65536 >&6; exec 6>&-; cat >/dev/null )
output_pid=$!
exec 6>&-
set -m
bash -e -c {code} </dev/null >&5 2>&1 3<&- 4>&- 5>&- &
setup_pid=$!
exec 5>&-
set +m
# Keep cancellation separate from script input. EOF also stops the script if SSH disconnects.
bash -c 'IFS= read -r cancel; kill -KILL -- "-$1" 2>/dev/null' bash "$setup_pid" <&3 4>&- &
watcher=$!
wait "$setup_pid"
status=$?
kill -KILL "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$output_pid" 2>/dev/null || break
    sleep 0.01
done
head -c 65536 "$setup_output" >&2
rm -f -- "$setup_output"
printf '\n%s %s\n' {marker} "$status" >&4
exit "$status""#, source = shell_quote(cwd), project = shell_quote(project_path), target = shell_quote(worktree_path), code = shell_quote(code), marker = shell_quote(&completion_marker));
        let mut command = if let Some(host) = host { let mut command = ssh(host); command.arg(remote_login_command(&script)); command } else { let mut command = Command::new("bash"); command.args(["-c", &script]); command };
        let cancellation_message = match phase { WorktreeScriptPhase::Setup => "Environment setup cancelled", WorktreeScriptPhase::Cleanup => "Worktree cleanup cancelled" };
        let timeout = matches!(phase, WorktreeScriptPhase::Cleanup).then_some(WORKTREE_CLEANUP_TIMEOUT);
        let (status, stderr) = run_setup_process(&mut command, cancelled, &context, completion_marker, cancellation_message, timeout)?;
        if status != 0 {
            let detail = String::from_utf8_lossy(&stderr);
            return Err(format!("{context} (exit status {status}):\n{}", detail.trim()));
        }
    }
    Ok(())
}

#[tauri::command]
async fn run_worktree_setup(app: AppHandle, setup_id: String, cwd: String, worktree_path: String, host_id: Option<String>) -> Result<(), String> {
    let worker_app = app.clone();
    execute_worktree_setup(&app.state::<PiRuntime>(), &setup_id, move |cancelled| {
        let settings = load_app_settings(worker_app)?;
        let host_id = host_id.as_deref().unwrap_or("local");
        run_worktree_scripts(&settings, &cwd, &worktree_path, host_id, &cancelled, WorktreeScriptPhase::Setup)
    }).await
}

async fn execute_worktree_setup(runtime: &PiRuntime, setup_id: &str, work: impl FnOnce(Arc<AtomicBool>) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    let cancelled = runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(setup_id).cloned().ok_or("Unknown setup")?;
    let result = tauri::async_runtime::spawn_blocking(move || work(cancelled)).await.map_err(|error| error.to_string());
    runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.remove(setup_id);
    result?
}

#[tauri::command]
fn prepare_worktree_setup(runtime: State<PiRuntime>) -> Result<String, String> {
    register_worktree_setup(&runtime)
}

fn register_worktree_setup(runtime: &PiRuntime) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.insert(id.clone(), Arc::new(AtomicBool::new(false)));
    Ok(id)
}

#[tauri::command]
fn cancel_worktree_setup(runtime: State<PiRuntime>, setup_id: String) -> Result<(), String> {
    signal_worktree_setup_cancellation(&runtime, &setup_id)
}

fn signal_worktree_setup_cancellation(runtime: &PiRuntime, setup_id: &str) -> Result<(), String> {
    if let Some(cancelled) = runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(setup_id) { cancelled.store(true, Ordering::SeqCst); }
    Ok(())
}

fn run_setup_process(command: &mut Command, cancelled: &AtomicBool, context: &str, completion_marker: String, cancellation_message: &str, timeout: Option<Duration>) -> Result<(i32, Vec<u8>), String> {
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
    let started_at = Instant::now();
    let mut stopping_at = None;
    let mut stop_reason = None;
    let status = loop {
        if stop_reason.is_none() {
            if cancelled.load(Ordering::SeqCst) {
                stop_reason = Some(cancellation_message.to_string());
            } else if timeout.is_some_and(|limit| started_at.elapsed() >= limit) {
                stop_reason = Some(format!("{context} timed out after 5 minutes"));
            }
        }
        if stop_reason.is_some() && stopping_at.is_none() {
            if let Some(mut input) = input.take() { let _ = input.write_all(b"cancel\n"); }
            stopping_at = Some(Instant::now());
        }
        if stopping_at.is_some_and(|started: Instant| started.elapsed() >= Duration::from_secs(2)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(stop_reason.unwrap_or_else(|| cancellation_message.to_string()));
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
    if let Some(reason) = stop_reason { return Err(reason); }
    if cancelled.load(Ordering::SeqCst) { return Err(cancellation_message.into()); }
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
    let objects = PathBuf::from(lines.next().unwrap_or_default());
    let objects = if objects.is_absolute() { objects } else { requested.join(objects) }.canonicalize().map_err(|error| format!("Could not resolve Git objects: {error}"))?;
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
    let parent = home_dir()?.join(STORAGE_DIRECTORY).join("git-snapshots"); fs::create_dir_all(&parent).map_err(|error| error.to_string())?; Ok(parent)
}


fn parse_local_snapshot(token: &str) -> Result<GitSnapshotToken, String> {
    parse_local_snapshot_with(token, local_snapshot_parent)
}

fn parse_local_snapshot_with(token: &str, parent: impl FnOnce() -> Result<PathBuf, String>) -> Result<GitSnapshotToken, String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(token).map_err(|_| "Invalid Git snapshot token".to_string())?;
    if snapshot.tree.len() < 40 || snapshot.tree.len() > 64 || !snapshot.tree.chars().all(|character| character.is_ascii_hexdigit()) { return Err("Invalid Git snapshot tree".into()); }
    let parent = parent()?.canonicalize().map_err(|error| error.to_string())?;
    let root = PathBuf::from(&snapshot.root).canonicalize().map_err(|_| "Git snapshot expired".to_string())?;
    if root.parent() != Some(parent.as_path()) || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-")) { return Err("Invalid Git snapshot location".into()); }
    Ok(GitSnapshotToken { root: root.to_string_lossy().into_owned(), ..snapshot })
}

fn local_git_tree(cwd: &str) -> Result<Option<String>, String> { local_git_tree_with(cwd, local_snapshot_parent) }

fn validate_snapshot_location(snapshot: GitSnapshotToken, parent: &Path) -> Result<GitSnapshotToken, String> {
    let root = PathBuf::from(&snapshot.root).canonicalize().map_err(|_| "Git snapshot expired".to_string())?;
    if root.parent() != Some(parent) || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-")) { return Err("Invalid Git snapshot location".into()); }
    Ok(GitSnapshotToken { root: root.to_string_lossy().into_owned(), ..snapshot })
}

fn local_git_tree_with(cwd: &str, parent: impl FnOnce() -> Result<PathBuf, String>) -> Result<Option<String>, String> {
    let Some((root, repository_objects)) = git_root_and_objects(cwd)? else { return Ok(None) };
    let cwd = root.to_str().ok_or("Git root is not valid UTF-8")?;
    if !local_git_input_is_bounded(cwd, &root)? { return Ok(None); }
    let snapshot_parent = parent()?;
    capture_local_git_tree(&root, &repository_objects, &snapshot_parent).map(Some)
}

fn capture_local_git_tree(root: &Path, repository_objects: &Path, snapshot_parent: &Path) -> Result<String, String> {
    let cwd = root.to_str().ok_or("Git root is not valid UTF-8")?;
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
        serde_json::to_string(&GitSnapshotToken { root: snapshot_root.to_string_lossy().into_owned(), tree, repository_root: cwd.to_owned() }).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&snapshot_root); }
    result
}

fn local_git_diff(cwd: &str, base_token: &str) -> Result<Option<GitDiffSnapshot>, String> {
    local_git_diff_with(cwd, base_token, parse_local_snapshot, local_git_tree)
}

fn local_git_diff_with(cwd: &str, base_token: &str,
    mut parse: impl FnMut(&str) -> Result<GitSnapshotToken, String>,
    capture: impl FnOnce(&str) -> Result<Option<String>, String>) -> Result<Option<GitDiffSnapshot>, String> {
    let base = parse(base_token)?;
    let Some(current_token) = capture(cwd)? else { let _ = fs::remove_dir_all(&base.root); return Ok(None) };
    let current = parse(&current_token)?;
    let result = local_git_diff_between(cwd, &base, &current);
    let _ = fs::remove_dir_all(&base.root); let _ = fs::remove_dir_all(&current.root); result
}

fn local_git_diff_between(cwd: &str, base: &GitSnapshotToken, current: &GitSnapshotToken) -> Result<Option<GitDiffSnapshot>, String> {
    let Some((_, repository_objects)) = git_root_and_objects(cwd)? else { return Ok(None) };
    let alternates = std::env::join_paths([Path::new(&base.root).join("objects"), repository_objects]).map_err(|error| error.to_string())?;
    let mut command = Command::new("git"); command.args(["-C", &current.repository_root, "diff", "--no-relative", "--no-color", "--no-ext-diff", "--find-renames", &base.tree, &current.tree, "--"])
        .env("GIT_OBJECT_DIRECTORY", Path::new(&current.root).join("objects")).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates);
    let output = run_limited(&mut command, MAX_GIT_PATCH_BYTES, "Git patch is too large")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot::Located { patch, repository_root: current.repository_root.clone(), tool_paths: Vec::new() }))
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
    let host = if host_id == "local" { None } else { Some(remote_host(&load_app_settings(app)?, &host_id)?.clone()) };
    git_branch_at(&cwd, host.as_ref())
}

fn git_branch_at(cwd: &str, host: Option<&RemoteHost>) -> Result<Option<String>, String> {
    let output = if let Some(host) = host {
        ssh(host).arg(format!("git -C {} rev-parse --abbrev-ref HEAD", shell_quote(cwd))).output().map_err(|error| format!("Could not read Git branch on {}: {error}", host.name))?
    } else {
        Command::new("git").args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|error| format!("Could not read project Git branch: {error}"))?
    };
    if !output.status.success() { return Ok(None); }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!branch.is_empty()).then_some(branch))
}

fn inspect_git_project_kind(settings: &AppSettings, cwd: &str, host_id: &str) -> Result<ProjectKind, String> {
    let script = format!(r#"[ -d {cwd} ] || {{ printf 'Project directory does not exist' >&2; exit 3; }}
git_dir=$(git -C {cwd} rev-parse --absolute-git-dir 2>/dev/null) || {{ printf 'no-repo'; exit 0; }}
common_dir=$(git -C {cwd} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1
git_dir=$(cd -- "$git_dir" && pwd -P) || exit 1
common_dir=$(cd -- "$common_dir" && pwd -P) || exit 1
if [ "$git_dir" = "$common_dir" ]; then printf 'main'; else printf 'worktree'; fi"#, cwd = shell_quote(cwd));
    let mut command = if host_id == "local" {
        let mut command = Command::new("sh"); command.args(["-c", &script]); command
    } else {
        let host = remote_host(settings, host_id)?;
        let mut command = ssh(host); command.arg(remote_login_command(&script)); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not inspect project Git repository")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not inspect project Git repository".into() } else { error });
    }
    match output.stdout.as_slice() {
        b"no-repo" => Ok(ProjectKind::NoRepo),
        b"main" => Ok(ProjectKind::Main),
        b"worktree" => Ok(ProjectKind::Worktree),
        _ => Err("Git returned an unknown project kind".into()),
    }
}

#[tauri::command(async)]
fn git_project_kind(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<ProjectKind, String> {
    let settings = load_app_settings(app)?;
    inspect_git_project_kind(&settings, &cwd, host_id.as_deref().unwrap_or("local"))
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
    let settings = load_app_settings(app)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    let host = if host_id == "local" { None } else { Some(remote_host(&settings, host_id)?) };
    create_project_worktree_at(&cwd, &name, host)
}

fn create_project_worktree_at(cwd: &str, name: &str, host: Option<&RemoteHost>) -> Result<GitWorktree, String> {
    let name = worktree_suffix(name)?;
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

    create_local_git_worktree(&cwd, name)
}

fn create_local_git_worktree(cwd: &str, name: &str) -> Result<GitWorktree, String> {
    let name = worktree_suffix(name)?;
    let root_output = run_limited(Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel"]), 64 * 1024, "Could not locate Git repository")?;
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

struct WorktreeRemovalTarget { path: String, source: String, branch: Option<String> }

fn canonical_worktree_roots(settings: &AppSettings, host_id: &str, paths: &[String]) -> Result<Vec<Option<String>>, String> {
    let script = r#"command -v git >/dev/null 2>&1 || exit 2
for path do
    if root=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null) && root=$(cd -- "$root" 2>/dev/null && pwd -P); then
        printf '%s\000' "$root"
    else
        printf '\000'
    fi
done"#;
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?) };
    let mut roots = Vec::with_capacity(paths.len());
    for batch in paths.chunks(128) {
        let mut command = if let Some(host) = host {
            let arguments = batch.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" ");
            let remote = format!("sh -c {} sh {arguments}", shell_quote(script));
            let mut command = ssh(host); command.arg(remote_login_command(&remote)); command
        } else {
            let mut command = Command::new("sh"); command.args(["-c", script, "sh"]).args(batch); command
        };
        let context = host.map(|host| format!("Could not resolve worktree paths on {}", host.name)).unwrap_or_else(|| "Could not resolve worktree paths".into());
        let output = run_limited(&mut command, MAX_GIT_PATH_LIST_BYTES, &context)?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() { context } else { format!("{context}: {error}") });
        }
        let fields = output.stdout.strip_suffix(&[0]).ok_or("Incomplete worktree path details")?.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != batch.len() { return Err("Could not resolve every worktree path".into()); }
        roots.extend(fields.into_iter().map(|field| (!field.is_empty()).then(|| String::from_utf8_lossy(field).into_owned())));
    }
    Ok(roots)
}

#[tauri::command]
async fn git_worktree_roots(app: AppHandle, paths: Vec<String>, host_id: Option<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_app_settings(app)?;
        canonical_worktree_roots(&settings, host_id.as_deref().unwrap_or("local"), &paths)
    }).await.map_err(|error| error.to_string())?
}

fn sessions_on_host(settings: &AppSettings, index: &SessionIndexRuntime, host_id: &str) -> Result<Vec<SessionSummary>, String> {
    if host_id == "local" {
        let root = ensure_desktop_sessions_dir(&home_dir()?)?;
        return list_local_sessions(index, &root);
    }
    let host = remote_host(settings, host_id)?;
    list_remote_sessions(index, host).map_err(|error| format!("Could not verify conversations on {}: {error}", host.name))
}

fn inspect_worktree_removal(settings: &AppSettings, cwd: &str, host_id: &str) -> Result<WorktreeRemovalTarget, String> {
    let script = format!(r#"target=$(git -C {cwd} rev-parse --show-toplevel 2>/dev/null) || {{ printf 'Project is not a Git repository' >&2; exit 1; }}
target=$(cd -- "$target" && pwd -P) || exit 1
git_dir=$(git -C "$target" rev-parse --absolute-git-dir) || exit 1
common_dir=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir) || exit 1
git_dir=$(cd -- "$git_dir" && pwd -P) || exit 1
common_dir=$(cd -- "$common_dir" && pwd -P) || exit 1
[ "$git_dir" != "$common_dir" ] || {{ printf 'The main checkout cannot be deleted as a worktree' >&2; exit 1; }}
worktree_list=$(mktemp "${{TMPDIR:-/tmp}}/piop-worktree-list.XXXXXX") || exit 1
trap 'rm -f -- "$worktree_list"' EXIT
git -C "$target" worktree list --porcelain -z >"$worktree_list" || exit 1
source=
record_path=
target_locked=0
target_lock_reason=
while IFS= read -r -d '' field; do
    case "$field" in
        "worktree "*)
            record_path=${{field#worktree }}
            [ -n "$source" ] || source=$record_path
            ;;
        locked)
            if [ "$record_path" = "$target" ]; then target_locked=1; fi
            ;;
        "locked "*)
            if [ "$record_path" = "$target" ]; then target_locked=1; target_lock_reason=${{field#locked }}; fi
            ;;
        "") record_path= ;;
    esac
done <"$worktree_list"
[ -n "$source" ] || {{ printf 'Could not locate the main checkout' >&2; exit 1; }}
[ "$target_locked" -eq 0 ] || {{
    if [ -n "$target_lock_reason" ]; then printf 'Worktree is locked: %s' "$target_lock_reason" >&2; else printf 'Worktree is locked; unlock it before deletion' >&2; fi
    exit 1
}}
source=$(cd -- "$source" && pwd -P) || exit 1
status=$(git -C "$target" status --porcelain=v1 --untracked-files=normal) || exit 1
[ -z "$status" ] || {{ printf 'Worktree has uncommitted or untracked changes; commit or remove them before deletion' >&2; exit 1; }}
branch=$(git -C "$target" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=
printf '%s\000%s\000%s\000' "$target" "$source" "$branch""#, cwd = shell_quote(cwd));
    let mut command = if host_id == "local" {
        let mut command = Command::new("bash"); command.args(["-c", &script]); command
    } else {
        let host = remote_host(settings, host_id)?;
        let mut command = ssh(host); command.arg(remote_login_command(&script)); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not inspect Git worktree")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not inspect Git worktree".into() } else { error });
    }
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() < 4 || fields[0].is_empty() || fields[1].is_empty() { return Err("Git returned incomplete worktree details".into()); }
    Ok(WorktreeRemovalTarget {
        path: String::from_utf8_lossy(fields[0]).into_owned(),
        source: String::from_utf8_lossy(fields[1]).into_owned(),
        branch: (!fields[2].is_empty()).then(|| String::from_utf8_lossy(fields[2]).into_owned()),
    })
}

fn remove_git_worktree_blocking(app: AppHandle, cwd: String, host_id: Option<String>, delete_branch: bool) -> Result<GitWorktreeRemoval, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let terminals = app.state::<TerminalRuntime>();
    let session_index = app.state::<SessionIndexRuntime>();
    let target = inspect_worktree_removal(&settings, &cwd, &host_id)?;
    let session_paths = sessions_on_host(&settings, &session_index, &host_id)?.into_iter().map(|session| session.cwd).collect::<Vec<_>>();
    validate_worktree_unused(&settings, &host_id, &target.path, &session_paths, &runtime, &terminals)?;
    run_worktree_scripts(&settings, &target.source, &target.path, &host_id, &AtomicBool::new(false), WorktreeScriptPhase::Cleanup)?;
    remove_worktree_target(&settings, &host_id, target, delete_branch)
}

fn validate_worktree_unused(settings: &AppSettings, host_id: &str, target: &str, session_paths: &[String], runtime: &PiRuntime, terminals: &TerminalRuntime) -> Result<(), String> {
    let conversations = canonical_worktree_roots(settings, host_id, session_paths)?.into_iter().filter(|root| root.as_deref() == Some(target)).count();
    if conversations > 0 {
        return Err(format!("Archive or relocate the {conversations} conversation{} using this worktree before deleting it", if conversations == 1 { "" } else { "s" }));
    }
    let agent_paths = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().filter(|agent| agent.host_id == host_id).filter_map(|agent| agent.worktree.clone()).collect::<Vec<_>>();
    if canonical_worktree_roots(settings, host_id, &agent_paths)?.into_iter().any(|root| root.as_deref() == Some(target)) {
        return Err("Close every conversation using this worktree before deleting it".into());
    }
    let terminal_paths = terminals.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.values().filter(|terminal| terminal.host_id == host_id).map(|terminal| terminal.cwd.clone()).collect::<Vec<_>>();
    if canonical_worktree_roots(settings, host_id, &terminal_paths)?.into_iter().any(|root| root.as_deref() == Some(target)) {
        return Err("Close every terminal using this worktree before deleting it".into());
    }
    Ok(())
}

fn remove_worktree_target(settings: &AppSettings, host_id: &str, target: WorktreeRemovalTarget, delete_branch: bool) -> Result<GitWorktreeRemoval, String> {
    let removed = if host_id == "local" {
        run_limited(Command::new("git").arg("-C").arg(&target.source).args(["worktree", "remove"]).arg(&target.path), 64 * 1024, "Could not remove Git worktree")?
    } else {
        let host = remote_host(&settings, &host_id)?;
        run_limited(ssh(host).arg(format!("git -C {} worktree remove -- {}", shell_quote(&target.source), shell_quote(&target.path))), 64 * 1024, &format!("Could not remove Git worktree on {}", host.name))?
    };
    if !removed.status.success() {
        let error = String::from_utf8_lossy(&removed.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not remove Git worktree".into() } else { error });
    }
    if !delete_branch { return Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: false, warning: None }); }
    let Some(branch) = target.branch.as_deref() else {
        return Ok(GitWorktreeRemoval { branch: None, branch_deleted: false, warning: Some("The detached worktree was removed; there was no branch to delete".into()) });
    };
    let deleted = if host_id == "local" {
        run_limited(Command::new("git").arg("-C").arg(&target.source).args(["branch", "-d", "--", branch]), 64 * 1024, "Could not delete Git branch")?
    } else {
        let host = remote_host(&settings, &host_id)?;
        run_limited(ssh(host).arg(format!("git -C {} branch -d -- {}", shell_quote(&target.source), shell_quote(branch))), 64 * 1024, &format!("Could not delete Git branch on {}", host.name))?
    };
    if deleted.status.success() { return Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: true, warning: None }); }
    let detail = String::from_utf8_lossy(&deleted.stderr).trim().to_string();
    let warning = if detail.is_empty() { format!("Worktree removed, but branch '{branch}' could not be deleted") } else { format!("Worktree removed, but branch '{branch}' was kept:\n{detail}") };
    Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: false, warning: Some(warning) })
}

#[tauri::command]
async fn remove_git_worktree(app: AppHandle, cwd: String, host_id: Option<String>, delete_branch: bool) -> Result<GitWorktreeRemoval, String> {
    tauri::async_runtime::spawn_blocking(move || remove_git_worktree_blocking(app, cwd, host_id, delete_branch)).await.map_err(|error| error.to_string())?
}

fn valid_remote_snapshot(snapshot: &GitSnapshotToken) -> bool {
    let path = Path::new(&snapshot.root);
    path.is_absolute()
        && path.components().all(|component| matches!(component, std::path::Component::RootDir | std::path::Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-"))
        && snapshot.tree.len() >= 40 && snapshot.tree.len() <= 64 && snapshot.tree.chars().all(|character| character.is_ascii_hexdigit())
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let script = format!("cd {} && PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {}", shell_quote(cwd), shell_quote(include_str!("../resources/capture-git-tree.cjs")));
    let mut command = ssh(host); command.arg(remote_login_command(&script));
    query_remote_git_tree(&mut command, &host.name)
}

fn query_remote_git_tree(command: &mut Command, host_name: &str) -> Result<Option<String>, String> {
    let output = run_limited(command, 64 * 1024, &format!("Could not capture Git snapshot on {host_name}"))?;
    match output.status.code() { Some(3 | 4 | 6) => return Ok(None), _ => {} }
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let snapshot: GitSnapshotToken = serde_json::from_slice(&output.stdout).map_err(|error| format!("Remote Git snapshot was invalid: {error}"))?;
    if !valid_remote_snapshot(&snapshot) || !Path::new(&snapshot.repository_root).is_absolute() { return Err("Remote Git snapshot was invalid".into()); }
    serde_json::to_string(&snapshot).map(Some).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn capture_git_tree(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    capture_git_tree_at_host(&cwd, saved_remote_host(app, host_id)?.as_ref())
}

fn capture_git_tree_at_host(cwd: &str, host: Option<&RemoteHost>) -> Result<Option<String>, String> {
    match host { Some(host) => remote_git_tree(host, cwd), None => local_git_tree(cwd) }
}

#[tauri::command(async)]
fn discard_git_tree(app: AppHandle, snapshot: String, host_id: Option<String>) -> Result<(), String> {
    discard_git_tree_at_host(&snapshot, saved_remote_host(app, host_id)?.as_ref())
}

fn discard_git_tree_at_host(snapshot: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let Some(host) = host else { let snapshot = parse_local_snapshot(snapshot)?; return fs::remove_dir_all(snapshot.root).map_err(|error| format!("Could not discard Git snapshot: {error}")); };
    discard_remote_git_tree(snapshot, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn discard_remote_git_tree(snapshot: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(&snapshot).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&snapshot) { return Err("Invalid remote Git snapshot location".into()); }
    let root = shell_quote(&snapshot.root);
    let script = format!("parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; snap=$(cd {root} && pwd -P) || exit 7; [ \"$(dirname -- \"$snap\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snap\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; rm -rf -- \"$snap\"");
    let output = command(script).output().map_err(|error| format!("Could not discard Git snapshot on {host_name}: {error}"))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[tauri::command(async)]
fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<GitDiffSnapshot>, String> {
    load_git_diff_at_host(&cwd, &base_tree, saved_remote_host(app, host_id)?.as_ref())
}

fn load_git_diff_at_host(cwd: &str, base_tree: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff(cwd, base_tree); };
    load_remote_git_diff_with(base_tree,
        || remote_git_tree(host, cwd),
        |base_tree, current_token| load_git_diff_between_at_host(cwd, base_tree, current_token, Some(host)),
        |token| discard_git_tree_at_host(token, Some(host)))
}

fn load_remote_git_diff_with(base_tree: &str,
    capture: impl FnOnce() -> Result<Option<String>, String>,
    diff: impl FnOnce(&str, &str) -> Result<Option<GitDiffSnapshot>, String>,
    mut discard: impl FnMut(&str) -> Result<(), String>,
) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) { return Err("Invalid remote Git snapshot location".into()); }
    let Some(current_token) = capture()? else { return Ok(None) };
    let result = diff(base_tree, &current_token);
    let _ = discard(base_tree);
    let _ = discard(&current_token);
    result
}

fn load_git_diff_between_at_host(cwd: &str, base_tree: &str, current_token: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff_between(cwd, &parse_local_snapshot(base_tree)?, &parse_local_snapshot(current_token)?); };
    load_remote_git_diff_between(base_tree, current_token, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn load_remote_git_diff_between(base_tree: &str, current_token: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    let current: GitSnapshotToken = serde_json::from_str(&current_token).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) || !valid_remote_snapshot(&current) { return Err("Invalid remote Git snapshot location".into()); }
    let script = format!("cd {} || exit 2; parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; base=$(cd {} && pwd -P) || exit 7; current=$(cd {} && pwd -P) || exit 7; for snapshot in \"$base\" \"$current\"; do [ \"$(dirname -- \"$snapshot\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snapshot\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; done; repo_objects=$(git rev-parse --git-path objects) || exit 3; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 3; GIT_OBJECT_DIRECTORY=\"$current/objects\" GIT_ALTERNATE_OBJECT_DIRECTORIES=\"$base/objects:$repo_objects\" git diff --no-relative --no-color --no-ext-diff --find-renames {} {} --", shell_quote(&current.repository_root), shell_quote(&base.root), shell_quote(&current.root), shell_quote(&base.tree), shell_quote(&current.tree));
    let output = run_limited(&mut command(script), MAX_GIT_PATCH_BYTES, &format!("Git patch on {host_name} is too large"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot::Located { patch, repository_root: current.repository_root, tool_paths: Vec::new() }))
}

fn remote_session_sidecar_script(session_path: &str, action: &str) -> String {
    format!("session=$(readlink -f -- {}) || exit 7; sessions=$(cd \"$HOME/{STORAGE_DIRECTORY}/sessions\" && pwd -P) || exit 7; case \"$session\" in \"$sessions\"/*.jsonl) ;; *) exit 7;; esac; sidecar=${{session%.jsonl}}.diffs.json; {action}", shell_quote(session_path))
}

#[tauri::command(async)]
fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<GitDiffSnapshots, String> {
    load_git_diffs_at_host(&session_path, saved_remote_host(app, host_id)?.as_ref())
}

fn load_local_git_diffs(home: &Path, session_path: &str) -> Result<GitDiffSnapshots, String> {
    let candidate = PathBuf::from(&session_path);
    if !candidate.exists() {
        let root = ensure_desktop_sessions_dir(home)?.canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
        let parent = candidate.parent().ok_or("Session path has no parent directory")?.canonicalize().map_err(|error| format!("Could not locate session directory: {error}"))?;
        if !candidate.is_absolute() || !parent.starts_with(&root) || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") { return Err("Only piop session files can be accessed".into()); }
        return Ok(HashMap::new());
    }
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    if !path.exists() { return Ok(HashMap::new()); }
    if fs::metadata(&path).map_err(|error| format!("Could not inspect saved diffs: {error}"))?.len() > MAX_GIT_DIFFS_BYTES as u64 { return Err("Saved diffs exceed the 16 MiB limit".into()); }
    let content = fs::read_to_string(&path).map_err(|error| format!("Could not read saved diffs: {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

fn load_git_diffs_at_host(session_path: &str, host: Option<&RemoteHost>) -> Result<GitDiffSnapshots, String> {
    let content = if host.is_none() {
        let snapshots = load_local_git_diffs(&home_dir()?, &session_path)?;
        serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?
    } else {
        let host = host.unwrap();
        let mut command = ssh(host); command.arg(remote_session_sidecar_script(session_path, "if [ -f \"$sidecar\" ]; then cat -- \"$sidecar\"; else printf '{}'; fi"));
        return query_remote_git_diffs(&mut command, &host.name);
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

fn query_remote_git_diffs(command: &mut Command, host_name: &str) -> Result<GitDiffSnapshots, String> {
    let content = {
        let output = run_limited(command, MAX_GIT_DIFFS_BYTES, &format!("Saved diffs on {host_name} exceed the limit"))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Saved remote diffs were not valid UTF-8".to_string())?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

#[tauri::command(async)]
fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>) -> Result<(), String> {
    save_git_diffs_at_host(&session_path, snapshots, saved_remote_host(app, host_id)?.as_ref())
}

fn save_git_diffs_at_host(session_path: &str, snapshots: GitDiffSnapshots, host: Option<&RemoteHost>) -> Result<(), String> {
    let body = serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?;
    if body.len() > MAX_GIT_DIFFS_BYTES { return Err("Diff history exceeds the 16 MiB limit".into()); }
    let Some(host) = host else { return save_local_git_diffs(&home_dir()?, session_path, &body); };
    let mut command = ssh(host); command.arg(remote_save_git_diffs_script(session_path));
    write_remote_git_diffs(&mut command, &body)
}

fn save_local_git_diffs(home: &Path, session_path: &str, body: &str) -> Result<(), String> {
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    atomic_write_private(&path, body.as_bytes()).map_err(|error| format!("Could not save diffs: {error}"))
}

fn remote_save_git_diffs_script(session_path: &str) -> String {
    remote_session_sidecar_script(session_path, "umask 077; temporary=$(mktemp \"$sidecar.XXXXXX\") || exit 1; trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\" && chmod 600 -- \"$temporary\" && mv -f -- \"$temporary\" \"$sidecar\"")
}

fn write_remote_git_diffs(command: &mut Command, body: &str) -> Result<(), String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let write = child.stdin.take().ok_or("SSH stdin unavailable")?.write_all(body.as_bytes());
    let output = child.wait_with_output().map_err(|e| e.to_string())?; write.map_err(|e| e.to_string())?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

fn saved_remote_host(app: AppHandle, host_id: Option<String>) -> Result<Option<RemoteHost>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { return Ok(None); }
    Ok(Some(remote_host(&load_app_settings(app)?, &host_id)?.clone()))
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
        return create_local_ephemeral_fork(&home_dir()?, &std::env::temp_dir(), source_path);
    }
    let host = remote_host(settings, host_id)?.clone();
    let destination = format!("/tmp/pi-desktop-btw-{}.jsonl", Uuid::new_v4());
    let path = create_remote_ephemeral_fork(source_path, &destination, &host.name, |script| { let mut command = ssh(&host); command.arg(remote_login_command(&script)); command })?;
    Ok((path.clone(), EphemeralSession::Remote { host, path }))
}

fn create_remote_ephemeral_fork(source_path: &str, destination: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let remote = format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {} {} {} && printf %s {}", shell_quote(include_str!("../resources/fork-session.cjs")), shell_quote(source_path), shell_quote(destination), shell_quote(&Uuid::new_v4().to_string()), shell_quote(destination));
    let output = command(remote).output().map_err(|error| format!("Could not create temporary side conversation on {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("Temporary side conversation path was unavailable".into()); }
    Ok(path)
}

fn create_local_ephemeral_fork(home: &Path, temporary_dir: &Path, source_path: &str) -> Result<(String, EphemeralSession), String> {
    let source = local_desktop_session_file_at(home, source_path)?;
    let path = temporary_dir.join(format!("pi-desktop-btw-{}.jsonl", Uuid::new_v4()));
    let output = node_command().args(["-e", include_str!("../resources/fork-session.cjs")]).arg(source).arg(&path).arg(Uuid::new_v4().to_string()).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    Ok((path.to_string_lossy().into_owned(), EphemeralSession::Local(path)))
}

fn prepare_ephemeral_path(runtime: &PiRuntime, runtime_id: &str, ephemeral: bool, saved: Option<EphemeralSession>, source: Option<&str>, fork: impl FnOnce(&str) -> Result<(String, EphemeralSession), String>) -> Result<Option<String>, String> {
    let resolved = if let Some(saved) = saved {
        let path = match &saved { EphemeralSession::Local(path) => path.to_string_lossy().into_owned(), EphemeralSession::Remote { path, .. } => path.clone() };
        Some((path, saved))
    } else if ephemeral {
        match source { Some(source_path) => Some(fork(source_path)?), None => None }
    } else { None };
    match resolved {
        Some((path, session)) => { runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.insert(runtime_id.to_string(), session); Ok(Some(path)) }
        None => Ok(None),
    }
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

fn session_identity(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    let header = if host_id == "local" {
        let mut line = String::new();
        BufReader::new(fs::File::open(path).map_err(|error| error.to_string())?).take(64 * 1024).read_line(&mut line).map_err(|error| error.to_string())?;
        line
    } else {
        let host = remote_host(settings, host_id)?;
        read_remote_session_header(path, |script| { let mut command = ssh(host); command.arg(script); command })?
    };
    serde_json::from_str::<Value>(&header).map_err(|error| error.to_string())?.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).ok_or("Missing session identity".into())
}

fn read_remote_session_header(path: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let output = run_limited(&mut command(format!("head -n 1 -- {}", shell_quote(path))), 64 * 1024, "Could not read session identity")?;
    if !output.status.success() { return Err("Could not read session identity".into()); }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
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
    let rtk_extension = shell_quote(include_str!("../../extensions/piop-rtk/rtk.ts"));
    let rtk_license = shell_quote(include_str!("../../extensions/piop-rtk/LICENSE"));
    let runtime_settings_extension = shell_quote(include_str!("../../extensions/piop-runtime-settings/index.ts"));
    let runtime_settings_config = shell_quote(&serde_json::to_string(&runtime_settings(settings)).map_err(|error| error.to_string())?);
    let hook_stats = shell_quote(include_str!("../../extensions/piop-hooks/hook-stats.ts"));
    let hooks = shell_quote(include_str!("../../extensions/piop-hooks/index.ts"));
    let broker = shell_quote(include_str!("../resources/session-broker.ts"));
    let trace_reader = shell_quote(include_str!("../resources/trace-reader.ts"));
    let btw = shell_quote(include_str!("../resources/btw.ts"));
    let agent_extension_loader = shell_quote(include_str!("../../extensions/piop-define-agents/extension-loader.ts"));
    let defined_agents = shell_quote(include_str!("../../extensions/piop-define-agents/index.ts"));
    let context_window_cap = shell_quote(include_str!("../../extensions/piop-context-window-cap/index.ts"));
    let session_cost_limit = shell_quote(include_str!("../../extensions/piop-session-cost-limit/index.ts"));
    let codex_web_search = shell_quote(include_str!("../../extensions/piop-codex-web-search/index.ts"));
    let openai_cache_lineage = shell_quote(include_str!("../../extensions/piop-openai-cache-lineage/index.ts"));
    let fast_mode = shell_quote(include_str!("../resources/fast-mode.bundle.mjs"));
    let diff_watch = shell_quote(include_str!("../../extensions/piop-diff-watch/index.ts"));
    let context_window_config = shell_quote(&serde_json::to_string_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?);
    let mcp_bridge = shell_quote(include_str!("../resources/mcp-bridge.bundle.mjs"));
    let mcp_config = shell_quote(&serde_json::to_string_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?);
     let migration = [("pi-define-agents", "piop-define-agents"), ("pi-openai-fast-mode-piop", "piop-openai-fast-mode"), ("pi-context-window-cap", "piop-context-window-cap"), ("pi-session-cost-limit", "piop-session-cost-limit"), ("pi-diff-watch", "piop-diff-watch")].iter().map(|(old, new)| format!(r#"if [ -d "$HOME/{STORAGE_DIRECTORY}/{old}" ] && [ ! -e "$HOME/{STORAGE_DIRECTORY}/{new}" ]; then mv "$HOME/{STORAGE_DIRECTORY}/{old}" "$HOME/{STORAGE_DIRECTORY}/{new}"; fi"#)).collect::<Vec<_>>().join(" && ");
    let remote = format!("umask 077 && {migration} && rm -rf -- \"$HOME/{STORAGE_DIRECTORY}/pi-git-change-context\" && mkdir -p -m 700 \"$HOME/{STORAGE_DIRECTORY}/sessions\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents\" && chmod 700 \"$HOME/{STORAGE_DIRECTORY}\" \"$HOME/{STORAGE_DIRECTORY}/sessions\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents\" && mkdir -p -m 700 \"$HOME/{STORAGE_DIRECTORY}/hooks\" && printf %s {hook_stats} > \"$HOME/{STORAGE_DIRECTORY}/hook-stats.ts\" && printf %s {hooks} > \"$HOME/{STORAGE_DIRECTORY}/hook-loader.ts\" && printf %s {broker} > \"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\" && printf %s {trace_reader} > \"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" && printf %s {mcp_bridge} > \"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\" && printf %s {mcp_config} > \"$HOME/{STORAGE_DIRECTORY}/mcp-servers.json\" && printf %s {context_window_cap} > \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" && printf %s {context_window_config} > \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/config.json\" && printf %s {diff_watch} > \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\" && printf %s {codex_web_search} > \"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" && printf %s {openai_cache_lineage} > \"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-lineage.ts\" && printf %s {btw} > \"$HOME/{STORAGE_DIRECTORY}/piop-btw.ts\" && printf %s {defined_agents} > \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\" && chmod 600 -- \"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-lineage.ts\" \"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\" \"$HOME/{STORAGE_DIRECTORY}/mcp-servers.json\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/config.json\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-btw.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\"");
    let remote = format!(r#"{remote} && printf %s {agent_extension_loader} > "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/extension-loader.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/extension-loader.ts""#);
    let remote = if DEVELOPMENT { remote } else { format!(r#"{remote} && if [ ! -f "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/config.json" ] && [ -f "$HOME/.pi/agent/extensions/pi-define-agents/config.json" ]; then cp "$HOME/.pi/agent/extensions/pi-define-agents/config.json" "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/config.json"; fi && rm -f -- "$HOME/.pi/agent/extensions/pi-define-agents/index.ts" "$HOME/.pi/agent/extensions/pi-desktop-btw.ts""#) };
     let remote = format!(r#"{remote} && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode" && printf %s {fast_mode} > "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts""#);
     let remote = format!(r#"{remote} && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit" && printf %s {session_cost_limit} > "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts""#);
    let remote = format!(r#"{remote} && printf %s {runtime_settings_extension} > "$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts" && printf %s {runtime_settings_config} > "$HOME/{STORAGE_DIRECTORY}/runtime-settings.json" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts" "$HOME/{STORAGE_DIRECTORY}/runtime-settings.json""#);
    let remote = format!(r#"{remote} && printf %s {rtk_extension} > "$HOME/{STORAGE_DIRECTORY}/rtk.ts" && printf %s {rtk_license} > "$HOME/{STORAGE_DIRECTORY}/rtk.LICENSE" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/rtk.ts" "$HOME/{STORAGE_DIRECTORY}/rtk.LICENSE""#);
    let mut remote = remote;
    for (name, content) in FILE_CHANGE_ASSETS {
        remote.push_str(&format!(" && printf %s {} > \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/{}\" && chmod 600 \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/{}\"", shell_quote(content), name, name));
    }
    // Bundled extensions can exceed the OS limit for a single command argument.
    stage_extension_script(ssh(host).arg("sh -s"), &host.name, remote)
}

fn stage_extension_script(command: &mut Command, host_name: &str, remote: String) -> Result<(), String> {
    // Bundled extensions can exceed the OS limit for a single command argument.
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("Could not install piop extensions on {host_name}: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Remote extension staging stdin was unavailable")?;
    let writer = thread::spawn(move || stdin.write_all(remote.as_bytes()));
    let output = child.wait_with_output().map_err(|error| format!("Could not install piop extensions on {host_name}: {error}"))?;
    let written = writer.join().map_err(|_| "Remote extension staging writer failed")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    written.map_err(|error| format!("Could not send piop extensions to {host_name}: {error}"))
}

enum PiLaunch<'a> {
    Rpc { cwd: Option<&'a str>, session_path: Option<&'a str>, session_id: Option<&'a str>, fork_path: Option<&'a str>, no_session: bool },
    Print { cwd: &'a str, session_path: &'a str },
}

fn build_pi_command(broker: &BrokerRuntime, settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>, daemon_port: Option<u16>) -> Result<Command, String> {
    let (broker_port, broker_token) = broker_environment(broker)?;
    let desktop_home = home_dir()?;
    let is_rpc = matches!(launch, PiLaunch::Rpc { .. });
    let default_model = settings.default_model.clone();
    if host_id == "local" {
         let (mcp_extension, mcp_config) = prepare_mcp_bridge(settings)?; let context_window_cap_extension = prepare_context_window_cap_extension(settings)?; let session_cost_limit_extension = prepare_session_cost_limit_extension(settings)?; let diff_watch_extension = prepare_diff_watch_extension()?; let trace_reader_extension = prepare_trace_reader()?; let openai_cache_lineage_extension = prepare_openai_cache_lineage_extension()?; let codex_web_search_extension = prepare_codex_web_search_extension()?; let defined_agents_extension = prepare_defined_agents_extension()?; let pi_path = pi_executable();
        let session_dir = ensure_desktop_sessions_dir(&desktop_home)?;
        let mut command = Command::new(&pi_path); command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY); command.arg(if is_rpc { "--mode" } else { "--print" }); if is_rpc { command.arg("rpc"); }
        command.arg("--extension").arg(prepare_rtk_extension()?);
         command.arg("--extension").arg(prepare_runtime_settings(settings)?).arg("--session-dir").arg(session_dir).arg("--approve").arg("--no-skills").arg("--extension").arg(prepare_hooks_extension()?).arg("--extension").arg(mcp_extension).arg("--extension").arg(prepare_session_broker()?).arg("--extension").arg(&trace_reader_extension).arg("--extension").arg(&context_window_cap_extension).arg("--extension").arg(&session_cost_limit_extension).arg("--extension").arg(&diff_watch_extension).arg("--extension").arg(prepare_fast_mode_extension()?).arg("--extension").arg(&openai_cache_lineage_extension).arg("--extension").arg(&codex_web_search_extension).arg("--extension").arg(&defined_agents_extension)
             .env("PI_DESKTOP_DEFINED_AGENTS_EXTENSION", &defined_agents_extension).env("PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION", &codex_web_search_extension).env("PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION", &context_window_cap_extension).env("PI_DESKTOP_SESSION_COST_LIMIT_EXTENSION", &session_cost_limit_extension).env("PI_DESKTOP_TRACE_READER_EXTENSION", &trace_reader_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config).env("PI_DESKTOP_BROKER_URL", format!("http://127.0.0.1:{broker_port}")).env("PI_DESKTOP_BROKER_TOKEN", &broker_token).env("PI_DESKTOP_HOST_ID", host_id);
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
    let host = remote_host(settings, host_id)?; stage_remote_extensions(host, settings)?; let remote_port = daemon_port.unwrap_or_else(remote_broker_port); let remote_pi = remote_pi_path(&host.pi_path);
    let mut arguments = vec![remote_pi.clone()]; if is_rpc { arguments.extend(["--mode".into(), "rpc".into()]); } else { arguments.push("--print".into()); }
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/rtk.ts\"")]);
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/hook-loader.ts\"")]);
       arguments.extend(["--session-dir".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/sessions\""), "--approve".into(), "--no-skills".into(), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-lineage.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\"")]);
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts\"")]);
    if is_rpc { arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-btw.ts\"")]); }
    let mut session_arguments = Vec::new();
    let cwd = match launch {
        PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => {
            if let Some(path) = fork_path { session_arguments.extend(["--fork".to_string(), path.into()]); }
            else if let Some(path) = session_path { session_arguments.extend(["--session".into(), path.into()]); }
            else if let Some(id) = session_id { session_arguments.extend(["--session-id".into(), id.into()]); }
            if no_session { session_arguments.push("--no-session".into()); } cwd
        },
        PiLaunch::Print { cwd, session_path, .. } => { arguments.extend(["--session".into(), shell_quote(session_path)]); Some(cwd) },
    };
    if !is_rpc && !default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(default_model.trim())]); }
    if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
    let rpc_environment = format!(" PI_DESKTOP_HOST_ID={}{}", shell_quote(host_id), if is_rpc { format!(" PI_DESKTOP_BTW=1 PI_DESKTOP_PI_EXECUTABLE={remote_pi}") } else { String::new() });
     let remote = format!("cd {} && PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} PI_DESKTOP_DEFINED_AGENTS_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\" PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" PI_DESKTOP_SESSION_COST_LIMIT_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts\" PI_DESKTOP_TRACE_READER_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" PI_DESKTOP_MCP_CONFIG=\"$HOME/{STORAGE_DIRECTORY}/mcp-servers.json\" PI_DESKTOP_BROKER_URL={} PI_DESKTOP_BROKER_TOKEN={}{} exec {}", remote_directory_path(cwd), shell_quote(&format!("http://127.0.0.1:{remote_port}")), shell_quote(&broker_token), rpc_environment, arguments.join(" "));
    if daemon_port.is_some() {
        let mut command = Command::new("sh");
        command.args(["-c", &format!("{remote} \"$@\""), "piop"]).args(session_arguments);
        return Ok(command);
    }
    let mut command = remote_broker_command(host, broker_port, remote_port); command.arg(remote_login_command(&remote)); Ok(command)
}

#[tauri::command(async)]
fn start_pi(app: AppHandle, window: tauri::WebviewWindow, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, no_session: Option<bool>, host_id: Option<String>, presence: Option<Value>) -> Result<Value, String> {
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let settings = load_app_settings(app.clone())?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(&runtime_id).is_some_and(|process| process.daemon.alive.load(Ordering::SeqCst) && process.daemon.matches_connection(&settings, &host_id)) { return Ok(json!({"attached":true})); }
    let session_id = session_id.or_else(|| (session_path.is_none() && fork_path.is_none()).then(|| Uuid::new_v4().to_string()));
    let saved_ephemeral = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.get(&runtime_id).cloned();
    let ephemeral = no_session.unwrap_or(false) || saved_ephemeral.is_some();
    let session_path = if ephemeral { None } else { session_path.as_deref().map(|path| desktop_session_file(&settings, &host_id, path)).transpose()? };
    let fork_path = fork_path.as_deref().map(|path| desktop_session_file(&settings, &host_id, path)).transpose()?;
    let ephemeral_path = prepare_ephemeral_path(&runtime, &runtime_id, ephemeral, saved_ephemeral, fork_path.as_deref(), |source_path| create_ephemeral_fork(&settings, &host_id, source_path))?;
    let claim_id = if ephemeral { None } else if let Some(id) = session_id.as_deref() { Some(id.to_string()) } else if let Some(path) = session_path.as_deref() {
        Some(session_identity(&settings, &host_id, path)?)
    } else { None };
    let _claim = claim_id.as_deref().map(|id| claim_agent(&broker, &host_id, id)).transpose()?;
    let daemon = daemon::connect(&app, &runtime, &broker, &settings, &host_id)?;
    let launch_session_path = ephemeral_path.as_deref().or(session_path.as_deref());
    let launch_fork_path = if ephemeral_path.is_some() { None } else { fork_path.as_deref() };
    let command = build_pi_command(&broker, &settings, &host_id, PiLaunch::Rpc { cwd: cwd.as_deref(), session_path: launch_session_path, session_id: session_id.as_deref(), fork_path: launch_fork_path, no_session: ephemeral && ephemeral_path.is_none() }, daemon.remote_port)?;
    let command_timeout = settings.mcp_servers.iter()
        .filter(|server| server.get("enabled").and_then(Value::as_bool) == Some(true))
        .map(|server| server.get("startupTimeoutSec").and_then(Value::as_u64).unwrap_or(10).clamp(1, 600))
        .max().unwrap_or(0) * 1000 + 30_000;
    let result = daemon.request(json!({"type":"attach","runtimeId":runtime_id,"sessionKey":claim_id.unwrap_or_else(|| runtime_id.clone()),"spec":daemon::spec(&command),"timeout":command_timeout,"ephemeral":ephemeral,"cwd":cwd,"presence":presence.unwrap_or_else(|| json!({}))}))?;
    let blank_cleanup = BlankSessionCleanup { path: session_path.clone(), id: session_id.clone(), host: if host_id == "local" { None } else { Some(remote_host(&settings, &host_id)?.clone()) }, submitted: ephemeral };
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { daemon, window_label: window.label().into(), blank_cleanup });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id, AgentAddress { host_id, session_id, session_path, worktree: None, presence_id: None, working: false, messageable: false });
    Ok(result)
}

fn detach_pi(runtime: &PiRuntime, runtime_id: &str, discard_blank: bool) -> Result<bool, String> {
    let mut stopped = false;
    let process = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(runtime_id);
    if let Some(mut process) = process {
        let result = process.daemon.request(json!({"type":"detach","runtimeId":runtime_id,"discardBlank":discard_blank}))?;
        if result["stopped"].as_bool() == Some(true) {
            stopped = true;
            process.blank_cleanup.submitted |= result["submitted"].as_bool().unwrap_or(false);
            if discard_blank { cleanup_blank_session(process.blank_cleanup); }
            if let Some(session) = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.remove(runtime_id) { remove_ephemeral_session(session); }
        }
    }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(runtime_id);
    Ok(stopped)
}

#[tauri::command(async)]
fn stop_pi(runtime: State<PiRuntime>, runtime_id: String, discard_blank: Option<bool>) -> Result<bool, String> {
    detach_pi(&runtime, &runtime_id, discard_blank.unwrap_or(false))
}

#[tauri::command(async)]
fn pi_presence(runtime: State<PiRuntime>, runtime_id: String, presence: Value) -> Result<(), String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(&runtime_id).map(|process| process.daemon.clone());
    if let Some(daemon) = daemon { daemon.request(json!({"type":"presence","runtimeId":runtime_id,"presence":presence}))?; }
    Ok(())
}

fn execute_pi_command(runtime: &PiRuntime, runtime_id: &str, command: Value) -> Result<Value, String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).map(|process| process.daemon.clone()).ok_or("Pi is not running")?;
    daemon.request(json!({"type":"command","runtimeId":runtime_id,"command":command}))
}

#[tauri::command(async)]
fn pi_command(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, mut command: Value) -> Result<Value, String> {
    let command_type = command["type"].as_str().unwrap_or_default().to_owned();
    let _lifecycle = if command_type == "switch_session" { Some(runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?) } else { None };
    let mut _claim = None;
    if command_type == "switch_session" {
        let path = command["sessionPath"].as_str().ok_or("Session path is required")?;
        let host_id = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get(&runtime_id).map(|agent| agent.host_id.clone()).ok_or("Unknown Pi runtime")?;
        let settings = load_app_settings(app)?;
        let path = desktop_session_file(&settings, &host_id, path)?;
        _claim = Some(claim_agent(&broker, &host_id, &session_identity(&settings, &host_id, &path)?)?);
        command["sessionPath"] = json!(path);
    }
    let result = execute_pi_command(&runtime, &runtime_id, command)?;
    if command_type == "voice_history" {
        if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(&runtime_id) { process.blank_cleanup.submitted = true; }
    }
    let state = if command_type == "get_snapshot" { Some(&result["state"]) } else if command_type == "get_state" { Some(&result) } else { None };
    if let Some(state) = state {
        if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(&runtime_id) {
            if let Some(path) = state["sessionFile"].as_str() { process.blank_cleanup.path = Some(path.into()); }
            if let Some(id) = state["sessionId"].as_str() { process.blank_cleanup.id = Some(id.into()); }
        }
        if let Some(agent) = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get_mut(&runtime_id) {
            agent.session_id = state["sessionId"].as_str().map(str::to_owned);
            agent.session_path = state["sessionFile"].as_str().map(str::to_owned);
            agent.working = state["isStreaming"].as_bool().unwrap_or(false);
        }
    }
    Ok(result)
}

#[tauri::command]
fn new_window(app: AppHandle, target: Value) -> Result<String, String> {
    let (label, path) = conversation_window_target(&target)?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.into()))
        .title(APP_TITLE).inner_size(1280.0, 800.0).min_inner_size(900.0, 640.0)
        .build().map_err(|error| error.to_string())?;
    Ok(label)
}

fn conversation_window_target(target: &Value) -> Result<(String, String), String> {
    if !target["sessionId"].as_str().is_some_and(|id| !id.trim().is_empty()) { return Err("Select a conversation to open in another window".into()); }
    let label = format!("chat-{}", Uuid::new_v4());
    let mut url = tauri::Url::parse("https://piop.invalid/").map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("target", &target.to_string());
    let path = format!("index.html{}", url.query().map(|query| format!("?{query}")).unwrap_or_default());
    Ok((label, path))
}

#[tauri::command]
fn start_terminal(app: AppHandle, window: tauri::WebviewWindow, runtime: State<TerminalRuntime>, terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let event_app = app.clone();
    start_terminal_with(&runtime, terminal_id, session_key, cwd.clone(), cols, rows, host_id.clone(), window.label().into(),
        || if host_id == "local" {
            let working_dir = PathBuf::from(&cwd);
            if !working_dir.is_dir() { return Err(format!("Terminal working directory does not exist: {}", working_dir.display())); }
            let mut command = CommandBuilder::new("/bin/bash"); command.cwd(working_dir); Ok(command)
        } else {
            let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
            let mut command = CommandBuilder::new("ssh");
            if let Some(config) = user_ssh_config() { command.arg("-F"); command.arg(config); }
            command.args(["-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", &host.target, &format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))]); Ok(command)
        },
        move |packet| { let _ = event_app.emit("pi://event", packet); })
}

fn start_terminal_with(runtime: &TerminalRuntime, terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: String, window_label: String,
    command: impl FnOnce() -> Result<CommandBuilder, String>, mut emit: impl FnMut(Value) + Send + 'static) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if processes.contains_key(&terminal_id) { return Ok(()); }
    if processes.values().filter(|process| process.session_key == session_key).count() >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals may run for one conversation")); }
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let mut command = command()?;
    command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(command).map_err(|error| format!("Could not start terminal shell: {error}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let event_id = terminal_id.clone(); let terminal_processes = runtime.processes.clone();
    thread::spawn(move || {
        stream_terminal_output(&mut reader, &event_id, &mut emit);
        if let Some(mut process) = terminal_processes.lock().ok().and_then(|mut values| values.remove(&event_id)) { let _ = process.child.wait(); }
        emit(json!({ "type": "terminal_exit", "terminalId": event_id }));
    });
    let (input, queued) = mpsc::sync_channel::<String>(32);
    thread::spawn(move || write_terminal_queue(&mut writer, queued));
    processes.insert(terminal_id, TerminalProcess { session_key, cwd, host_id, window_label, master: pair.master, child, writer: input });
    Ok(())
}

fn write_terminal_queue(writer: &mut impl Write, queued: mpsc::Receiver<String>) {
    while let Ok(data) = queued.recv() {
        if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() { break; }
    }
}

fn stream_terminal_output(reader: &mut impl Read, terminal_id: &str, mut emit: impl FnMut(Value)) {
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
    write_terminal_input(&runtime, &terminal_id, data)
}

fn write_terminal_input(runtime: &TerminalRuntime, terminal_id: &str, data: String) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get_mut(terminal_id).ok_or("Terminal is not running")?;
    if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB; paste a smaller block".into()); }
    process.writer.try_send(data).map_err(|_| "Terminal input is busy; wait or close the terminal".to_string())
}

#[tauri::command]
fn resize_terminal(runtime: State<TerminalRuntime>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize_terminal_pty(&runtime, &terminal_id, cols, rows)
}

fn resize_terminal_pty(runtime: &TerminalRuntime, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get(terminal_id).ok_or("Terminal is not running")?;
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
    open_external_url_with(&url, open_system_resource)
}

fn open_external_url_with(url: &str, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() { return Err("Only HTTP and HTTPS links can be opened in the browser".into()); }
    open(std::ffi::OsStr::new(parsed.as_str()))
}

#[tauri::command(async)]
fn open_project_directory(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, host_id.as_deref().unwrap_or_default())?;
        return open_project_directory_with(&cwd, Some(host), open_system_resource);
    }
    open_project_directory_with(&cwd, None, open_system_resource)
}

fn open_project_directory_with(cwd: &str, host: Option<&RemoteHost>, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    if let Some(host) = host { return Err(format!("Opening project directories on {} is not supported by the local file manager", host.name)); }
    let path = PathBuf::from(cwd);
    if !path.is_dir() { return Err(format!("Project directory does not exist: {}", path.display())); }
    open(path.as_os_str())
}


fn unix_timestamp(time: SystemTime) -> u64 { time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() }

// Inspect each distinct directory once per refresh, batching remote checks into one SSH call per batch.
fn inspect_session_projects(sessions: &mut [SessionSummary], host: Option<&RemoteHost>) -> Result<(), String> {
    inspect_session_projects_with(sessions, |script, batch| {
        if let Some(host) = host {
            let arguments = batch.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" ");
            let mut command = ssh(host);
            command.arg(format!("sh -c {} sh {arguments}", shell_quote(script)));
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", script, "sh"]).args(batch);
            command
        }
    })
}

fn inspect_session_projects_with(sessions: &mut [SessionSummary], mut command: impl FnMut(&str, &[String]) -> Command) -> Result<(), String> {
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
        let output = run_limited(&mut command(script, batch), MAX_GIT_PATH_LIST_BYTES, "Could not inspect session projects")?;
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
    read_session_summaries_with(candidates, host, |script, batch| {
        if let Some(host) = host {
            let mut command = ssh(host); command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), batch.iter().map(|item| shell_quote(&item.0)).collect::<Vec<_>>().join(" ")))); command
        } else { let mut command = node_command(); command.args(["-e", script]).args(batch.iter().map(|item| &item.0)); command }
    })
}

fn read_session_summaries_with(candidates: &[(String, String, u64, u64)], host: Option<&RemoteHost>,
    mut command: impl FnMut(&str, &[(String, String, u64, u64)]) -> Command,
) -> Result<HashMap<String, CachedSession>, String> {
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
        let output = run_limited(&mut command(script, batch), MAX_SESSION_INDEX_BATCH_BYTES, "Could not read session summaries")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        for line in output.stdout.split(|byte| *byte == b'\n') {
            let Ok(value) = serde_json::from_slice::<Value>(line) else { continue };
            let Some(path) = value.get("path").and_then(Value::as_str) else { continue };
            let Some((_, fingerprint, modified_at, _)) = batch.iter().find(|item| item.0 == path) else { continue };
            let string = |key| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let cwd = string("cwd"); let project = Path::new(&cwd).file_name().and_then(|name| name.to_str()).unwrap_or("Workspace").to_owned();
            let summary = SessionSummary { group_id: None, id: string("id"), path: path.to_owned(), name: string("name"), project, cwd, cwd_exists: true, project_kind: None, project_root: None, modified_at: *modified_at, preview: string("preview"), message_count: value.get("messageCount").and_then(Value::as_u64).unwrap_or(0) as usize, last_message_at: value.get("lastMessageAt").and_then(Value::as_u64).unwrap_or(0), api_cost: value.get("apiCost").and_then(Value::as_f64).unwrap_or(0.0), host_id: host.map(|host| host.id.clone()).unwrap_or_else(|| "local".into()), host_name: host.map(|host| host.name.clone()).unwrap_or_else(|| "Local".into()) };
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
    let metadata = query_remote_session_metadata(|script| { let mut command = ssh(host); command.arg(script); command })?;
    update_remote_session_index(index, host, &metadata,
        |changed| read_session_summaries(changed, Some(host)),
        |sessions| inspect_session_projects(sessions, Some(host)))
}

fn query_remote_session_metadata(command: impl FnOnce(&str) -> Command) -> Result<Vec<u8>, String> {
    let mut command = command(&format!(r#"mkdir -p "$HOME/{STORAGE_DIRECTORY}/sessions" && find "$HOME/{STORAGE_DIRECTORY}/sessions" -type f -name '*.jsonl' -printf '%p\000%T@\000%s\000' 2>/dev/null"#));
    let output = run_limited(&mut command, MAX_SESSION_INDEX_BATCH_BYTES, "Could not list remote sessions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    Ok(output.stdout)
}

fn update_remote_session_index(
    index: &SessionIndexRuntime, host: &RemoteHost, metadata: &[u8],
    read: impl FnOnce(&[(String, String, u64, u64)]) -> Result<HashMap<String, CachedSession>, String>,
    inspect: impl FnOnce(&mut [SessionSummary]) -> Result<(), String>,
) -> Result<Vec<SessionSummary>, String> {
    let metadata = parse_remote_session_metadata(metadata);
    let previous = index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.get(&host.id).cloned().unwrap_or_default();
    let changed = metadata.iter().filter(|(path, fingerprint, _, _)| previous.get(path).is_none_or(|cached| cached.fingerprint != *fingerprint)).cloned().collect::<Vec<_>>();
    let mut parsed = read(&changed)?;

    let mut next = HashMap::new(); let mut sessions = Vec::new();
    for (path, _, _, _) in metadata {
        let Some(mut cached) = parsed.remove(&path).or_else(|| previous.get(&path).cloned()) else { continue };
        cached.summary.host_name = host.name.clone(); sessions.push(cached.summary.clone()); next.insert(path, cached);
    }
    inspect(&mut sessions)?;
    index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.insert(host.id.clone(), next); Ok(sessions)
}

fn parse_remote_session_metadata(output: &[u8]) -> Vec<(String, String, u64, u64)> {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    fields.chunks_exact(3).filter_map(|frame| {
        let path = String::from_utf8_lossy(frame[0]).into_owned(); let modified = String::from_utf8_lossy(frame[1]); let size = String::from_utf8_lossy(frame[2]).parse().ok()?;
        Some((path, format!("{modified}:{size}"), modified.split('.').next()?.parse().ok()?, size))
    }).collect()
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
    let cwd = home.join(STORAGE_DIRECTORY).join("tmp").join(session_id);
    fs::create_dir_all(&cwd).map_err(|error| format!("Could not create temporary chat directory: {error}"))?;
    fs::write(cwd.join(".pi-desktop-temporary-chat"), b"").map_err(|error| format!("Could not mark temporary chat directory: {error}"))?;
    Ok(cwd)
}

fn temporary_chat_id(path: &str) -> Option<&str> {
    let value = Path::new(path); let id = value.file_name()?.to_str()?;
    Uuid::parse_str(id).ok()?;
    (value.parent()?.file_name()?.to_str()? == "tmp" && value.parent()?.parent()?.file_name()?.to_str()? == STORAGE_DIRECTORY).then_some(id)
}

#[tauri::command(async)]
fn remove_temporary_chat(app: AppHandle, path: String, host_id: String) -> Result<(), String> {
    if host_id == "local" {
        return remove_local_temporary_chat(&home_dir()?, &path);
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    remove_remote_temporary_chat(&path, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn remove_remote_temporary_chat(path: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    temporary_chat_id(path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    let script = format!("candidate={}; root=\"$HOME/{STORAGE_DIRECTORY}/tmp\"; [ \"$(dirname -- \"$candidate\")\" = \"$root\" ] && [ -f \"$candidate/.pi-desktop-temporary-chat\" ] && rm -rf -- \"$candidate\"", shell_quote(path));
    let output = command(script).output().map_err(|error| format!("Could not remove temporary chat directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(format!("Could not remove temporary chat directory on {host_name}: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}

fn remove_local_temporary_chat(home: &Path, path: &str) -> Result<(), String> {
    temporary_chat_id(path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    let expected_root = home.join(STORAGE_DIRECTORY).join("tmp");
    let candidate = PathBuf::from(path);
    if candidate.parent() != Some(expected_root.as_path()) { return Err("Refusing to remove a directory outside the temporary chat root".into()); }
    if !candidate.join(".pi-desktop-temporary-chat").is_file() { return Err("Refusing to remove an unmarked directory".into()); }
    if candidate.exists() { fs::remove_dir_all(candidate).map_err(|error| format!("Could not remove temporary chat directory: {error}"))?; }
    Ok(())
}

#[tauri::command(async)]
fn validate_project_directory(app: AppHandle, path: String, host_id: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    if host_id == "local" {
        return validate_local_project_directory(path);
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    validate_remote_project_directory(path, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn validate_local_project_directory(path: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not open project directory: {error}"))?;
    if !metadata.is_dir() { return Err("Project path is not a directory".into()); }
    Ok(path)
}

fn validate_remote_project_directory(path: String, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    let script = format!("test -d {0} && cd {0} && pwd -P", shell_quote(&path));
    let output = command(script).output().map_err(|error| format!("Could not validate project directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(format!("Could not open project directory on {host_name}: {}", String::from_utf8_lossy(&output.stderr).trim())); }
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
        create_remote_temporary_chat(&session_id, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })?
    };
    Ok(TemporaryChat { cwd, session_id })
}

fn create_remote_temporary_chat(session_id: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let remote = format!("mkdir -p \"$HOME/{STORAGE_DIRECTORY}/tmp/{session_id}\" && : > \"$HOME/{STORAGE_DIRECTORY}/tmp/{session_id}/.pi-desktop-temporary-chat\" && cd \"$HOME/{STORAGE_DIRECTORY}/tmp/{session_id}\" && pwd -P");
    let output = command(remote).output().map_err(|error| format!("Could not create temporary chat directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("Remote temporary chat directory was unavailable".into()); }
    Ok(path)
}

#[tauri::command(async)]
fn list_directories(app: AppHandle, host_id: String, path: Option<String>) -> Result<DirectoryListing, String> {
    if host_id == "local" {
        return list_local_directories(&home_dir()?, path.as_deref());
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let mut command = ssh(host); command.arg(remote_directory_listing_script(path.as_deref()));
    query_remote_directories(&mut command, &host.name)
}

fn list_local_directories(home: &Path, path: Option<&str>) -> Result<DirectoryListing, String> {
    let requested = path.filter(|value| !value.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| home.to_path_buf());
    let current = requested.canonicalize().map_err(|error| format!("Could not browse {}: {error}", requested.display()))?;
    if !current.is_dir() { return Err(format!("{} is not a directory", current.display())); }
    let entries = fs::read_dir(&current).map_err(|error| format!("Could not browse {}: {error}", current.display()))?;
    let mut directories: Vec<String> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|entry| entry.is_dir()).map(|entry| entry.to_string_lossy().into_owned()).collect();
    directories.sort_by_key(|directory| directory.to_lowercase());
    Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories })
}

fn remote_directory_listing_script(path: Option<&str>) -> String {
    format!("cd {} && printf '%s\\000' \"$PWD\" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f\\000'", remote_directory_path(path))
}

fn query_remote_directories(command: &mut Command, host_name: &str) -> Result<DirectoryListing, String> {
    let output = command.output().map_err(|error| format!("Could not browse {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    parse_remote_directories(&output.stdout)
}

fn parse_remote_directories(output: &[u8]) -> Result<DirectoryListing, String> {
    let mut parts = output.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let current = PathBuf::from(String::from_utf8_lossy(parts.next().ok_or("Remote directory was unavailable")?).into_owned());
    let mut directories: Vec<String> = parts.map(|name| current.join(String::from_utf8_lossy(name).as_ref()).to_string_lossy().into_owned()).collect();
    directories.sort_by_key(|directory| directory.to_lowercase());
    Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories })
}

fn collect_sessions(app: &AppHandle, index: &SessionIndexRuntime) -> Result<Vec<SessionSummary>, String> {
    let home = home_dir()?; let root = ensure_desktop_sessions_dir(&home)?;
    let sessions = list_local_sessions(index, &root)?;
    let hosts = load_app_settings(app.clone())?.hosts;
    collect_host_sessions(sessions, hosts, |host| list_remote_sessions(index, host), session_groups::attach_assignments)
}

fn collect_host_sessions(
    mut sessions: Vec<SessionSummary>, hosts: Vec<RemoteHost>,
    list: impl Fn(&RemoteHost) -> Result<Vec<SessionSummary>, String> + Sync,
    assign: impl FnOnce(&mut [SessionSummary]) -> Result<(), String>,
) -> Result<Vec<SessionSummary>, String> {
    thread::scope(|scope| {
        let list = &list;
        let queue = Arc::new(Mutex::new(hosts));
        let (sender, receiver) = mpsc::channel();
        for _ in 0..MAX_REMOTE_HOSTS.min(4).min(queue.lock().map(|items| items.len()).unwrap_or(0)) {
            let queue = queue.clone(); let sender = sender.clone();
            scope.spawn(move || loop {
                let host = queue.lock().ok().and_then(|mut items| items.pop());
                let Some(host) = host else { break };
                let _ = sender.send(list(&host));
            });
        }
        drop(sender);
        for result in receiver { if let Ok(mut remote) = result { sessions.append(&mut remote); } }
    });
    assign(&mut sessions)?;
    sessions.sort_by(|left, right| right.modified_at.cmp(&left.modified_at)); Ok(sessions)
}

#[tauri::command(async)]
fn list_sessions(app: AppHandle, index: State<SessionIndexRuntime>) -> Result<Vec<SessionSummary>, String> { collect_sessions(&app, &index) }

fn inspect_storage(host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    let script = include_str!("../resources/storage-inventory.cjs");
    let mut command = if let Some(host) = host {
        let mut command = ssh(host);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {}", shell_quote(script))));
        command
    } else {
        let mut command = node_command();
        command.args(["-e", script]);
        command
    };
    query_storage_inventory(&mut command, host)
}

fn query_storage_inventory(command: &mut Command, host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    let label = host.map(|value| value.name.as_str()).unwrap_or("Local");
    let output = run_limited(command, MAX_SESSION_INDEX_BATCH_BYTES, &format!("Could not inspect storage on {label}"))?;
    parse_storage_inventory(output, host)
}

fn parse_storage_inventory(output: LimitedOutput, host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    let label = host.map(|value| value.name.as_str()).unwrap_or("Local");
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("Could not inspect storage on {label}") } else { error });
    }
    let inventory: StorageInventory = serde_json::from_slice(&output.stdout).map_err(|error| format!("Could not read storage inventory from {label}: {error}"))?;
    Ok(HostStorage {
        host_id: host.map(|value| value.id.clone()).unwrap_or_else(|| "local".into()),
        host_name: label.into(),
        categories: inventory.categories,
        archives: inventory.archives,
        warnings: inventory.warnings,
        error: None,
    })
}

fn failed_storage(host_id: String, host_name: String, error: String) -> HostStorage {
    HostStorage { host_id, host_name, categories: Vec::new(), archives: Vec::new(), warnings: Vec::new(), error: Some(error) }
}

#[tauri::command(async)]
fn storage_report(app: AppHandle) -> Result<StorageReport, String> {
    let local = inspect_storage(None);
    let remote_hosts = load_app_settings(app)?.hosts;
    Ok(collect_storage_report(local, remote_hosts, |host| inspect_storage(Some(host))))
}

fn collect_storage_report(local: Result<HostStorage, String>, remote_hosts: Vec<RemoteHost>, inspect: impl Fn(&RemoteHost) -> Result<HostStorage, String> + Sync) -> StorageReport {
    let mut hosts = vec![local.unwrap_or_else(|error| failed_storage("local".into(), "Local".into(), error))];
    thread::scope(|scope| {
        let inspect = &inspect;
        let queue = Arc::new(Mutex::new(remote_hosts));
        let (sender, receiver) = mpsc::channel();
        for _ in 0..MAX_REMOTE_HOSTS.min(4).min(queue.lock().map(|items| items.len()).unwrap_or(0)) {
            let queue = queue.clone(); let sender = sender.clone();
            scope.spawn(move || loop {
                let host = queue.lock().ok().and_then(|mut items| items.pop());
                let Some(host) = host else { break };
                let result = inspect(&host).unwrap_or_else(|error| failed_storage(host.id.clone(), host.name.clone(), error));
                let _ = sender.send(result);
            });
        }
        drop(sender);
        hosts.extend(receiver);
    });
    hosts[1..].sort_by(|left, right| left.host_name.to_lowercase().cmp(&right.host_name.to_lowercase()));
    StorageReport { hosts }
}

fn local_desktop_session_file(session_path: &str) -> Result<PathBuf, String> {
    local_desktop_session_file_at(&home_dir()?, session_path)
}

fn local_desktop_session_file_at(home: &Path, session_path: &str) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home).canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only piop session files can be accessed".into()); }
    Ok(source)
}

fn local_archived_session_file(session_path: &str) -> Result<PathBuf, String> {
    local_archived_session_file_at(&home_dir()?, session_path)
}

fn local_archived_session_file_at(home: &Path, session_path: &str) -> Result<PathBuf, String> {
    let root = home.join(STORAGE_DIRECTORY).join("archived").canonicalize().map_err(|error| format!("Could not locate piop archives: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate archived conversation: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only archived piop conversations can be accessed".into()); }
    Ok(source)
}

fn desktop_session_file(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    if host_id == "local" { return Ok(local_desktop_session_file(path)?.to_string_lossy().into_owned()); }
    let host = remote_host(settings, host_id)?;
    remote_session_file(path, false, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn archived_session_file(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    if host_id == "local" { return Ok(local_archived_session_file(path)?.to_string_lossy().into_owned()); }
    let host = remote_host(settings, host_id)?;
    remote_session_file(path, true, |script| { let mut command = ssh(host); command.arg(script); command })
}

fn remote_session_file(path: &str, archived: bool, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let (area, context, rejected) = if archived {
        ("archived", "Could not locate archived Piop conversation", "Only archived conversation files in this Piop profile can be deleted")
    } else {
        ("sessions", "Could not locate Piop session", "Only session files in this Piop profile can be opened")
    };
    let script = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/{area}" && pwd -P) && session=$(realpath -- {}) && [ -f "$session" ] && case "$session" in "$root"/*.jsonl) printf '%s' "$session" ;; *) exit 1 ;; esac"#, shell_quote(path));
    let output = run_limited(&mut command(script), MAX_GIT_PATH_LIST_BYTES, context)?;
    if !output.status.success() { return Err(rejected.into()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command(async)]
fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, terminal_ids: Vec<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let client = app.state::<PiRuntime>();
    let _lifecycle = client.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let daemon = client.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?.get(&host_id).cloned();
    if let Some(daemon) = daemon {
        let settings = load_app_settings(app.clone())?;
        let path = desktop_session_file(&settings, &host_id, &session_path)?;
        let key = session_identity(&settings, &host_id, &path)?;
        if daemon.alive.load(Ordering::SeqCst) { daemon.request(json!({"type":"retire","sessionKey":key,"sessionPath":path}))?; }
        // Retirement stops new captures; its response follows all previously queued capture packets.
        daemon.drain_captures(Some(&key))?;
    }

    if host_id != "local" {
        let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, &host_id)?;
        archive_remote_session(&session_path, |script| { let mut command = ssh(host); command.arg(script); command })?;
        let _ = stop_terminals(&runtime, &terminal_ids);
        return Ok(());
    }
    archive_local_session(&home_dir()?, &session_path)?;
    let _ = stop_terminals(&runtime, &terminal_ids);
    Ok(())
}

fn archive_remote_session(session_path: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let file_name = Path::new(session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
    let destination = format!("{}-{file_name}", Uuid::new_v4());
    let diff_destination = Path::new(&destination).with_extension("diffs.json").to_string_lossy().into_owned();
    let remote = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) archive="$HOME/{STORAGE_DIRECTORY}/archived"; mkdir -p "$archive" || exit 1; diff=${{target%.jsonl}}.diffs.json; diff_target="$archive"/{}; moved_diff=0; if [ -f "$diff" ]; then mv -- "$diff" "$diff_target" || exit 1; moved_diff=1; fi; if ! mv -- "$target" "$archive"/{}; then if [ "$moved_diff" = 1 ]; then mv -- "$diff_target" "$diff" || true; fi; exit 1; fi ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(session_path), shell_quote(&diff_destination), shell_quote(&destination));
    let output = command(remote).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(())
}

fn archive_local_session(home: &Path, session_path: &str) -> Result<(), String> {
    let source = local_desktop_session_file_at(home, session_path)?;
    let archive_dir = home.join(STORAGE_DIRECTORY).join("archived");
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
    Ok(())
}

fn delete_stored_session(app: AppHandle, runtime: &PiRuntime, session_path: String, host_id: Option<String>, archived: bool) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let settings = load_app_settings(app)?;
    let path = if archived { archived_session_file(&settings, &host_id, &session_path)? } else { desktop_session_file(&settings, &host_id, &session_path)? };
    let local_root = if archived { home_dir()?.join(STORAGE_DIRECTORY).join("archived") } else { desktop_sessions_dir(&home_dir()?) };
    let host = if host_id == "local" { None } else { Some(remote_host(&settings, &host_id)?.clone()) };
    delete_session_files(runtime, &path, &host_id, host.as_ref(), &local_root, archived)
}

fn delete_session_files(runtime: &PiRuntime, path: &str, host_id: &str, host: Option<&RemoteHost>, local_root: &Path, archived: bool) -> Result<(), String> {
    if runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .any(|agent| agent.host_id == host_id && agent.session_path.as_deref() == Some(path)) {
        return Err("Close the session before deleting it".into());
    }
    let active_session_ids: Vec<String> = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .filter(|agent| agent.host_id == host_id).filter_map(|agent| agent.session_id.clone()).collect();
    let arguments = json!({ "path": path, "activeSessionIds": active_session_ids, "area": if archived { "archived" } else { "sessions" }, "root": if host_id == "local" { Some(local_root) } else { None } }).to_string();
    let script = include_str!("../resources/delete-session.cjs");
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.args(["-e", script, &arguments]);
        command
    } else {
        let host = host.ok_or("Remote host is required")?;
        let mut command = ssh(host);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments))));
        command
    };
    let output = run_limited(&mut command, 256 * 1024, "Could not delete session")?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not delete session".into() } else { error })
}

#[tauri::command(async)]
fn delete_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>) -> Result<(), String> {
    delete_stored_session(app, &runtime, session_path, host_id, false)
}

#[tauri::command(async)]
fn delete_archived_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>) -> Result<(), String> {
    delete_stored_session(app, &runtime, session_path, host_id, true)
}

#[tauri::command(async)]
fn relocate_session(app: AppHandle, session_path: String, cwd: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        return relocate_remote_session(&session_path, &cwd, &host.name, |script| { let mut command = ssh(host); command.arg(remote_login_command(&script)); command });
    }
    relocate_local_session(&home_dir()?, &session_path, &cwd)
}

fn relocate_remote_session(session_path: &str, cwd: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let session = shell_quote(session_path); let replacement = shell_quote(cwd.trim());
    let script = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) || exit 1; path=$(realpath -- {session}) || exit 1; case "$path" in "$root"/*.jsonl) ;; *) printf 'Refusing to relocate a non-desktop session file' >&2; exit 1 ;; esac; replacement={replacement}; [ -d "$replacement" ] || {{ printf 'Project directory does not exist: %s' "$replacement" >&2; exit 1; }}; PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e 'const fs=require("fs"); const [path,cwd]=process.argv.slice(1); const content=fs.readFileSync(path,"utf8"); const newline=content.indexOf("\n"); const first=newline<0?content:content.slice(0,newline); const rest=newline<0?"":content.slice(newline+1); const header=JSON.parse(first); if(header.type!=="session") throw new Error("Invalid session header"); header.cwd=cwd; const temporary=path+"."+process.pid+".tmp"; try {{ fs.writeFileSync(temporary,JSON.stringify(header)+(newline<0?"":"\n"+rest),{{mode:fs.statSync(path).mode}}); fs.renameSync(temporary,path); }} catch(error) {{ try {{ fs.unlinkSync(temporary); }} catch {{}} throw error; }}' "$path" "$replacement""#);
    let output = run_limited(&mut command(script), 64 * 1024, &format!("Could not relocate conversation on {host_name}"))?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { format!("Could not relocate conversation on {host_name}") } else { error })
}

fn relocate_local_session(home: &Path, session_path: &str, cwd: &str) -> Result<(), String> {
    let replacement = PathBuf::from(cwd.trim());
    if !replacement.is_dir() { return Err(format!("Project directory does not exist: {}", replacement.display())); }
    let path = local_desktop_session_file_at(home, session_path)?;
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

fn resolve_agent<'a>(sessions: &'a [SessionSummary], host_id: &str, session_id: &str) -> Result<&'a SessionSummary, String> {
    sessions.iter().find(|session| session.host_id == host_id && session.id == session_id).ok_or_else(|| format!("Agent {host_id}/{session_id} was not found"))
}

fn agent_is_active(session: &SessionSummary, agent: &AgentAddress) -> bool {
    !agent.messageable && agent.host_id == session.host_id && (agent.session_id.as_deref() == Some(session.id.as_str()) || agent.session_path.as_deref() == Some(session.path.as_str()))
}

fn dispatch_agent_message(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, message: &str, request_id: &str, deadline_ms: u64) -> Result<String, String> {
    let remaining = deadline_ms.saturating_sub(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64);
    if remaining == 0 || broker.closing.load(Ordering::SeqCst) { return Err("Agent message expired or app is closing".into()); }
    let deadline = Instant::now() + Duration::from_millis(remaining.min(120_000));
    let runtime = app.state::<PiRuntime>();
    let (settings, _claim) = {
        let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
        let settings = load_app_settings(app.clone())?;
        let claim = claim_agent(broker, &session.host_id, &session.id)?;
        let daemon = runtime.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?.get(&session.host_id).cloned();
        if let Some(daemon) = daemon.filter(|daemon| daemon.alive.load(Ordering::SeqCst)) {
            daemon.request(json!({"type":"retire","sessionKey":session.id,"sessionPath":session.path}))?;
        }
        (settings, claim)
    };
    if Instant::now() >= deadline { return Err("Agent message expired".into()); }
    let mut command = build_pi_command(broker, &settings, &session.host_id, PiLaunch::Print { cwd: &session.cwd, session_path: &session.path }, None)?;
    let output_root = std::env::temp_dir().join(format!("pi-desktop-broker-{}", Uuid::new_v4()));
    ensure_private_dir(&output_root).map_err(|error| format!("Could not prepare agent message: {error}"))?;
    let stdout_path = output_root.join("stdout"); let stderr_path = output_root.join("stderr");
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("Could not capture agent output: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("Could not capture agent errors: {error}"))?;
    command.stdin(Stdio::piped()).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    if Instant::now() >= deadline { let _ = fs::remove_dir_all(&output_root); return Err("Agent message expired".into()); }
    if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.remove(request_id) { let _ = fs::remove_dir_all(&output_root); return Err("Agent message was cancelled".into()); }
    let spawned = command.spawn();
    let child = match spawned { Ok(child) => Arc::new(Mutex::new(child)), Err(error) => { let _ = fs::remove_dir_all(&output_root); return Err(format!("Could not message agent: {error}")); } };
    let _writer = BrokerWriter { child: child.clone(), _claim };
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
            let session = resolve_agent(&sessions, host_id, session_id)?;
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
            let busy = broker.busy.lock().map_err(|_| "Broker claim lock was poisoned")?.clone();
            collect_sessions(&app, &session_index).map(|sessions| json!(sessions.into_iter().map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":busy.contains(&format!("{}\0{}", session.host_id, session.id)) || active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
        },
        ("POST", "/worktrees/create") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid worktree request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            let cwd = value["cwd"].as_str().ok_or("cwd is required")?;
            let name = value["name"].as_str().ok_or("name is required")?;
            let settings = load_app_settings(app.clone())?;
            let created = create_git_worktree(app.clone(), cwd.into(), name.into(), Some(host_id.into()))?;
            let group = session_groups::SessionGroup { id: format!("{host_id}:{}", created.path), name: created.branch.clone(), cwd: Some(created.path.clone()), host_id: Some(host_id.into()), host_name: Some(settings.hosts.iter().find(|host| host.id == host_id).map(|host| host.name.clone()).unwrap_or_else(|| host_id.into())), project_kind: Some(ProjectKind::Worktree) };
            let group_error = change_session_groups(app.clone(), session_groups::GroupChange::Project { project: group, key: None }).err();
            let setup = run_worktree_scripts(&settings, cwd, &created.path, host_id, &AtomicBool::new(false), WorktreeScriptPhase::Setup);
            Ok(json!({"path":created.path,"branch":created.branch,"setupError":setup.err(),"groupError":group_error}))
        })(),
        ("POST", "/worktrees/remove") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid worktree request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            let cwd = value["cwd"].as_str().ok_or("cwd is required")?;
            let removed = remove_git_worktree_blocking(app.clone(), cwd.into(), Some(host_id.into()), value["deleteBranch"].as_bool().unwrap_or(false))?;
            serde_json::to_value(removed).map_err(|error| error.to_string())
        })(),
        ("POST", "/worktree-agents") => worktree_agents(&app.state::<PiRuntime>(), &body),
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

fn worktree_agents(runtime: &PiRuntime, body: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid worktree request")?;
    let id = value.get("id").and_then(Value::as_str).ok_or("Agent identity is required")?;
    let agents = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?;
    let caller = agents.values().find(|agent| agent.presence_id.as_deref() == Some(id)).ok_or("Could not identify this agent; try again")?;
    let root = caller.worktree.as_deref().ok_or("Could not identify this worktree")?;
    let others: Vec<_> = agents.values().filter(|agent| agent.presence_id.as_deref() != Some(id) && agent.host_id == caller.host_id && agent.working && agent.worktree.as_deref() == Some(root))
        .map(|agent| json!({"sessionId":agent.session_id})).collect();
    Ok(json!(others))
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

#[cfg(target_os = "linux")]
const LOAD_ERROR_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>piop - connection error</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #181817; color: #e8e5dd; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 32px; background: #181817; }
    main { width: min(440px, 100%); padding: 30px; border: 1px solid #34322d; border-radius: 12px; background: #1f1f1c; box-shadow: 0 18px 60px #0006; }
    .eyebrow { margin: 0 0 10px; color: #d46a24; font-size: 11px; font-weight: 600; letter-spacing: .15em; text-transform: uppercase; }
    h1 { margin: 0 0 10px; font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
    p { margin: 0; color: #a09c93; font-size: 14px; line-height: 1.55; }
    button { margin-top: 22px; padding: 9px 14px; border: 1px solid #48453e; border-radius: 7px; background: #292824; color: #e8e5dd; font: 600 13px system-ui, sans-serif; cursor: pointer; }
    button:hover { border-color: #d46a24; color: #fff; }
    button:focus-visible { outline: 2px solid #d46a24; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">piop</p>
    <h1>Could not connect</h1>
    <p>The local app server is not available. Start or restart it, then try again.</p>
    <button type="button" onclick="window.location.reload()">Try again</button>
  </main>
</body>
</html>"#;

pub fn run() {
    let mut context = tauri::generate_context!();
    if DEVELOPMENT {
        let config = context.config_mut();
        config.identifier = "dev.pi.desktop.debug".into();
        config.product_name = Some(APP_TITLE.into());
        for window in &mut config.app.windows { window.title = APP_TITLE.into(); }
    }
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
    builder.plugin(tauri_plugin_dialog::init()).manage(voice::VoiceRuntime::default()).manage(PiRuntime::default()).manage(TerminalRuntime::default()).manage(SessionIndexRuntime::default()).manage(broker.clone()).setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(target_os = "linux")]
        if let Some((label, focus)) = start_window.as_ref() {
            use gtk::prelude::GtkWindowExt;
            use webkit2gtk::WebViewExt;
            let window = app.get_webview_window(label).ok_or("Missing main window")?;
            window.with_webview(|platform_webview| {
                platform_webview.inner().connect_load_failed(|webview, _, failing_uri, _| {
                    webview.load_alternate_html(LOAD_ERROR_HTML, failing_uri, None);
                    true
                });
            })?;
            window.gtk_window()?.set_focus_on_map(*focus);
            window.show()?;
        }
        mobile::start(app.handle().clone()).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
        start_session_broker(app.handle().clone(), broker.clone()).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
        Ok(())
    }).invoke_handler(tauri::generate_handler![voice_configuration, voice_start, voice_stop, voice_mute, voice_suppress, voice_context, start_pi, stop_pi, pi_command, pi_presence, new_window, start_terminal, write_terminal, resize_terminal, close_terminal, list_sessions, storage_report, load_session_groups, change_session_groups, list_hooks, home_directory, create_temporary_chat, remove_temporary_chat, validate_project_directory, list_directories, is_git_repository, git_branch, git_project_kind, git_worktree_roots, create_project_worktree, create_git_worktree, remove_git_worktree, prepare_worktree_setup, cancel_worktree_setup, run_worktree_setup, capture_git_tree, discard_git_tree, load_git_diff, load_git_diffs, save_git_diffs, archive_session, delete_session, delete_archived_session, relocate_session, open_project_directory, open_external_url, read_dropped_file, load_app_settings, save_app_settings, codex_usage, opencode_go_usage]).build(context).expect("error while building piop").run(|app, event| {
        if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
            let app = app.clone(); let label = label.clone();
            thread::spawn(move || {
                let runtime = app.state::<PiRuntime>();
                let ids = runtime.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == label).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
                for id in ids { let _ = detach_pi(&runtime, &id, true); }
                let terminals = app.state::<TerminalRuntime>();
                let ids = terminals.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == label).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
                let _ = stop_terminals(&terminals, &ids);
            });
        }
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<voice::VoiceRuntime>().shutdown();
            let broker = app.state::<BrokerRuntime>(); broker.closing.store(true, Ordering::SeqCst);
            let jobs = broker.jobs.lock().map(|mut jobs| jobs.drain().map(|(_, child)| child).collect::<Vec<_>>()).unwrap_or_default();
            for child in jobs { if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); } }
            // The webview cannot await cleanup during pagehide. Own shutdown here.
            let runtime = app.state::<PiRuntime>();
            if let Ok(daemons) = runtime.daemons.lock() { for daemon in daemons.values() { daemon.shutdown(); } }
            let ephemeral = runtime.ephemeral_sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()).unwrap_or_default();
            for session in ephemeral { remove_ephemeral_session(session); }
        }
    });
}
