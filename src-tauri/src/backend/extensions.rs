use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use super::{DEVELOPMENT, STORAGE_DIRECTORY};
use super::environment::home_dir;
use super::pi_launch::enabled_tool_names;
use super::private_fs::{atomic_write_private, ensure_private_dir};
use super::settings_types::AppSettings;

pub(super) fn prepare_mcp_bridge() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("piop-mcp-bridge.ts");
    atomic_write_private(&extension_path, include_str!("../../resources/mcp-bridge.bundle.mjs").as_bytes())?;
    Ok(extension_path)
}

pub(super) fn runtime_settings(settings: &AppSettings) -> Value {
    json!({ "tools": enabled_tool_names(settings), "skills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "explicitOnlySkills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false) && skill.get("userInvokedOnly").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "contextWindowCap": settings.context_window_cap, "contextWindowCapEnabled": settings.context_window_cap_enabled })
}

pub(super) fn prepare_rtk_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("rtk.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-rtk/rtk.ts").as_bytes())?;
    atomic_write_private(&dir.join("rtk.LICENSE"), include_str!("../../../extensions/piop-rtk/LICENSE").as_bytes())?;
    Ok(path)
}
pub(super) fn prepare_runtime_settings(settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("runtime-settings.ts");
    atomic_write_private(&dir.join("provider-accounts.mjs"), include_str!("../../../extensions/piop-runtime-settings/provider-accounts.mjs").as_bytes())?;
    atomic_write_private(&path, include_str!("../../../extensions/piop-runtime-settings/index.ts").as_bytes())?;
    atomic_write_private(&dir.join("runtime-settings.json"), &serde_json::to_vec(&runtime_settings(settings)).map_err(|error| error.to_string())?)?;
    Ok(path)
}

pub(super) fn prepare_session_broker() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("session-broker.ts");
    atomic_write_private(&dir.join("ask-user.ts"), include_str!("../../resources/ask-user.ts").as_bytes())?;
    atomic_write_private(&path, include_str!("../../resources/session-broker.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_trace_reader() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-trace-reader.ts");
    atomic_write_private(&path, include_str!("../../resources/trace-reader.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_openai_cache_fork_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-openai-cache-fork.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-openai-cache-fork/index.ts").as_bytes())?;
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

pub(super) fn prepare_fast_mode_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-openai-fast-mode-piop", "piop-openai-fast-mode")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-openai-fast-mode");
    ensure_private_dir(&dir)?;
    let path = dir.join("index.ts");
    atomic_write_private(&path, include_str!("../../resources/fast-mode.bundle.mjs").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_codex_web_search_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-codex-web-search.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-codex-web-search/index.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_context_window_cap_extension(settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-context-window-cap", "piop-context-window-cap")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-context-window-cap");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    let config_path = dir.join("config.json");
    atomic_write_private(&extension_path, include_str!("../../../extensions/piop-context-window-cap/index.ts").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?)?;
    Ok(extension_path)
}

pub(super) fn prepare_session_cost_limit_extension(_settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-session-cost-limit", "piop-session-cost-limit")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-session-cost-limit");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    atomic_write_private(&extension_path, include_str!("../../../extensions/piop-session-cost-limit/index.ts").as_bytes())?;
    Ok(extension_path)
}

pub(super) const LOOP_DETECTION_ASSETS: [(&str, &str); 4] = [
    ("index.ts", include_str!("../../../extensions/piop-loop-detection/index.ts")),
    ("detector.ts", include_str!("../../../extensions/piop-loop-detection/detector.ts")),
    ("observations.ts", include_str!("../../../extensions/piop-loop-detection/observations.ts")),
    ("persistence.ts", include_str!("../../../extensions/piop-loop-detection/persistence.ts")),
];

pub(super) fn prepare_loop_detection_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-loop-detection");
    ensure_private_dir(&dir)?;
    for (name, content) in LOOP_DETECTION_ASSETS { atomic_write_private(&dir.join(name), content.as_bytes())?; }
    Ok(dir.join("index.ts"))
}

pub(super) const LEGACY_FILE_CHANGE_ASSETS: [&str; 3] = ["file-changes.ts", "sitecustomize.py", "node_fs.cjs"];

pub(super) fn prepare_diff_watch_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-diff-watch", "piop-diff-watch")?;
    let config_dir = home_dir()?.join(STORAGE_DIRECTORY);
    let legacy_dir = config_dir.join("pi-git-change-context");
    if legacy_dir.exists() { fs::remove_dir_all(&legacy_dir).map_err(|error| format!("Could not remove legacy diff watch extension: {error}"))?; }
    let dir = config_dir.join("piop-diff-watch");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    atomic_write_private(&extension_path, include_str!("../../../extensions/piop-diff-watch/index.ts").as_bytes())?;
    for name in LEGACY_FILE_CHANGE_ASSETS {
        if let Err(error) = fs::remove_file(dir.join(name)) {
            if error.kind() != std::io::ErrorKind::NotFound { return Err(format!("Could not remove legacy diff observer: {error}")); }
        }
    }
    Ok(extension_path)
}

fn migrate_agent_prompt_paths(config: &mut Value, legacy_dir: &Path) {
    if let Some(agents) = config["agents"].as_array_mut() {
        for agent in agents {
            for key in ["path_systemprompt", "path_agentprompt"] {
                if let Some(path) = agent[key].as_str().filter(|path| !path.is_empty() && !path.starts_with('~') && !Path::new(path).is_absolute()) {
                    agent[key] = json!(legacy_dir.join(path).to_string_lossy());
                }
            }
        }
    }
}

fn migrate_agent_config(config: &Path, legacy_dir: &Path) -> Result<(), String> {
    if DEVELOPMENT || config.exists() || !legacy_dir.join("config.json").exists() { return Ok(()); }
    let mut migrated: Value = serde_json::from_slice(&fs::read(legacy_dir.join("config.json")).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    migrate_agent_prompt_paths(&mut migrated, legacy_dir);
    atomic_write_private(config, &serde_json::to_vec_pretty(&migrated).map_err(|error| error.to_string())?)
}

pub(super) fn prepare_defined_agents_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-define-agents", "piop-define-agents")?;
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-define-agents");
    ensure_private_dir(&dir)?;
    let legacy_dir = home_dir()?.join(".pi/agent/extensions/pi-define-agents");
    migrate_agent_config(&dir.join("config.json"), &legacy_dir)?;
    let path = dir.join("index.ts");
    for (name, source) in [
        ("mcp-config.ts", include_str!("../../../extensions/piop-define-agents/mcp-config.ts")),
        ("extension-loader.ts", include_str!("../../../extensions/piop-define-agents/extension-loader.ts")),
        ("../piop-diagrams.ts", include_str!("../../../extensions/piop-diagrams/index.ts")),
        ("index.ts", include_str!("../../../extensions/piop-define-agents/index.ts")),
    ] { atomic_write_private(&dir.join(name), source.as_bytes())?; }
    remove_legacy_agent_extension(&legacy_dir)?;
    Ok(path)
}

fn remove_legacy_agent_extension(legacy_dir: &Path) -> Result<(), String> {
    if !DEVELOPMENT && legacy_dir.join("index.ts").exists() { fs::remove_file(legacy_dir.join("index.ts")).map_err(|error| error.to_string())?; }
    Ok(())
}

pub(super) fn prepare_btw_extension() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-btw.ts");
    atomic_write_private(&path, include_str!("../../resources/btw.ts").as_bytes())?;
    let legacy = home_dir()?.join(".pi/agent/extensions/pi-desktop-btw.ts");
    if !DEVELOPMENT && legacy.exists() { fs::remove_file(legacy).map_err(|error| error.to_string())?; }
    Ok(path)
}
