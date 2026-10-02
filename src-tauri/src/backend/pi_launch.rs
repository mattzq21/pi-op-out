pub(super) use crate::settings_types::validate_remote_host;
use std::{collections::HashMap, sync::Mutex};
use crate::broker::broker_environment;
use serde_json::json;
use serde_json::Value;
use std::fs;
use std::thread;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use crate::platform::AppHandle;
use uuid::Uuid;
use crate::{AppSettings, BrokerRuntime, DEVELOPMENT, PiRuntime, RemoteHost, STORAGE_DIRECTORY, hash_claim_key, node_command};
use crate::archives::{local_desktop_session_file_at};
use crate::worktree_setup::{ensure_desktop_sessions_dir, run_limited, shell_quote};
use crate::environment::home_dir;
use crate::environment::pi_executable;
use crate::settings::{load_app_settings};
use crate::extensions::{SESSION_BROKER_MODULES, LEGACY_FILE_CHANGE_ASSETS, LOOP_DETECTION_ASSETS, generated_extension_root, prepare_codex_web_search_extension, prepare_context_bar_extension, prepare_context_window_cap_extension, prepare_defined_agents_extension, prepare_diff_watch_extension, prepare_fast_mode_extension, prepare_loop_detection_extension, prepare_mcp_bridge, prepare_openai_cache_fork_extension, prepare_rtk_extension, prepare_runtime_settings, prepare_session_broker, prepare_session_cost_limit_extension, prepare_trace_reader, runtime_settings};

pub(super) fn saved_remote_host(app: AppHandle, host_id: Option<String>) -> Result<Option<RemoteHost>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    if host_id == "local" { return Ok(None); }
    Ok(Some(remote_host(&load_app_settings(app)?, &host_id)?.clone()))
}


pub(super) fn remote_host<'a>(settings: &'a AppSettings, host_id: &str) -> Result<&'a RemoteHost, String> {
    let host = settings.hosts.iter().find(|host| host.id == host_id).ok_or_else(|| format!("Unknown machine: {host_id}"))?;
    if !host.enabled { return Err(format!("Machine {} is disabled", host.name)); }
    validate_remote_host(host)?;
    Ok(host)
}

pub(super) fn user_ssh_config() -> Option<PathBuf> { home_dir().ok().map(|home| home.join(".ssh/config")).filter(|path| path.is_file()) }

pub(super) fn remote_login_command(command: &str) -> String { format!("bash -lc {}", shell_quote(command)) }

pub(super) fn ssh_base() -> Command {
    let mut command = Command::new("ssh");
    if let Some(config) = user_ssh_config() { command.arg("-F").arg(config); }
    command.args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5"]); command
}

pub(super) fn ssh(host: &RemoteHost) -> Command {
    let mut command = ssh_base(); command.arg(&host.target); command
}

pub(super) fn remote_pi_path(path: &str) -> String {
    if path == "pi" { return "\"$(bash -lc 'command -v pi')\"".into(); }
    path.strip_prefix("~/").map(|rest| format!("$HOME/{}", rest)).unwrap_or_else(|| shell_quote(path))
}

pub(super) fn remote_directory_path(path: Option<&str>) -> String {
    match path.map(str::trim).filter(|path| !path.is_empty()) {
        None | Some("~") => "\"$HOME\"".into(),
        Some(path) if path.starts_with("~/") => format!("$HOME/{}", shell_quote(&path[2..])),
        Some(path) => shell_quote(path),
    }
}

pub(super) fn remove_ephemeral_session(session: EphemeralSession) {
    let script = include_str!("../../resources/cleanup-ephemeral-session.bundle.mjs");
    let result = match session {
        EphemeralSession::Local(path) => node_command().args(["-e", script]).arg(path).output(),
        EphemeralSession::Remote { host, path } => ssh(&host).arg(remote_login_command(&format!("node -e {} {}", shell_quote(script), shell_quote(&path)))).output(),
    };
    match result { Ok(output) if output.status.success() => {}, Ok(output) => eprintln!("Could not clean up side conversation: {}", String::from_utf8_lossy(&output.stderr)), Err(error) => eprintln!("Could not clean up side conversation: {error}") }
}

pub(super) fn cleanup_runtime_ephemeral(runtime: &PiRuntime, runtime_id: &str) -> Result<(), String> {
    let key = runtime.ephemeral.keys.lock().map_err(|_| "Side conversation lock was poisoned")?.remove(runtime_id).unwrap_or_else(|| runtime_id.to_string());
    let current = runtime.ephemeral.sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.remove(&key);
    let previous = runtime.ephemeral.previous.lock().map_err(|_| "Side conversation lock was poisoned")?.remove(&key).unwrap_or_default();
    for session in previous.into_iter().chain(current) { remove_ephemeral_session(session); }
    Ok(())
}

pub(super) fn create_ephemeral_fork(settings: &AppSettings, host_id: &str, source_path: &str, leaf_id: Option<&str>) -> Result<(String, EphemeralSession), String> {
    if host_id == "local" {
        return create_local_ephemeral_fork(&home_dir()?, &std::env::temp_dir(), source_path, leaf_id);
    }
    let host = remote_host(settings, host_id)?.clone();
    let destination = format!("/tmp/pi-desktop-btw-{}.jsonl", Uuid::new_v4());
    let path = create_remote_ephemeral_fork(source_path, &destination, &host.name, leaf_id, |script| { let mut command = ssh(&host); command.arg(remote_login_command(&script)); command })?;
    Ok((path.clone(), EphemeralSession::Remote { host, path }))
}

pub(super) fn create_remote_ephemeral_fork(source_path: &str, destination: &str, host_name: &str, leaf_id: Option<&str>, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let remote = format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {} {} {} {} && printf %s {}", shell_quote(include_str!("../../resources/fork-session.cjs")), shell_quote(source_path), shell_quote(destination), shell_quote(&Uuid::new_v4().to_string()), leaf_id.map(shell_quote).unwrap_or_default(), shell_quote(destination));
    let output = command(remote).output().map_err(|error| format!("Could not create temporary side conversation on {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("Temporary side conversation path was unavailable".into()); }
    Ok(path)
}

pub(super) fn create_local_ephemeral_fork(home: &Path, temporary_dir: &Path, source_path: &str, leaf_id: Option<&str>) -> Result<(String, EphemeralSession), String> {
    let source = local_desktop_session_file_at(home, source_path)?;
    let path = temporary_dir.join(format!("pi-desktop-btw-{}.jsonl", Uuid::new_v4()));
    let output = node_command().args(["-e", include_str!("../../resources/fork-session.cjs")]).arg(source).arg(&path).arg(Uuid::new_v4().to_string()).args(leaf_id).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    Ok((path.to_string_lossy().into_owned(), EphemeralSession::Local(path)))
}

impl EphemeralSession {
    pub(super) fn path(&self) -> String {
        match self { Self::Local(path) => path.to_string_lossy().into_owned(), Self::Remote { path, .. } => path.clone() }
    }
}

pub(super) fn prepare_ephemeral_path(runtime: &PiRuntime, runtime_id: &str, ephemeral: bool, saved: Option<EphemeralSession>, source: Option<&str>, fork: impl FnOnce(&str) -> Result<(String, EphemeralSession), String>) -> Result<Option<String>, String> {
    let resolved = if let Some(saved) = saved {
        let path = saved.path();
        Some((path, saved))
    } else if ephemeral {
        match source { Some(source_path) => Some(fork(source_path)?), None => None }
    } else { None };
    match resolved {
        Some((path, session)) => { runtime.ephemeral.sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.insert(runtime_id.to_string(), session); Ok(Some(path)) }
        None => Ok(None),
    }
}

pub(super) fn enabled_tool_names(settings: &AppSettings) -> Vec<&str> {
    settings.tools.iter().filter(|tool| tool.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect()
}

pub(super) fn session_identity(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
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

pub(super) fn read_remote_session_header(path: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
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
    let rtk_extension = shell_quote(include_str!("../../../extensions/piop-rtk/rtk.ts"));
    let rtk_license = shell_quote(include_str!("../../../extensions/piop-rtk/LICENSE"));
    let runtime_settings_extension = shell_quote(include_str!("../../../extensions/piop-runtime-settings/index.ts"));
    let provider_accounts = shell_quote(include_str!("../../resources/provider-accounts.bundle.mjs"));
    let app_rpc = shell_quote(include_str!("../../resources/app-rpc.cjs"));
    let runtime_settings_config = shell_quote(&serde_json::to_string(&runtime_settings(settings)).map_err(|error| error.to_string())?);
    let broker = shell_quote(include_str!("../../resources/session-broker.ts"));
    let ask_user = shell_quote(include_str!("../../resources/ask-user.ts"));
    let trace_reader = shell_quote(include_str!("../../resources/trace-reader.ts"));
    let agent_extension_loader = shell_quote(include_str!("../../../extensions/piop-define-agents/extension-loader.ts"));
    let diagrams_extension = shell_quote(include_str!("../../../extensions/piop-diagrams/index.ts"));
    let mcp_types = shell_quote(include_str!("../../../extensions/piop-define-agents/mcp-config.ts"));
    let defined_agents = shell_quote(include_str!("../../../extensions/piop-define-agents/index.ts"));
    let context_bar = shell_quote(include_str!("../../../extensions/piop-context-bar/index.ts"));
    let context_window_cap = shell_quote(include_str!("../../../extensions/piop-context-window-cap/index.ts"));
    let session_cost_limit = shell_quote(include_str!("../../../extensions/piop-session-cost-limit/index.ts"));
    let codex_web_search = shell_quote(include_str!("../../../extensions/piop-codex-web-search/index.ts"));
    let openai_cache_fork = shell_quote(include_str!("../../../extensions/piop-openai-cache-fork/index.ts"));
    let fast_mode = shell_quote(include_str!("../../resources/fast-mode.bundle.mjs"));
    let diff_watch = shell_quote(include_str!("../../../extensions/piop-diff-watch/index.ts"));
    let context_window_config = shell_quote(&serde_json::to_string_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?);
    let mcp_bridge = shell_quote(include_str!("../../resources/mcp-bridge.bundle.mjs"));
     let migration = [("pi-define-agents", "piop-define-agents"), ("pi-openai-fast-mode-piop", "piop-openai-fast-mode"), ("pi-context-window-cap", "piop-context-window-cap"), ("pi-session-cost-limit", "piop-session-cost-limit"), ("pi-diff-watch", "piop-diff-watch")].iter().map(|(old, new)| format!(r#"if [ -d "$HOME/{STORAGE_DIRECTORY}/{old}" ] && [ ! -e "$HOME/{STORAGE_DIRECTORY}/{new}" ]; then mv "$HOME/{STORAGE_DIRECTORY}/{old}" "$HOME/{STORAGE_DIRECTORY}/{new}"; fi"#)).collect::<Vec<_>>().join(" && ");
    let remote = format!("umask 077 && {migration} && rm -f -- \"$HOME/{STORAGE_DIRECTORY}/piop-btw.ts\" && rm -rf -- \"$HOME/{STORAGE_DIRECTORY}/pi-git-change-context\" && mkdir -p -m 700 \"$HOME/{STORAGE_DIRECTORY}/sessions\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents\" && chmod 700 \"$HOME/{STORAGE_DIRECTORY}\" \"$HOME/{STORAGE_DIRECTORY}/sessions\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents\" && printf %s {broker} > \"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\" && printf %s {trace_reader} > \"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" && printf %s {mcp_bridge} > \"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\" && printf %s {context_window_cap} > \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" && printf %s {context_bar} > \"$HOME/{STORAGE_DIRECTORY}/piop-context-bar.ts\" && printf %s {context_window_config} > \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/config.json\" && printf %s {diff_watch} > \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\" && printf %s {codex_web_search} > \"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" && printf %s {openai_cache_fork} > \"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-fork.ts\" && printf %s {mcp_types} > \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/mcp-config.ts\" && printf %s {defined_agents} > \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\" && chmod 600 -- \"$HOME/{STORAGE_DIRECTORY}/piop-context-bar.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-fork.ts\" \"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/config.json\" \"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\" \"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\"");
    let remote = format!(r#"{remote} && printf %s {agent_extension_loader} > "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/extension-loader.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/extension-loader.ts" && printf %s {diagrams_extension} > "$HOME/{STORAGE_DIRECTORY}/piop-diagrams.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-diagrams.ts""#);
    let remote = format!(r#"{remote} && printf %s {ask_user} > "$HOME/{STORAGE_DIRECTORY}/ask-user.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/ask-user.ts""#);
    let remote = if DEVELOPMENT { remote } else { format!(r#"{remote} && if [ ! -f "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/config.json" ] && [ -f "$HOME/.pi/agent/extensions/pi-define-agents/config.json" ]; then cp "$HOME/.pi/agent/extensions/pi-define-agents/config.json" "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/config.json"; fi && rm -f -- "$HOME/.pi/agent/extensions/pi-define-agents/index.ts" "$HOME/.pi/agent/extensions/pi-desktop-btw.ts""#) };
     let remote = format!(r#"{remote} && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode" && printf %s {fast_mode} > "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts""#);
     let remote = format!(r#"{remote} && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit" && printf %s {session_cost_limit} > "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts""#);
    let remote = format!(r#"{remote} && printf %s {runtime_settings_extension} > "$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts" && printf %s {runtime_settings_config} > "$HOME/{STORAGE_DIRECTORY}/runtime-settings.json" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts" "$HOME/{STORAGE_DIRECTORY}/runtime-settings.json""#);
    let remote = format!(r#"{remote} && printf %s {provider_accounts} > "$HOME/{STORAGE_DIRECTORY}/provider-accounts.mjs" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/provider-accounts.mjs""#);
    let remote = format!(r#"{remote} && printf %s {app_rpc} > "$HOME/{STORAGE_DIRECTORY}/app-rpc.cjs" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/app-rpc.cjs""#);
    let remote = format!(r#"{remote} && printf %s {rtk_extension} > "$HOME/{STORAGE_DIRECTORY}/rtk.ts" && printf %s {rtk_license} > "$HOME/{STORAGE_DIRECTORY}/rtk.LICENSE" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/rtk.ts" "$HOME/{STORAGE_DIRECTORY}/rtk.LICENSE""#);
    let mut remote = remote;
    let mcp_schema = shell_quote(include_str!("../../resources/mcp-schema.bundle.mjs"));
    remote.push_str(&format!(r#" && printf %s {mcp_schema} > "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/mcp-schema.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/mcp-schema.ts""#));
    let agent_state = shell_quote(include_str!("../../../extensions/piop-define-agents/state.ts"));
    remote.push_str(&format!(r#" && printf %s {agent_state} > "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/state.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/state.ts""#));
    let daemon_definitions = shell_quote(include_str!("../../../extensions/piop-define-agents/daemon-definitions.ts"));
    remote.push_str(&format!(r#" && printf %s {daemon_definitions} > "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/daemon-definitions.ts" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-define-agents/daemon-definitions.ts""#));
    for (name, content) in [
        ("git.ts", include_str!("../../../extensions/piop-diff-watch/git.ts")),
        ("schemas.ts", include_str!("../../../extensions/piop-diff-watch/schemas.ts")),
        ("prompt-history.ts", include_str!("../../../extensions/piop-diff-watch/prompt-history.ts")),
    ] {
        remote.push_str(&format!(r#" && printf %s {} > "$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/{name}" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/{name}""#, shell_quote(content)));
    }
    remote.push_str(&format!(r#" && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/session-broker""#));
    for (name, content) in SESSION_BROKER_MODULES {
        remote.push_str(&format!(r#" && printf %s {} > "$HOME/{STORAGE_DIRECTORY}/session-broker/{name}" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/session-broker/{name}""#, shell_quote(content)));
    }
    remote.push_str(&format!(r#" && mkdir -p -m 700 "$HOME/{STORAGE_DIRECTORY}/piop-loop-detection""#));
    for (name, content) in LOOP_DETECTION_ASSETS {
        remote.push_str(&format!(r#" && printf %s {} > "$HOME/{STORAGE_DIRECTORY}/piop-loop-detection/{name}" && chmod 600 "$HOME/{STORAGE_DIRECTORY}/piop-loop-detection/{name}""#, shell_quote(content)));
    }
    for name in LEGACY_FILE_CHANGE_ASSETS {
        remote.push_str(&format!(r#" && rm -f -- "$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/{name}""#));
    }
    stage_extension_script(ssh(host).arg("sh -s"), &host.name, remote)
}

pub(super) fn stage_extension_script(command: &mut Command, host_name: &str, remote: String) -> Result<(), String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("Could not install piop extensions on {host_name}: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Remote extension staging stdin was unavailable")?;
    let writer = thread::spawn(move || stdin.write_all(remote.as_bytes()));
    let output = child.wait_with_output().map_err(|error| format!("Could not install piop extensions on {host_name}: {error}"))?;
    let written = writer.join().map_err(|_| "Remote extension staging writer failed")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    written.map_err(|error| format!("Could not send piop extensions to {host_name}: {error}"))
}

#[derive(Clone, Copy)]
pub(super) enum PiLaunch<'a> {
    Rpc { cwd: Option<&'a str>, session_path: Option<&'a str>, session_id: Option<&'a str>, fork_path: Option<&'a str>, no_session: bool },
    Print { cwd: &'a str, session_path: &'a str },
}

fn session_worker_executable() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    { Ok(PathBuf::from(format!("/proc/{}/exe", std::process::id()))) }
    #[cfg(not(target_os = "linux"))]
    { std::env::current_exe().map_err(|error| error.to_string()) }
}

pub(super) fn build_pi_command(broker: &BrokerRuntime, settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>, daemon_port: Option<u16>) -> Result<Command, String> {
    #[cfg(not(feature = "desktop"))]
    if host_id != "local" { return Err("Remote Pi must be launched by its owning daemon".into()); }
    let (broker_port, broker_token) = broker_environment(broker)?;
    let desktop_home = home_dir()?;
    if host_id == "local" {
        local_pi_command(settings, host_id, launch, broker_port, &broker_token, &desktop_home)
    } else {
        remote_pi_command(settings, host_id, launch, daemon_port, broker_port, &broker_token)
    }
}

fn local_pi_command(settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>, broker_port: u16, broker_token: &str, desktop_home: &Path) -> Result<Command, String> {
    let is_rpc = matches!(launch, PiLaunch::Rpc { .. });
    let default_model = &settings.default_model;
    let pi_path = pi_executable();
        let session_dir = ensure_desktop_sessions_dir(desktop_home)?;
        let mut command = Command::new(session_worker_executable()?); command.args([std::ffi::OsStr::new("--piop-session-worker"), pi_path.as_os_str()]); command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY); command.arg(if is_rpc { "--mode" } else { "--print" }); if is_rpc { command.arg("rpc"); }
        configure_local_extensions(&mut command, settings, host_id, (broker_port, broker_token), &session_dir)?;
        if is_rpc { command.env("PIOP_RPC_ENTRY", generated_extension_root()?.join("app-rpc.cjs")); }
        configure_local_launch(&mut command, launch, &pi_path)?;
        if !is_rpc && !default_model.trim().is_empty() { command.arg("--model").arg(default_model.trim()); }
        if !settings.default_thinking.trim().is_empty() { command.arg("--thinking").arg(settings.default_thinking.trim()); }
        Ok(command)
}

fn remote_pi_command(settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>, daemon_port: Option<u16>, broker_port: u16, broker_token: &str) -> Result<Command, String> {
    let is_rpc = matches!(launch, PiLaunch::Rpc { .. });
    let default_model = &settings.default_model;
    let host = remote_host(settings, host_id)?; stage_remote_extensions(host, settings)?; let remote_port = daemon_port.unwrap_or_else(remote_broker_port); let remote_pi = remote_pi_path(&host.pi_path);
    let mut arguments = if is_rpc { vec!["node".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/app-rpc.cjs\""), remote_pi.clone(), "--mode".into(), "rpc".into()] } else { vec![remote_pi.clone(), "--print".into()] };
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-loop-detection/index.ts\"")]);
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/rtk.ts\"")]);
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/runtime-settings.ts\"")]);
       arguments.extend(["--extension".into(), "builtin:codemode".into(), "--extension".into(), "builtin:tool-search".into(), "--session-dir".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/sessions\""), "--approve".into(), "--no-skills".into(), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-mcp-bridge.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/session-broker.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-context-bar.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-diff-watch/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-openai-cache-fork.ts\""), "--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\"")]);
    arguments.extend(["--extension".into(), format!("\"$HOME/{STORAGE_DIRECTORY}/piop-openai-fast-mode/index.ts\"")]);
    let (session_arguments, cwd) = remote_session_arguments(launch, &mut arguments);
    if !is_rpc && !default_model.trim().is_empty() { arguments.extend(["--model".into(), shell_quote(default_model.trim())]); }
    if !settings.default_thinking.trim().is_empty() { arguments.extend(["--thinking".into(), shell_quote(settings.default_thinking.trim())]); }
    let rpc_environment = format!(" PI_DESKTOP_HOST_ID={}{}", shell_quote(host_id), if is_rpc { format!(" PI_DESKTOP_PI_EXECUTABLE={remote_pi}") } else { String::new() });
     let remote = format!("cd {} && PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} PI_DESKTOP_DEFINED_AGENTS_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-define-agents/index.ts\" PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-codex-web-search.ts\" PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-context-window-cap/index.ts\" PI_DESKTOP_SESSION_COST_LIMIT_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-session-cost-limit/index.ts\" PI_DESKTOP_TRACE_READER_EXTENSION=\"$HOME/{STORAGE_DIRECTORY}/piop-trace-reader.ts\" PI_DESKTOP_BROKER_URL={} PI_DESKTOP_BROKER_TOKEN={}{} exec {}", remote_directory_path(cwd), shell_quote(&format!("http://127.0.0.1:{remote_port}")), shell_quote(broker_token), rpc_environment, arguments.join(" "));
    if daemon_port.is_some() {
        let mut command = Command::new("sh");
        command.env("PIOP_REMOTE_SESSION_CLAIMS", STORAGE_DIRECTORY);
        command.env("PIOP_SESSION_CWD", cwd.unwrap_or("~"));
        let remote = remote.replacen(&format!("cd {} && ", remote_directory_path(cwd)), "cd \"$PIOP_SESSION_CWD\" && ", 1);
        command.args(["-c", &format!("{remote} \"$@\""), "piop"]).args(session_arguments);
        return Ok(command);
    }
    remote_claim_command(settings, host_id, launch, &remote, (broker_port, remote_port))
}

struct LocalPiExtensions { mcp_extension: PathBuf, context_window_cap_extension: PathBuf, context_bar_extension: PathBuf, session_cost_limit_extension: PathBuf, diff_watch_extension: PathBuf, trace_reader_extension: PathBuf, openai_cache_fork_extension: PathBuf, codex_web_search_extension: PathBuf, defined_agents_extension: PathBuf }

fn local_pi_extensions(settings: &AppSettings) -> Result<LocalPiExtensions, String> {
    let mcp_extension = prepare_mcp_bridge()?; let context_window_cap_extension = prepare_context_window_cap_extension(settings)?; let context_bar_extension = prepare_context_bar_extension()?; let session_cost_limit_extension = prepare_session_cost_limit_extension(settings)?; let diff_watch_extension = prepare_diff_watch_extension()?; let trace_reader_extension = prepare_trace_reader()?; let openai_cache_fork_extension = prepare_openai_cache_fork_extension()?; let codex_web_search_extension = prepare_codex_web_search_extension()?; let defined_agents_extension = prepare_defined_agents_extension()?;
    Ok(LocalPiExtensions { mcp_extension, context_window_cap_extension, context_bar_extension, session_cost_limit_extension, diff_watch_extension, trace_reader_extension, openai_cache_fork_extension, codex_web_search_extension, defined_agents_extension })
}

fn configure_local_launch(command: &mut Command, launch: PiLaunch<'_>, pi_path: &Path) -> Result<(), String> {
        match launch {
            PiLaunch::Rpc { cwd, session_path, session_id, fork_path, no_session } => {
                let working_dir = local_launch_directory(cwd)?;
                command.current_dir(working_dir).env("PI_DESKTOP_PI_EXECUTABLE", pi_path);
                if let Some(path) = fork_path { command.arg("--fork").arg(path); } else if let Some(path) = session_path { command.arg("--session").arg(path); } else if let Some(id) = session_id { command.arg("--session-id").arg(id); }
                if no_session { command.arg("--no-session"); }
            }
            PiLaunch::Print { cwd, session_path, .. } => { command.current_dir(cwd).arg("--session").arg(session_path); }
        }
    Ok(())
}

fn remote_session_arguments<'a>(launch: PiLaunch<'a>, arguments: &mut Vec<String>) -> (Vec<String>, Option<&'a str>) {
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
    (session_arguments, cwd)
}

fn configure_local_extensions(command: &mut Command, settings: &AppSettings, host_id: &str, broker: (u16, &str), session_dir: &Path) -> Result<(), String> {
    let (broker_port, broker_token) = broker;
    command.env("PIOP_AGENT_CONFIG_PATH", home_dir()?.join(STORAGE_DIRECTORY).join("piop-define-agents/config.json"))
        .env("PIOP_RUNTIME_SETTINGS_PATH", generated_extension_root()?.join("runtime-settings.json"))
        .env("PIOP_GENERATED_EXTENSION_ROOT", generated_extension_root()?);
    let LocalPiExtensions { mcp_extension, context_window_cap_extension, context_bar_extension, session_cost_limit_extension, diff_watch_extension, trace_reader_extension, openai_cache_fork_extension, codex_web_search_extension, defined_agents_extension } = local_pi_extensions(settings)?;
        command.args(["--extension", "builtin:codemode", "--extension", "builtin:tool-search"]).arg("--extension").arg(prepare_loop_detection_extension()?);
        command.arg("--extension").arg(prepare_rtk_extension()?);
         command.arg("--extension").arg(prepare_runtime_settings(settings)?).arg("--session-dir").arg(session_dir).arg("--approve").arg("--no-skills").arg("--extension").arg(mcp_extension).arg("--extension").arg(prepare_session_broker()?).arg("--extension").arg(&trace_reader_extension).arg("--extension").arg(&context_window_cap_extension).arg("--extension").arg(&context_bar_extension).arg("--extension").arg(&session_cost_limit_extension).arg("--extension").arg(&diff_watch_extension).arg("--extension").arg(prepare_fast_mode_extension()?).arg("--extension").arg(&openai_cache_fork_extension).arg("--extension").arg(&codex_web_search_extension).arg("--extension").arg(&defined_agents_extension)
             .env("PI_DESKTOP_DEFINED_AGENTS_EXTENSION", &defined_agents_extension).env("PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION", &codex_web_search_extension).env("PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION", &context_window_cap_extension).env("PI_DESKTOP_SESSION_COST_LIMIT_EXTENSION", &session_cost_limit_extension).env("PI_DESKTOP_TRACE_READER_EXTENSION", &trace_reader_extension).env("PI_DESKTOP_BROKER_URL", format!("http://127.0.0.1:{broker_port}")).env("PI_DESKTOP_BROKER_TOKEN", broker_token).env("PI_DESKTOP_HOST_ID", host_id);
    Ok(())
}

fn remote_claim_command(settings: &AppSettings, host_id: &str, launch: PiLaunch<'_>, remote: &str, ports: (u16, u16)) -> Result<Command, String> {
    let (broker_port, remote_port) = ports;
    let host = remote_host(settings, host_id)?;
    let session_path = match launch { PiLaunch::Print { session_path, .. } => session_path, _ => return Err("Remote RPC requires a host daemon".into()) };
    let id = Uuid::parse_str(&session_identity(settings, host_id, session_path)?).map_err(|_| "Invalid session identity")?.to_string();
    let lock = format!("\"$HOME/{STORAGE_DIRECTORY}/session-claims/id-{}.lock\"", hash_claim_key(id.as_bytes()));
    let locked = format!("umask 077 && mkdir -p \"$HOME/{STORAGE_DIRECTORY}/session-claims\" && exec flock --nonblock --no-fork {lock} sh -c {}", shell_quote(remote));
    let mut command = remote_broker_command(host, broker_port, remote_port); command.arg(remote_login_command(&locked)); Ok(command)
}

pub(super) fn local_launch_directory(cwd: Option<&str>) -> Result<PathBuf, String> {
    match cwd { Some("~") => home_dir(), Some(path) => Ok(PathBuf::from(path)), None => std::env::current_dir().map_err(|error| error.to_string()) }
}

pub(super) fn cleanup_all_ephemeral(runtime: &PiRuntime) {
    let ephemeral = runtime.ephemeral.sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()).unwrap_or_default();
    for session in ephemeral { remove_ephemeral_session(session); }
    let previous = runtime.ephemeral.previous.lock().map(|mut sessions| sessions.drain().flat_map(|(_, sessions)| sessions).collect::<Vec<_>>()).unwrap_or_default();
    for session in previous { remove_ephemeral_session(session); }
}

#[derive(Clone)]
pub(super) enum EphemeralSession {
    Local(PathBuf),
    Remote { host: RemoteHost, path: String },
}
pub(super) fn update_ephemeral_snapshot(runtime: &PiRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
        let key = runtime.ephemeral.keys.lock().map_err(|_| "Side conversation lock was poisoned")?.get(runtime_id).cloned();
        if let (Some(key), Some(path)) = (key, state["sessionFile"].as_str()) {
            let mut sessions = runtime.ephemeral.sessions.lock().map_err(|_| "Side conversation lock was poisoned")?;
            if let Some(session) = sessions.get_mut(&key) {
                if session.path() != path && Path::new(&session.path()).parent() == Path::new(path).parent() {
                    let previous = session.clone();
                    match session { EphemeralSession::Local(current) => *current = path.into(), EphemeralSession::Remote { path: current, .. } => *current = path.into() }
                    runtime.ephemeral.previous.lock().map_err(|_| "Side conversation lock was poisoned")?.entry(key).or_default().push(previous);
                }
            }
        }
    Ok(())
}


#[derive(Default)]
pub(super) struct EphemeralSessions {
    sessions: Mutex<HashMap<String, EphemeralSession>>,
    previous: Mutex<HashMap<String, Vec<EphemeralSession>>>,
    keys: Mutex<HashMap<String, String>>,
}
impl EphemeralSessions {
    pub(super) fn get(&self, key: &str) -> Result<Option<EphemeralSession>, String> {
        Ok(self.sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.get(key).cloned())
    }
    pub(super) fn attach(&self, runtime_id: &str, key: String) -> Result<(), String> {
        self.keys.lock().map_err(|_| "Side conversation lock was poisoned")?.insert(runtime_id.into(), key);
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn test_sessions(&self) -> &Mutex<HashMap<String, EphemeralSession>> { &self.sessions }
    #[cfg(test)]
    pub(super) fn test_keys(&self) -> &Mutex<HashMap<String, String>> { &self.keys }
}
