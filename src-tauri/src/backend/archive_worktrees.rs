use crate::platform::AppHandle;
use std::sync::atomic::AtomicBool;
use crate::{AppSettings, PiRuntime, STORAGE_DIRECTORY, SessionIndexRuntime, TerminalRuntime, node_command};
use crate::worktree_setup::{LimitedOutput, WorktreeScriptPhase, run_limited, run_worktree_scripts, shell_quote};
use crate::pi_launch::{remote_host, remote_login_command, ssh};
use crate::settings::{load_app_settings};


pub(super) fn archive_conversations(app: &AppHandle, host_id: &str, paths: &[String]) -> Result<(), String> {

    let _invalidate = app.state::<SessionIndexRuntime>().projects.invalidate_after(host_id);
    let settings = load_app_settings(app.clone())?;
    let mut terminals = app.state::<TerminalRuntime>().working_directories(host_id)?;
    let runtime = app.state::<PiRuntime>();
    terminals.extend(runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .filter(|agent| agent.host_id == host_id && !agent.session_path.as_ref().is_some_and(|path| paths.contains(path)))
        .filter_map(|agent| agent.worktree.clone()));
    let mut arguments = serde_json::json!({ "paths": paths, "terminals": terminals, "action": "plan" });
    let inspected = archive_command(&settings, host_id, &arguments)?;
    let plan: serde_json::Value = serde_json::from_slice(&inspected.stdout).map_err(|error| format!("Invalid archive transaction plan: {error}"))?;
    let worktrees: Vec<serde_json::Value> = serde_json::from_value(plan["worktrees"].clone()).map_err(|error| format!("Invalid archive worktree list: {error}"))?;
    arguments["transaction"] = plan["transaction"].as_str().ok_or("Archive transaction identity is missing")?.into();
    cleanup_worktree_scripts(&settings, host_id, worktrees)?;
    arguments["action"] = "execute".into();
    archive_command(&settings, host_id, &arguments)?;
    Ok(())
}

fn cleanup_worktree_scripts(settings: &AppSettings, host_id: &str, worktrees: Vec<serde_json::Value>) -> Result<(), String> {
    for worktree in worktrees {
        let source = worktree["source"].as_str().ok_or("Archive parent checkout is missing")?;
        let target = worktree["path"].as_str().ok_or("Archive worktree path is missing")?;
        run_worktree_scripts(settings, source, target, host_id, &AtomicBool::new(false), WorktreeScriptPhase::Cleanup)?;
    }
    Ok(())
}

fn archive_command(settings: &AppSettings, host_id: &str, arguments: &serde_json::Value) -> Result<LimitedOutput, String> {
    let arguments = arguments.to_string();
    let script = include_str!("../../resources/archive-conversations.bundle.mjs");
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, &arguments]); command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments)))); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not archive conversations and working directories")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(output)
}
