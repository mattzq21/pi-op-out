use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
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
    processes: Mutex<HashMap<String, PiProcess>>,
    pending: Arc<Mutex<HashMap<(String, String), mpsc::Sender<Result<Value, String>>>>>,
    active_agents: Mutex<HashMap<String, AgentAddress>>,
}

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String> }

#[derive(Clone)]
struct BrokerRuntime { port: Arc<Mutex<u16>>, token: String, busy: Arc<Mutex<HashSet<String>>> }

impl Default for BrokerRuntime {
    fn default() -> Self { Self { port: Arc::new(Mutex::new(0)), token: Uuid::new_v4().to_string(), busy: Arc::new(Mutex::new(HashSet::new())) } }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitDiffSnapshot { patch: String, scope: String }

type GitDiffSnapshots = HashMap<String, GitDiffSnapshot>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    default_model: String,
    default_thinking: String,
    #[serde(default = "default_context_window_cap")]
    context_window_cap: u64,
    auto_compaction: bool,
    auto_retry: bool,
    #[serde(default = "default_keybindings")]
    keybindings: HashMap<String, String>,
    tools: Vec<Value>,
    skills: Vec<Value>,
    mcp_servers: Vec<Value>,
    #[serde(default)]
    hosts: Vec<RemoteHost>,
}

fn default_pi_path() -> String { "pi".into() }
fn default_context_window_cap() -> u64 { 200_000 }

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

fn prepare_mcp_bridge(app: &AppHandle, settings: &AppSettings) -> Result<(PathBuf, PathBuf), String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let extension_path = dir.join("pi-desktop-mcp-bridge.ts");
    let config_path = dir.join("mcp-servers.json");
    fs::write(&extension_path, include_str!("../resources/mcp-bridge.ts")).map_err(|error| error.to_string())?;
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
        default_model: String::new(), default_thinking: "high".into(), context_window_cap: default_context_window_cap(), auto_compaction: true, auto_retry: true, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List agents by machine and session","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Send a message to another agent","enabled":true,"builtin":false}),
        ]).collect(),
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
    let mut settings = if !path.exists() { default_settings() } else { serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? };
    for shortcut in settings.keybindings.values_mut() { *shortcut = shortcut.replace("Mod+", "Ctrl+"); }
    for tool in default_settings().tools { if !settings.tools.iter().any(|current| current.get("name") == tool.get("name")) { settings.tools.push(tool); } }
    merge_discovered_skills(&mut settings); Ok(settings)
}

#[tauri::command(async)]
fn save_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    if settings.context_window_cap == 0 { return Err("Context window cap must be a positive integer".into()); }
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

fn append_git_output(command: &mut Command, patch: &mut Vec<u8>) -> Result<(), String> {
    let output = command.output().map_err(|error| format!("Could not read Git changes: {error}"))?;
    // `git diff --no-index` returns 1 when differences are present.
    if !output.status.success() && output.status.code() != Some(1) { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    patch.extend(output.stdout);
    Ok(())
}

fn local_git_tree(cwd: &str) -> Result<Option<String>, String> {
    let requested = Path::new(cwd).canonicalize().map_err(|error| format!("Could not open project directory: {error}"))?;
    let root = Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel"]).output().map_err(|error| format!("Could not run Git: {error}"))?;
    if !root.status.success() { return Ok(None); }
    let root = PathBuf::from(String::from_utf8_lossy(&root.stdout).trim()).canonicalize().map_err(|error| format!("Could not resolve Git root: {error}"))?;
    if root != requested { return Ok(None); }
    let index = std::env::temp_dir().join(format!("pi-desktop-diff-{}.index", Uuid::new_v4()));
    let has_head = Command::new("git").args(["-C", cwd, "rev-parse", "--verify", "HEAD"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|status| status.success()).unwrap_or(false);
    let result = (|| {
        let mut read_tree = Command::new("git"); read_tree.args(["-C", cwd, "read-tree"]).env("GIT_INDEX_FILE", &index); if has_head { read_tree.arg("HEAD"); } else { read_tree.arg("--empty"); }
        let output = read_tree.output().map_err(|error| format!("Could not prepare Git snapshot: {error}"))?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let output = Command::new("git").args(["-C", cwd, "add", "-A", "--", "."]).env("GIT_INDEX_FILE", &index).output().map_err(|error| format!("Could not capture Git snapshot: {error}"))?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let output = Command::new("git").args(["-C", cwd, "write-tree"]).env("GIT_INDEX_FILE", &index).output().map_err(|error| format!("Could not finalize Git snapshot: {error}"))?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })();
    let _ = fs::remove_file(index); result.map(Some)
}

fn local_git_diff(cwd: &str, base_tree: &str) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(current_tree) = local_git_tree(cwd)? else { return Ok(None) };
    let mut patch = Vec::new(); let mut diff = Command::new("git");
    diff.args(["-C", cwd, "diff", "--no-color", "--no-ext-diff", "--find-renames", base_tree, &current_tree, "--"]);
    append_git_output(&mut diff, &mut patch)?;
    let patch = String::from_utf8_lossy(&patch).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot { patch, scope: "turn".into() }))
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let directory = shell_quote(cwd);
    let script = format!("cd {directory} || exit 2; root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3; [ \"$(pwd -P)\" = \"$(cd \"$root\" && pwd -P)\" ] || exit 4; idx=$(mktemp \"${{TMPDIR:-/tmp}}/pi-desktop-diff.XXXXXX\") || exit 5; rm -f \"$idx\"; trap 'rm -f \"$idx\"' EXIT; export GIT_INDEX_FILE=\"$idx\"; if git rev-parse --verify HEAD >/dev/null 2>&1; then git read-tree HEAD; else git read-tree --empty; fi && git add -A -- . && git write-tree");
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not capture Git snapshot on {}: {error}", host.name))?;
    match output.status.code() { Some(3 | 4) => return Ok(None), _ => {} }
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let tree = String::from_utf8_lossy(&output.stdout).trim().to_string(); Ok((!tree.is_empty()).then_some(tree))
}

#[tauri::command(async)]
fn capture_git_tree(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); if host_id == "local" { return local_git_tree(&cwd); }
    let settings = load_app_settings(app)?; remote_git_tree(remote_host(&settings, &host_id)?, &cwd)
}

#[tauri::command(async)]
fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<GitDiffSnapshot>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { return local_git_diff(&cwd, &base_tree); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let Some(current_tree) = remote_git_tree(host, &cwd)? else { return Ok(None) };
    let script = format!("cd {} && git diff --no-color --no-ext-diff --find-renames {} {} --", shell_quote(&cwd), shell_quote(&base_tree), shell_quote(&current_tree));
    let output = ssh(host).arg(script).output().map_err(|error| format!("Could not read Git changes on {}: {error}", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot { patch, scope: "turn".into() }))
}

fn git_diffs_path(session_path: &str) -> PathBuf { Path::new(session_path).with_extension("diffs.json") }

#[tauri::command(async)]
fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<GitDiffSnapshots, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); let path = git_diffs_path(&session_path);
    let content = if host_id == "local" {
        if !path.exists() { return Ok(HashMap::new()); }
        fs::read_to_string(&path).map_err(|error| format!("Could not read saved diffs: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let output = ssh(host).arg(format!("if [ -f {0} ]; then cat -- {0}; else printf '{{}}'; fi", shell_quote(&path.to_string_lossy()))).output().map_err(|error| format!("Could not read saved diffs on {}: {error}", host.name))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Saved remote diffs were not valid UTF-8".to_string())?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

#[tauri::command(async)]
fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into()); let path = git_diffs_path(&session_path);
    let body = serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?;
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
    let btw = shell_quote(include_str!("../resources/btw.ts"));
    let orchestration = shell_quote(include_str!("../../extensions/pi-orchestration/index.ts"));
    let context_window_cap = shell_quote(include_str!("../../extensions/pi-context-window-cap/index.ts"));
    let context_window_config = shell_quote(&serde_json::to_string_pretty(&json!({ "contextWindowCap": settings.context_window_cap })).map_err(|error| error.to_string())?);
    let mcp_bridge = shell_quote(include_str!("../resources/mcp-bridge.ts"));
    let mcp_config = shell_quote(&serde_json::to_string_pretty(&settings.mcp_servers).map_err(|error| error.to_string())?);
    let remote = format!("mkdir -p \"$HOME/.pi-desktop/pi-context-window-cap\" \"$HOME/.pi/agent/extensions/pi-orchestration\" && printf %s {broker} > \"$HOME/.pi-desktop/session-broker.ts\" && printf %s {mcp_bridge} > \"$HOME/.pi-desktop/pi-desktop-mcp-bridge.ts\" && printf %s {mcp_config} > \"$HOME/.pi-desktop/mcp-servers.json\" && printf %s {context_window_cap} > \"$HOME/.pi-desktop/pi-context-window-cap/index.ts\" && printf %s {context_window_config} > \"$HOME/.pi-desktop/pi-context-window-cap/config.json\" && printf %s {btw} > \"$HOME/.pi/agent/extensions/pi-desktop-btw.ts\" && printf %s {orchestration} > \"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\"");
    let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not install Pi Desktop extensions on {}: {error}", host.name))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

enum PiLaunch<'a> {
    Rpc { cwd: Option<&'a str>, session_path: Option<&'a str>, session_id: Option<&'a str>, fork_path: Option<&'a str> },
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
    if host_id == "local" {
        let (mcp_extension, mcp_config) = prepare_mcp_bridge(app, settings)?; let context_window_cap_extension = prepare_context_window_cap_extension(app, settings)?; let pi_path = pi_executable();
        let mut command = Command::new(&pi_path); command.arg(if is_rpc { "--mode" } else { "--print" }); if is_rpc { command.arg("rpc"); }
        command.arg("--approve").arg("--no-skills").arg("--extension").arg(mcp_extension).arg("--extension").arg(prepare_session_broker(app)?).arg("--extension").arg(&context_window_cap_extension)
            .env("PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION", &context_window_cap_extension).env("PI_DESKTOP_MCP_CONFIG", mcp_config).env("PI_DESKTOP_BROKER_URL", format!("http://127.0.0.1:{broker_port}")).env("PI_DESKTOP_BROKER_TOKEN", &broker_token).env("PI_DESKTOP_ALLOWED_TOOLS", &allowed_tools).env("PI_DESKTOP_SKILL_PATHS", &local_skills);
        match launch {
            PiLaunch::Rpc { cwd, session_path, session_id, fork_path } => {
                let working_dir = match cwd { Some("~") => home_dir()?, Some(path) => PathBuf::from(path), None => std::env::current_dir().map_err(|error| error.to_string())? };
                command.current_dir(working_dir).arg("--extension").arg(prepare_btw_extension()?).env("PI_DESKTOP_BTW", "1").env("PI_DESKTOP_PI_EXECUTABLE", &pi_path);
                if let Some(path) = fork_path { command.arg("--fork").arg(path); } else if let Some(path) = session_path { command.arg("--session").arg(path); } else if let Some(id) = session_id { command.arg("--session-id").arg(id); }
            }
            PiLaunch::Print { cwd, session_path, .. } => { command.current_dir(cwd).arg("--session").arg(session_path); }
        }
        if !disabled_tools.is_empty() { command.arg("--exclude-tools").arg(disabled_tools.join(",")); }
        if !settings.default_model.trim().is_empty() { command.arg("--model").arg(settings.default_model.trim()); }
        if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
        if let Some(message) = print_message { command.arg(message); }
        return Ok(command);
    }
    let host = remote_host(settings, host_id)?; stage_remote_extensions(host, settings)?; let remote_port = remote_broker_port(); let remote_pi = remote_pi_path(&host.pi_path);
    let mut arguments = vec![remote_pi.clone()]; if is_rpc { arguments.extend(["--mode".into(), "rpc".into()]); } else { arguments.push("--print".into()); }
    arguments.extend(["--approve".into(), "--no-skills".into(), "--extension".into(), "\"$HOME/.pi-desktop/pi-desktop-mcp-bridge.ts\"".into(), "--extension".into(), "\"$HOME/.pi-desktop/session-broker.ts\"".into(), "--extension".into(), "\"$HOME/.pi-desktop/pi-context-window-cap/index.ts\"".into(), "--extension".into(), "\"$HOME/.pi/agent/extensions/pi-orchestration/index.ts\"".into()]);
    let cwd = match launch {
        PiLaunch::Rpc { cwd, session_path, session_id, fork_path } => { arguments.extend(["--extension".into(), "\"$HOME/.pi/agent/extensions/pi-desktop-btw.ts\"".into()]); if let Some(path) = fork_path { arguments.extend(["--fork".into(), shell_quote(path)]); } else if let Some(path) = session_path { arguments.extend(["--session".into(), shell_quote(path)]); } else if let Some(id) = session_id { arguments.extend(["--session-id".into(), shell_quote(id)]); } cwd },
        PiLaunch::Print { cwd, session_path, .. } => { arguments.extend(["--session".into(), shell_quote(session_path)]); Some(cwd) },
    };
    if !disabled_tools.is_empty() { arguments.extend(["--exclude-tools".into(), shell_quote(&disabled_tools.join(","))]); }
    if !settings.default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(settings.default_model.trim())]); }
    if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
    if let Some(message) = print_message { arguments.push(shell_quote(message)); }
    let rpc_environment = if is_rpc { format!(" PI_DESKTOP_BTW=1 PI_DESKTOP_PI_EXECUTABLE={remote_pi}") } else { String::new() };
    let remote = format!("cd {} && PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION=\"$HOME/.pi-desktop/pi-context-window-cap/index.ts\" PI_DESKTOP_MCP_CONFIG=\"$HOME/.pi-desktop/mcp-servers.json\" PI_DESKTOP_BROKER_URL={} PI_DESKTOP_BROKER_TOKEN={} PI_DESKTOP_ALLOWED_TOOLS={} PI_DESKTOP_SKILL_PATHS={}{} exec {}", remote_directory_path(cwd), shell_quote(&format!("http://127.0.0.1:{remote_port}")), shell_quote(&broker_token), shell_quote(&allowed_tools), shell_quote(&remote_skills), rpc_environment, arguments.join(" "));
    let mut command = remote_broker_command(host, broker_port, remote_port); command.arg(remote); Ok(command)
}

#[tauri::command(async)]
fn start_pi(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, host_id: Option<String>) -> Result<(), String> {
    if runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.contains_key(&runtime_id) { return Ok(()); }
    let settings = load_app_settings(app.clone()).unwrap_or_else(|_| default_settings());
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let mut command = build_pi_command(&app, &broker, &settings, &host_id, PiLaunch::Rpc { cwd: cwd.as_deref(), session_path: session_path.as_deref(), session_id: session_id.as_deref(), fork_path: fork_path.as_deref() })?;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("Could not start pi: {error}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("Pi stdin was unavailable")?));
    let stdout = child.stdout.take().ok_or("Pi stdout was unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi stderr was unavailable")?;
    let pending = runtime.pending.clone(); let event_app = app.clone(); let event_runtime_id = runtime_id.clone();
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
        fail_pending(&pending, &event_runtime_id, "Pi disconnected before responding");
        let _ = event_app.emit("pi://event", json!({"runtimeId":event_runtime_id,"event":{"type":"disconnected"}}));
    });
    let error_app = app.clone();
    thread::spawn(move || for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = error_app.emit("pi://stderr", line); });
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { child, stdin });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id, AgentAddress { host_id, session_id, session_path });
    Ok(())
}

#[tauri::command(async)]
fn stop_pi(runtime: State<PiRuntime>, runtime_id: String) -> Result<(), String> {
    if let Some(mut process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(&runtime_id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(&runtime_id);
    fail_pending(&runtime.pending, &runtime_id, "Pi disconnected before responding");
    Ok(())
}

#[tauri::command(async)]
fn pi_command(runtime: State<PiRuntime>, runtime_id: String, mut command: Value) -> Result<Value, String> {
    let fire_and_forget = command.get("type").and_then(Value::as_str) == Some("extension_ui_response");
    let id = command.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
    command.as_object_mut().ok_or("RPC command must be an object")?.insert("id".into(), Value::String(id.clone()));
    let (sender, receiver) = mpsc::channel();
    runtime.pending.lock().map_err(|_| "Pending command lock was poisoned")?.insert((runtime_id.clone(), id.clone()), sender);
    let write_result = (|| {
        let process_guard = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?;
        let process = process_guard.get(&runtime_id).ok_or("Pi is not running")?;
        let mut stdin = process.stdin.lock().map_err(|_| "Pi stdin lock was poisoned")?;
        serde_json::to_writer(&mut *stdin, &command).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
    })();
    if let Err(error) = write_result { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.clone(), id.clone()))); return Err(error); }
    if fire_and_forget { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id.clone(), id.clone()))); return Ok(Value::Null); }
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| { runtime.pending.lock().ok().map(|mut map| map.remove(&(runtime_id, id))); "Pi command timed out".to_string() })?
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
        if let Some(config) = user_ssh_config() { command.arg("-F"); command.arg(config); }
        command.args(["-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", &host.target, &format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))]); command
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

#[tauri::command(async)]
fn close_terminal(runtime: State<TerminalRuntime>, terminal_id: String) -> Result<(), String> {
    if let Some(mut process) = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.remove(&terminal_id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    Ok(())
}

fn stop_terminals_for_state(runtime: &TerminalRuntime, state: &mut Value) -> Result<(), String> {
    let Some(tabs) = state.get_mut("tabs").and_then(Value::as_array_mut) else { return Ok(()) };
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    for tab in tabs {
        let Some(id) = tab.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        if let Some(mut process) = processes.remove(&id) { let _ = process.child.kill(); let _ = process.child.wait(); }
        if let Some(tab) = tab.as_object_mut() { tab.insert("exited".into(), Value::Bool(true)); }
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
    let mut name = None; let mut first_user_message = String::new(); let mut preview = String::new(); let mut message_count = 0;
    for line in lines { let Ok(entry) = serde_json::from_str::<Value>(line) else { continue }; if entry.get("type").and_then(Value::as_str) == Some("session_info") { name = entry.get("name").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned); } if entry.get("type").and_then(Value::as_str) == Some("message") { message_count += 1; if let Some(message) = entry.get("message") { let text = text_content(message); if !text.is_empty() { if first_user_message.is_empty() && message.get("role").and_then(Value::as_str) == Some("user") { first_user_message = text.clone(); } preview = text; } } } }
    let name = name.unwrap_or_else(|| if first_user_message.is_empty() { "Untitled session".into() } else { first_user_message });
    let project = Path::new(&cwd).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").to_string();
    Some(SessionSummary { id, path: path.to_string_lossy().into_owned(), name, project, cwd, cwd_exists, modified_at: unix_timestamp(modified), preview: preview.chars().take(100).collect(), message_count, host_id: host_id.into(), host_name: host_name.into() })
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
        // Remote CWD existence is validated when Pi starts; batch it here only if stale remote paths become common.
        if let Some(session) = parse_session_content(&path, &content, SystemTime::UNIX_EPOCH + Duration::from_secs(seconds), true, &host.id, &host.name) { sessions.push(session); }
    }
    Ok(sessions)
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
    Ok(cwd)
}

#[tauri::command(async)]
fn create_temporary_chat(app: AppHandle, host_id: String) -> Result<TemporaryChat, String> {
    let session_id = Uuid::new_v4().to_string();
    let cwd = if host_id == "local" {
        create_local_temporary_chat(&home_dir()?, &session_id)?.to_string_lossy().into_owned()
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let remote = format!("mkdir -p \"$HOME/pi-desktop/tmp/{session_id}\" && cd \"$HOME/pi-desktop/tmp/{session_id}\" && pwd -P");
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

fn collect_sessions(app: &AppHandle) -> Result<Vec<SessionSummary>, String> {
    let root = home_dir()?.join(".pi/agent/sessions");
    let mut sessions: Vec<_> = if root.exists() { WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")).filter_map(|entry| parse_session(entry.path())).collect() } else { vec![] };
    let hosts = load_app_settings(app.clone())?.hosts;
    thread::scope(|scope| {
        let requests: Vec<_> = hosts.iter().map(|host| scope.spawn(move || list_remote_sessions(host))).collect();
        for request in requests { if let Ok(Ok(mut remote)) = request.join() { sessions.append(&mut remote); } }
    });
    sessions.sort_by(|left, right| right.modified_at.cmp(&left.modified_at)); Ok(sessions)
}

#[tauri::command(async)]
fn list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> { collect_sessions(&app) }

fn session_entries(content: &str) -> Value {
    let entries: Vec<Value> = content.lines().skip(1).filter_map(|line| serde_json::from_str(line).ok()).collect();
    let leaf_id = entries.iter().rev().find_map(|entry| entry.get("id").and_then(Value::as_str));
    json!({ "entries": entries, "leafId": leaf_id })
}

#[tauri::command(async)]
fn load_session_entries(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<Value, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let content = if host_id == "local" {
        fs::read_to_string(&session_path).map_err(|error| format!("Could not read session: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let output = ssh(host).arg(format!("cat -- {}", shell_quote(&session_path))).output().map_err(|error| format!("Could not read session on {}: {error}", host.name))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Remote session was not valid UTF-8".to_string())?
    };
    Ok(session_entries(&content))
}

#[tauri::command(async)]
fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, mut terminal_state: Option<Value>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if let Some(state) = terminal_state.as_mut() { stop_terminals_for_state(&runtime, state)?; }
    if host_id != "local" {
        if session_path.contains("/../") || !session_path.contains("/.pi/agent/sessions/") { return Err("Only remote Pi session files can be archived".into()); }
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let file_name = Path::new(&session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
        let destination = format!("{}-{file_name}", Uuid::new_v4());
        let terminal_sidecar = terminal_state.as_ref().map(|state| {
            let sidecar = Path::new(&destination).with_extension("terminals.json").to_string_lossy().into_owned();
            let body = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".into());
            format!(" && printf '%s' {} > \"$HOME/.pi-desktop/archived/{}\"", shell_quote(&body), sidecar)
        }).unwrap_or_default();
        let diff_source = git_diffs_path(&session_path); let diff_destination = Path::new(&destination).with_extension("diffs.json").to_string_lossy().into_owned();
        let remote = format!("mkdir -p \"$HOME/.pi-desktop/archived\"{terminal_sidecar} && mv -- {} \"$HOME/.pi-desktop/archived/{}\" && if [ -f {} ]; then mv -- {} \"$HOME/.pi-desktop/archived/{}\"; fi", shell_quote(&session_path), destination, shell_quote(&diff_source.to_string_lossy()), shell_quote(&diff_source.to_string_lossy()), diff_destination);
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
    if let Some(state) = terminal_state {
        let state_path = destination.with_extension("terminals.json");
        fs::write(&state_path, serde_json::to_vec_pretty(&state).map_err(|error| format!("Could not serialize terminal state: {error}"))?).map_err(|error| format!("Could not save terminal state: {error}"))?;
        if let Err(error) = fs::rename(&source, &destination) { let _ = fs::remove_file(state_path); return Err(format!("Could not archive session: {error}")); }
        let diff_source = source.with_extension("diffs.json"); if diff_source.exists() { fs::rename(diff_source, destination.with_extension("diffs.json")).map_err(|error| format!("Session archived, but its diffs could not be archived: {error}"))?; }
        return Ok(());
    }
    fs::rename(&source, &destination).map_err(|error| format!("Could not archive session: {error}"))?;
    let diff_source = source.with_extension("diffs.json"); if diff_source.exists() { fs::rename(diff_source, destination.with_extension("diffs.json")).map_err(|error| format!("Session archived, but its diffs could not be archived: {error}"))?; }
    Ok(())
}

#[tauri::command(async)]
fn delete_session(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id != "local" {
        if session_path.contains("/../") || !session_path.contains("/.pi/agent/sessions/") || !session_path.ends_with(".jsonl") { return Err("Only remote Pi session files can be deleted".into()); }
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        let diff_path = git_diffs_path(&session_path);
        let remote = format!(r#"root=$(cd "$HOME/.pi/agent/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) rm -- "$target"; rm -f -- {} ;; *) printf 'Refusing to delete a non-session file' >&2; exit 1 ;; esac"#, shell_quote(&session_path), shell_quote(&diff_path.to_string_lossy()));
        let output = ssh(host).arg(remote).output().map_err(|error| format!("Could not delete session on {}: {error}", host.name))?;
        return output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let sessions_root = home_dir()?.join(".pi/agent/sessions").canonicalize().map_err(|error| format!("Could not locate Pi sessions: {error}"))?;
    let source = PathBuf::from(&session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&sessions_root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") { return Err("Only Pi session files can be deleted".into()); }
    if !source.is_file() { return Err(format!("Session file does not exist: {}", source.display())); }
    fs::remove_file(&source).map_err(|error| format!("Could not delete session: {error}"))?;
    let diff_path = source.with_extension("diffs.json"); if diff_path.exists() { fs::remove_file(diff_path).map_err(|error| format!("Session deleted, but its diffs could not be deleted: {error}"))?; }
    Ok(())
}

#[tauri::command(async)]
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

fn dispatch_agent_message(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, message: &str) -> Result<String, String> {
    let settings = load_app_settings(app.clone()).unwrap_or_else(|_| default_settings());
    let mut command = build_pi_command(app, broker, &settings, &session.host_id, PiLaunch::Print { cwd: &session.cwd, session_path: &session.path, message })?;
    let output = command.output().map_err(|error| format!("Could not message agent: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn broker_response(mut stream: TcpStream, status: &str, body: Value) {
    let payload = body.to_string();
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
}

fn handle_broker_request(app: AppHandle, broker: BrokerRuntime, stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new(); reader.read_line(&mut request_line).map_err(|error| error.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or(""); let path = parts.next().unwrap_or("");
    let mut authorized = false; let mut content_length = 0usize;
    loop {
        let mut line = String::new(); reader.read_line(&mut line).map_err(|error| error.to_string())?;
        if line == "\r\n" || line.is_empty() { break; }
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.eq_ignore_ascii_case("authorization") { authorized = value.trim() == format!("Bearer {}", broker.token); }
        if name.eq_ignore_ascii_case("content-length") { content_length = value.trim().parse().unwrap_or(0); }
    }
    if !authorized { broker_response(stream, "401 Unauthorized", json!({"error":"Unauthorized"})); return Ok(()); }
    if content_length > 1024 * 1024 { broker_response(stream, "413 Payload Too Large", json!({"error":"Message is too large"})); return Ok(()); }
    let mut body = vec![0; content_length]; reader.read_exact(&mut body).map_err(|error| error.to_string())?;
    let result = match (method, path) {
        ("GET", "/agents") => {
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            collect_sessions(&app).map(|sessions| json!(sessions.into_iter().map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
        },
        ("POST", "/message") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid message request".to_string())?;
            let host_id = value.get("hostId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("hostId is required")?;
            let session_id = value.get("sessionId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("sessionId is required")?;
            let message = value.get("message").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("message is required")?;
            let sessions = collect_sessions(&app)?;
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            let session = resolve_agent(&sessions, host_id, session_id, &active)?;
            let _claim = claim_agent(&broker, host_id, session_id)?;
            dispatch_agent_message(&app, &broker, session, message).map(|reply| json!({"reply":reply}))
        })(),
        _ => Err("Unknown session broker endpoint".into()),
    };
    match result { Ok(data) => broker_response(stream, "200 OK", json!({"data":data})), Err(error) => broker_response(stream, "400 Bad Request", json!({"error":error})) }
    Ok(())
}

fn start_session_broker(app: AppHandle, broker: BrokerRuntime) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("Could not start session broker: {error}"))?;
    *broker.port.lock().map_err(|_| "Session broker lock was poisoned")? = listener.local_addr().map_err(|error| error.to_string())?.port();
    thread::spawn(move || for stream in listener.incoming().flatten() { let app = app.clone(); let broker = broker.clone(); thread::spawn(move || { let _ = handle_broker_request(app, broker, stream); }); });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let broker = BrokerRuntime::default();
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(PiRuntime::default()).manage(TerminalRuntime::default()).manage(broker.clone()).setup(move |app| start_session_broker(app.handle().clone(), broker.clone()).map_err(Into::into)).invoke_handler(tauri::generate_handler![start_pi, stop_pi, pi_command, start_terminal, write_terminal, resize_terminal, close_terminal, list_sessions, load_session_entries, home_directory, create_temporary_chat, list_directories, capture_git_tree, load_git_diff, load_git_diffs, save_git_diffs, archive_session, delete_session, relocate_session, open_project_directory, load_app_settings, save_app_settings, codex_usage]).run(tauri::generate_context!()).expect("error while running Pi desktop");
}
