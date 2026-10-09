use serde_json::json;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use crate::{AppSettings, DEVELOPMENT, STORAGE_DIRECTORY, daemon_endpoint};
use crate::pi_launch::{enabled_tool_names};
use crate::environment::home_dir;
use crate::settings_storage::{atomic_write_private, ensure_private_dir};

pub(super) fn generated_extension_root() -> Result<PathBuf, String> {
    if DEVELOPMENT { Ok(daemon_endpoint::directory()?.join("extensions")) } else { Ok(home_dir()?.join(STORAGE_DIRECTORY)) }
}

pub(super) fn prepare_mcp_bridge() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("piop-mcp-bridge.ts");
    atomic_write_private(&extension_path, include_str!("../../resources/mcp-bridge.bundle.mjs").as_bytes())?;
    Ok(extension_path)
}

pub(super) fn runtime_settings(settings: &AppSettings) -> Value {
    json!({ "defaultModel": settings.default_model, "tools": enabled_tool_names(settings), "registeredTools": settings.tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect::<Vec<_>>(), "skills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "explicitOnlySkills": settings.skills.iter().filter(|skill| skill.get("enabled").and_then(Value::as_bool).unwrap_or(false) && skill.get("userInvokedOnly").and_then(Value::as_bool).unwrap_or(false)).filter_map(|skill| skill.get("path").and_then(Value::as_str)).collect::<Vec<_>>(), "contextWindowCap": settings.context_window_cap, "contextWindowCapEnabled": settings.context_window_cap_enabled })
}

pub(super) fn prepare_rtk_extension() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let path = dir.join("rtk.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-rtk/rtk.ts").as_bytes())?;
    Ok(path)
}
pub(super) fn prepare_runtime_settings(settings: &AppSettings) -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let path = dir.join("runtime-settings.ts");
    atomic_write_private(&dir.join("runtime-bridge.cjs"), include_str!("../../resources/runtime-bridge.cjs").as_bytes())?;
    atomic_write_private(&dir.join("runtime-configuration.cjs"), include_str!("../../resources/runtime-configuration.cjs").as_bytes())?;
    atomic_write_private(&dir.join("sdk-storage.mjs"), include_str!("../../resources/sdk-storage.mjs").as_bytes())?;
    atomic_write_private(&dir.join("provider-accounts.mjs"), include_str!("../../resources/provider-accounts.bundle.mjs").as_bytes())?;
    atomic_write_private(&path, include_str!("../../../extensions/piop-runtime-settings/index.ts").as_bytes())?;
    atomic_write_private(&dir.join("runtime-settings.json"), &serde_json::to_vec(&runtime_settings(settings)).map_err(|error| error.to_string())?)?;
    Ok(path)
}

pub(super) const SESSION_BROKER_MODULES: [(&str, &str); 49] = [
    ("review-prompt.txt", include_str!("../../resources/session-broker/review-prompt.txt")),
    ("client.ts", include_str!("../../resources/session-broker/client.ts")),
    ("conversation-location.ts", include_str!("../../resources/session-broker/conversation-location.ts")),
    ("pause.ts", include_str!("../../resources/session-broker/pause.ts")),
    ("fast-mode.ts", include_str!("../../resources/session-broker/fast-mode.ts")),
    ("turn-capture.ts", include_str!("../../resources/session-broker/turn-capture.ts")),
    ("session-file.ts", include_str!("../../resources/session-broker/session-file.ts")),
    ("session-child-index.cjs", include_str!("../../resources/session-broker/session-child-index.cjs")),
    ("session-child-index.d.cts", include_str!("../../resources/session-broker/session-child-index.d.cts")),
    ("checkpoint-owner-index.cjs", include_str!("../../resources/session-broker/checkpoint-owner-index.cjs")),
    ("checkpoint-owner-index.d.cts", include_str!("../../resources/session-broker/checkpoint-owner-index.d.cts")),
    ("session-publication.cjs", include_str!("../../resources/session-broker/session-publication.cjs")),
    ("session-publication-io.cjs", include_str!("../../resources/session-broker/session-publication-io.cjs")),
    ("session-publication-dependencies.cjs", include_str!("../../resources/session-broker/session-publication-dependencies.cjs")),
    ("review-publication.cjs", include_str!("../../resources/session-broker/review-publication.cjs")),
    ("session-publication.d.cts", include_str!("../../resources/session-broker/session-publication.d.cts")),
    ("fork.ts", include_str!("../../resources/session-broker/fork.ts")),
    ("git-diff-store.cjs", include_str!("../../resources/session-broker/git-diff-store.cjs")),
    ("git-diff-migration.cjs", include_str!("../../resources/session-broker/git-diff-migration.cjs")),
    ("git-diff-pages.cjs", include_str!("../../resources/session-broker/git-diff-pages.cjs")),
    ("git-diff-transfer.cjs", include_str!("../../resources/session-broker/git-diff-transfer.cjs")),
    ("subagents.ts", include_str!("../../resources/session-broker/subagents.ts")),
    ("subagent-state.ts", include_str!("../../resources/session-broker/subagent-state.ts")),
    ("subagent-reconciliation.ts", include_str!("../../resources/session-broker/subagent-reconciliation.ts")),
    ("subagent-transcript.ts", include_str!("../../resources/session-broker/subagent-transcript.ts")),
    ("orchestration.ts", include_str!("../../resources/session-broker/orchestration.ts")),
    ("durable-mailbox.ts", include_str!("../../resources/session-broker/durable-mailbox.ts")),
    ("agent-profiles.ts", include_str!("../../resources/session-broker/agent-profiles.ts")),
    ("subagent-usage.ts", include_str!("../../resources/session-broker/subagent-usage.ts")),
    ("subagent-usage-channel.ts", include_str!("../../resources/session-broker/subagent-usage-channel.ts")),
    ("subagent-mailbox.ts", include_str!("../../resources/session-broker/subagent-mailbox.ts")),
    ("subagent-results.ts", include_str!("../../resources/session-broker/subagent-results.ts")),
    ("subagent-recovery.ts", include_str!("../../resources/session-broker/subagent-recovery.ts")),
    ("subagent-identity.ts", include_str!("../../resources/session-broker/subagent-identity.ts")),
    ("operations.ts", include_str!("../../resources/session-broker/operations.ts")),
    ("tools.ts", include_str!("../../resources/session-broker/tools.ts")),
    ("html-preview.ts", include_str!("../../resources/session-broker/html-preview.ts")),
    ("goals.ts", include_str!("../../resources/session-broker/goals.ts")),
    ("review.ts", include_str!("../../resources/session-broker/review.ts")),
    ("goal-state.ts", include_str!("../../resources/session-broker/goal-state.ts")),
    ("goal-legacy-usage.ts", include_str!("../../resources/session-broker/goal-legacy-usage.ts")),
    ("goal-controls.ts", include_str!("../../resources/session-broker/goal-controls.ts")),
    ("goal-coordination.ts", include_str!("../../resources/session-broker/goal-coordination.ts")),
    ("goal-files.ts", include_str!("../../resources/session-broker/goal-files.ts")),
    ("publication-residue.cjs", include_str!("../../resources/session-broker/publication-residue.cjs")),
    ("goal-dependencies.cjs", include_str!("../../resources/session-broker/goal-dependencies.cjs")),
    ("goal-preparations.cjs", include_str!("../../resources/session-broker/goal-preparations.cjs")),
    ("goal-assets.cjs", include_str!("../../resources/session-broker/goal-assets.cjs")),
    ("goal-prompts.ts", include_str!("../../resources/session-broker/goal-prompts.ts")),
];

pub(super) fn prepare_session_broker() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    prepare_broker_storage(&dir)?;
    remove_obsolete_side_chat_extensions(&dir)?;
    let modules = dir.join("session-broker");
    ensure_private_dir(&modules)?;
    for (name, content) in SESSION_BROKER_MODULES { atomic_write_private(&modules.join(name), content.as_bytes())?; }
    let path = dir.join("session-broker.ts");
    atomic_write_private(&path, include_str!("../../resources/session-broker.ts").as_bytes())?;
    Ok(path)
}

fn prepare_broker_storage(dir: &Path) -> Result<(), String> {
    atomic_write_private(&dir.join("session-database.cjs"), include_str!("../../resources/session-database.cjs").as_bytes())?;
    atomic_write_private(&dir.join("sdk-storage.mjs"), include_str!("../../resources/sdk-storage.mjs").as_bytes())?;
    atomic_write_private(&dir.join("session-diff-store.cjs"), include_str!("../../resources/session-diff-store.cjs").as_bytes())?;
    atomic_write_private(&dir.join("ask-user.ts"), include_str!("../../resources/ask-user.ts").as_bytes())
}

fn remove_obsolete_side_chat_extensions(dir: &Path) -> Result<(), String> {
    let mut paths = vec![dir.join("piop-btw.ts")];
    if !DEVELOPMENT { paths.push(home_dir()?.join(".pi/agent/extensions/pi-desktop-btw.ts")); }
    for path in paths {
        match fs::remove_file(path) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub(super) fn prepare_trace_reader() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-trace-reader.ts");
    atomic_write_private(&path, include_str!("../../resources/trace-reader.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_openai_cache_fork_extension() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
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
    let dir = generated_extension_root()?.join("piop-openai-fast-mode");
    ensure_private_dir(&dir)?;
    let path = dir.join("index.ts");
    atomic_write_private(&path, include_str!("../../resources/fast-mode.bundle.mjs").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_codex_web_search_extension() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-codex-web-search.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-codex-web-search/index.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_context_bar_extension() -> Result<PathBuf, String> {
    let dir = generated_extension_root()?;
    ensure_private_dir(&dir)?;
    let path = dir.join("piop-context-bar.ts");
    atomic_write_private(&path, include_str!("../../../extensions/piop-context-bar/index.ts").as_bytes())?;
    Ok(path)
}

pub(super) fn prepare_context_window_cap_extension(settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-context-window-cap", "piop-context-window-cap")?;
    let dir = generated_extension_root()?.join("piop-context-window-cap");
    ensure_private_dir(&dir)?;
    let extension_path = dir.join("index.ts");
    let config_path = dir.join("config.json");
    atomic_write_private(&extension_path, include_str!("../../../extensions/piop-context-window-cap/index.ts").as_bytes())?;
    atomic_write_private(&config_path, &serde_json::to_vec_pretty(&json!({ "contextWindowCap": settings.context_window_cap, "enabled": settings.context_window_cap_enabled })).map_err(|error| error.to_string())?)?;
    Ok(extension_path)
}

pub(super) fn prepare_session_cost_limit_extension(_settings: &AppSettings) -> Result<PathBuf, String> {
    migrate_extension_directory("pi-session-cost-limit", "piop-session-cost-limit")?;
    let dir = generated_extension_root()?.join("piop-session-cost-limit");
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
    let dir = generated_extension_root()?.join("piop-loop-detection");
    ensure_private_dir(&dir)?;
    for (name, content) in LOOP_DETECTION_ASSETS { atomic_write_private(&dir.join(name), content.as_bytes())?; }
    Ok(dir.join("index.ts"))
}

pub(super) const LEGACY_FILE_CHANGE_ASSETS: [&str; 3] = ["file-changes.ts", "sitecustomize.py", "node_fs.cjs"];

fn remove_legacy_diff_assets(dir: &Path) -> Result<(), String> {
    for name in LEGACY_FILE_CHANGE_ASSETS {
        if let Err(error) = fs::remove_file(dir.join(name)) {
            if error.kind() != std::io::ErrorKind::NotFound { return Err(format!("Could not remove legacy diff observer: {error}")); }
        }
    }
    Ok(())
}

fn prepare_diff_storage(dir: &Path) -> Result<(), String> {
    ensure_private_dir(dir)?;
    atomic_write_private(&dir.join("../session-database.cjs"), include_str!("../../resources/session-database.cjs").as_bytes())
}

pub(super) fn prepare_diff_watch_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-diff-watch", "piop-diff-watch")?;
    let config_dir = home_dir()?.join(STORAGE_DIRECTORY);
    let legacy_dir = config_dir.join("pi-git-change-context");
    if legacy_dir.exists() { fs::remove_dir_all(&legacy_dir).map_err(|error| format!("Could not remove legacy diff watch extension: {error}"))?; }
    let dir = generated_extension_root()?.join("piop-diff-watch");
    prepare_diff_storage(&dir)?;
    let extension_path = dir.join("index.ts");
    for (name, content) in [
        ("index.ts", include_str!("../../../extensions/piop-diff-watch/index.ts")),
        ("git.ts", include_str!("../../../extensions/piop-diff-watch/git.ts")),
        ("schemas.ts", include_str!("../../../extensions/piop-diff-watch/schemas.ts")),
        ("prompt-history.ts", include_str!("../../../extensions/piop-diff-watch/prompt-history.ts")),
        ("pin-checkpoints.ts", include_str!("../../../extensions/piop-diff-watch/pin-checkpoints.ts")),
        ("fork-publication.ts", include_str!("../../../extensions/piop-diff-watch/fork-publication.ts")),
        ("fork-preparation.ts", include_str!("../../../extensions/piop-diff-watch/fork-preparation.ts")),
        ("publish-fork.bundle.mjs", include_str!("../../resources/publish-fork.bundle.mjs")),
        ("snapshot-baseline.ts", include_str!("../../../extensions/piop-diff-watch/snapshot-baseline.ts")),
    ] {
        atomic_write_private(&dir.join(name), content.as_bytes())?;
    }
    remove_legacy_diff_assets(&dir)?;
    Ok(extension_path)
}

fn migrate_agent_prompt_paths(config: &mut Value, legacy_dir: &Path) {
    if let Some(agents) = config["agents"].as_array_mut() {
        for agent in agents {
            for key in ["path_systemprompt", "path_agent_prompt", "path_agentprompt"] {
                if let Some(path) = agent[key].as_str().filter(|path| !path.is_empty() && !path.starts_with('~') && !Path::new(path).is_absolute()) {
                    agent[key] = json!(legacy_dir.join(path).to_string_lossy());
                }
            }
        }
    }
}

fn migrate_agent_config(config: &Path, legacy_dir: &Path) -> Result<(), String> {
    let _lock = crate::settings_concurrency::lock_settings(config)?;
    if DEVELOPMENT || config.exists() || !legacy_dir.join("config.json").exists() { return Ok(()); }
    let mut migrated: Value = serde_json::from_slice(&fs::read(legacy_dir.join("config.json")).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    migrate_agent_prompt_paths(&mut migrated, legacy_dir);
    atomic_write_private(config, &serde_json::to_vec_pretty(&migrated).map_err(|error| error.to_string())?)
}

fn prepare_agent_configuration(legacy_dir: &Path) -> Result<(), String> {
    let config_dir = home_dir()?.join(STORAGE_DIRECTORY).join("piop-define-agents");
    ensure_private_dir(&config_dir)?;
    migrate_agent_config(&config_dir.join("config.json"), legacy_dir)
}

pub(super) const EXCALIDRAW_ASSETS: [(&str, &str); 2] = [
    ("SKILL.md", include_str!("../../../extensions/piop-excalidraw/SKILL.md")),
    ("references/cheatsheet.md", include_str!("../../../extensions/piop-excalidraw/references/cheatsheet.md")),
];

fn prepare_agent_directories(dir: &Path) -> Result<(), String> {
    ensure_private_dir(dir)?;
    let excalidraw = home_dir()?.join(STORAGE_DIRECTORY).join("piop-excalidraw");
    ensure_private_dir(&excalidraw)?;
    ensure_private_dir(&excalidraw.join("references"))?;
    for (name, source) in EXCALIDRAW_ASSETS { atomic_write_private(&excalidraw.join(name), source.as_bytes())?; }
    Ok(())
}

pub(super) fn prepare_defined_agents_extension() -> Result<PathBuf, String> {
    migrate_extension_directory("pi-define-agents", "piop-define-agents")?;
    let dir = generated_extension_root()?.join("piop-define-agents");
    prepare_agent_directories(&dir)?;
    let legacy_dir = home_dir()?.join(".pi/agent/extensions/pi-define-agents");
    prepare_agent_configuration(&legacy_dir)?;
    let path = dir.join("index.ts");
    for (name, source) in [
        ("mcp-schema.ts", include_str!("../../resources/mcp-schema.bundle.mjs")),
        ("mcp-config.ts", include_str!("../../../extensions/piop-define-agents/mcp-config.ts")),
        ("extension-loader.ts", include_str!("../../../extensions/piop-define-agents/extension-loader.ts")),
        ("state.ts", include_str!("../../../extensions/piop-define-agents/state.ts")),
        ("daemon-definitions.ts", include_str!("../../../extensions/piop-define-agents/daemon-definitions.ts")),
        ("prompts.ts", include_str!("../../../extensions/piop-define-agents/prompts.ts")),
        ("profiles.ts", include_str!("../../../extensions/piop-define-agents/profiles.ts")),
        ("excalidraw.ts", include_str!("../../../extensions/piop-define-agents/excalidraw.ts")),
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
