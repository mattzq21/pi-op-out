use crate::platform::AppHandle;
use serde_json::{Value, json};
use std::fs;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use super::{PiRuntime, daemon, peers};
use super::keybindings::{migrate_keybindings, validate_keybindings};
use super::private_fs::atomic_write_private;
use super::settings_storage::settings_path;
use super::settings_types::{AppSettings, MAX_REMOTE_HOSTS, codex_web_search_tool, default_agent, default_settings, session_operation_tools, validate_remote_host};
use super::skill_discovery::merge_discovered_skills;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

fn migrate_question_tool(settings: &mut AppSettings) {
    let has_current = settings.tools.iter().any(|tool| tool["name"] == "request_user_input");
    if has_current { settings.tools.retain(|tool| tool["name"] != "request_user_input_async"); }
    for tool in &mut settings.tools {
        if tool["name"] == "request_user_input_async" { tool["name"] = json!("request_user_input"); }
    }
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn load_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    let mut settings = read_settings_at(&path)?;
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    merge_discovered_skills(&mut settings);
    Ok(settings)
}

pub(super) fn read_settings_at(path: &Path) -> Result<AppSettings, String> {
    let mut settings = if !path.exists() { default_settings() } else { serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? };
    migrate_question_tool(&mut settings);
    if settings.default_agent == "voice-orchestrator" { settings.default_agent = default_agent(); }
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
    Ok(settings)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn save_app_settings(app: AppHandle, mut settings: AppSettings, agent_host_id: Option<String>) -> Result<Value, String> {
    migrate_question_tool(&mut settings);
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    let runtime = app.state::<PiRuntime>();
    let change = save_settings_with(&runtime, settings, agent_host_id,
        || settings_path(&app),
        |settings| daemon::invalidate_changed(&app, &runtime, settings),
        |settings| daemon::update_settings(&app, &runtime, settings))?;
    #[cfg(not(feature = "desktop"))]
    peers::invalidate(&app);
    let _ = app.emit("pi://settings-changed", &change);
    Ok(change)
}

pub(super) fn validate_settings_for_save(settings: &AppSettings) -> Result<(), String> {
    if settings.context_window_cap < 1000 { return Err("Context window cap must be a whole number of at least 1000".into()); }
    validate_keybindings(settings)?;
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

pub(super) fn save_settings_with(
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
