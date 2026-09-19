// Shared daemon command allowlist for desktop and mobile clients.
use super::*;

fn argument<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|error| format!("Invalid {key}: {error}"))
}

pub(super) async fn dispatch(app: AppHandle, owner: String, command: String, args: Value) -> Result<Value, String> {
    if let Some(id) = args.get("runtimeId").and_then(Value::as_str) {
        if app.state::<PiRuntime>().processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(id).is_some_and(|process| process.window_label != owner) { return Err("Runtime belongs to another connection".into()); }
    }
    if let Some(id) = args.get("terminalId").and_then(Value::as_str) {
        if app.state::<TerminalRuntime>().processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.get(id).is_some_and(|process| process.window_label != owner) { return Err("Terminal belongs to another connection".into()); }
    }
    match command.as_str() {
        "provider_auth" => tokio::task::spawn_blocking(move || provider_auth::for_owner(app, owner, argument(&args, "hostId")?, argument(&args, "request")?)).await.map_err(|error| error.to_string())?,
        "open_project_directory" => tokio::task::spawn_blocking(move || open_project_directory(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?).map(|_| Value::Null)).await.map_err(|error| error.to_string())?,
        "voice_configuration" => voice_configuration(app, argument(&args, "runtimeId")?).await,
        "mobile_voice_start" => voice::host_request(app, argument(&args, "runtimeId")?, "start".into(), argument(&args, "callId")?, argument(&args, "offer")?).await,
        "voice_stop" => voice_stop(app, argument(&args, "runtimeId")?, argument(&args, "callId")?).await.map(|_| Value::Null),
        "voice_mute" => voice_mute(app, argument(&args, "callId")?, argument(&args, "muted")?).map(|_| Value::Null),
        "voice_suppress" => voice_suppress(app, argument(&args, "callId")?, argument(&args, "suppressed")?).map(|_| Value::Null),
        "start_pi" => tokio::task::spawn_blocking(move || serde_json::to_value(start_pi_for_owner(app.clone(), owner, app.state(), app.state(), argument(&args, "runtimeId")?, argument(&args, "cwd")?, argument(&args, "sessionPath")?, argument(&args, "sessionId")?, argument(&args, "forkPath")?, argument(&args, "noSession")?, argument(&args, "hostId")?, argument(&args, "presence")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "stop_pi" => tokio::task::spawn_blocking(move || serde_json::to_value(stop_pi(app.state(), argument(&args, "runtimeId")?, argument(&args, "discardBlank")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "pi_command" => tokio::task::spawn_blocking(move || serde_json::to_value(pi_command(app.clone(), app.state(), app.state(), argument(&args, "runtimeId")?, argument(&args, "command")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "pi_presence" => tokio::task::spawn_blocking(move || serde_json::to_value(pi_presence(app.state(), argument(&args, "runtimeId")?, argument(&args, "presence")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "start_terminal" => tokio::task::spawn_blocking(move || serde_json::to_value(start_terminal_for_owner(app.clone(), owner, app.state(), argument(&args, "terminalId")?, argument(&args, "sessionKey")?, argument(&args, "cwd")?, argument(&args, "cols")?, argument(&args, "rows")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "write_terminal" => tokio::task::spawn_blocking(move || serde_json::to_value(write_terminal(app.state(), argument(&args, "terminalId")?, argument(&args, "data")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "resize_terminal" => tokio::task::spawn_blocking(move || serde_json::to_value(resize_terminal(app.state(), argument(&args, "terminalId")?, argument(&args, "cols")?, argument(&args, "rows")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "close_terminal" => tokio::task::spawn_blocking(move || serde_json::to_value(close_terminal(app.state(), argument(&args, "terminalId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "list_sessions" => tokio::task::spawn_blocking(move || serde_json::to_value(list_sessions(app.clone(), app.state())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "storage_report" => tokio::task::spawn_blocking(move || serde_json::to_value(storage_report(app.clone())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "load_session_groups" => tokio::task::spawn_blocking(move || serde_json::to_value(load_session_groups(argument(&args, "seeds")?, argument(&args, "legacy")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "change_session_groups" => tokio::task::spawn_blocking(move || serde_json::to_value(change_session_groups(app.clone(), argument(&args, "change")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "list_hooks" => tokio::task::spawn_blocking(move || serde_json::to_value(list_hooks(app.clone(), argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "home_directory" => tokio::task::spawn_blocking(move || serde_json::to_value(home_directory(app.clone(), argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "create_temporary_chat" => tokio::task::spawn_blocking(move || serde_json::to_value(create_temporary_chat(app.clone(), argument(&args, "hostId")?, argument(&args, "e2e")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "remove_temporary_chat" => tokio::task::spawn_blocking(move || serde_json::to_value(remove_temporary_chat(app.clone(), argument(&args, "path")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "validate_project_directory" => tokio::task::spawn_blocking(move || serde_json::to_value(validate_project_directory(app.clone(), argument(&args, "path")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "list_directories" => tokio::task::spawn_blocking(move || serde_json::to_value(list_directories(app.clone(), argument(&args, "hostId")?, argument(&args, "path")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "is_git_repository" => tokio::task::spawn_blocking(move || serde_json::to_value(is_git_repository(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "git_branch" => tokio::task::spawn_blocking(move || serde_json::to_value(git_branch(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "git_project_kind" => tokio::task::spawn_blocking(move || serde_json::to_value(git_project_kind(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "git_worktree_roots" => serde_json::to_value(git_worktree_roots(app.clone(), argument(&args, "paths")?, argument(&args, "hostId")?).await?).map_err(|error| error.to_string()),
        "create_project_worktree" => tokio::task::spawn_blocking(move || serde_json::to_value(create_project_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "name")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "create_git_worktree" => tokio::task::spawn_blocking(move || serde_json::to_value(create_git_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "name")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "remove_git_worktree" => serde_json::to_value(remove_git_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?, argument(&args, "deleteBranch")?).await?).map_err(|error| error.to_string()),
        "prepare_worktree_setup" => tokio::task::spawn_blocking(move || serde_json::to_value(prepare_worktree_setup(app.state())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "cancel_worktree_setup" => tokio::task::spawn_blocking(move || serde_json::to_value(cancel_worktree_setup(app.state(), argument(&args, "setupId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "run_worktree_setup" => serde_json::to_value(run_worktree_setup(app.clone(), argument(&args, "setupId")?, argument(&args, "cwd")?, argument(&args, "worktreePath")?, argument(&args, "hostId")?).await?).map_err(|error| error.to_string()),
        "capture_git_tree" => tokio::task::spawn_blocking(move || serde_json::to_value(capture_git_tree(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "discard_git_tree" => tokio::task::spawn_blocking(move || serde_json::to_value(discard_git_tree(app.clone(), argument(&args, "snapshot")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "load_git_diff" => tokio::task::spawn_blocking(move || serde_json::to_value(load_git_diff(app.clone(), argument(&args, "cwd")?, argument(&args, "baseTree")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "load_git_diffs" => tokio::task::spawn_blocking(move || serde_json::to_value(load_git_diffs(app.clone(), argument(&args, "sessionPath")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "save_git_diffs" => tokio::task::spawn_blocking(move || serde_json::to_value(save_git_diffs(app.clone(), argument(&args, "sessionPath")?, argument(&args, "snapshots")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "archive_session" => tokio::task::spawn_blocking(move || serde_json::to_value(archive_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "terminalIds")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "delete_session" => tokio::task::spawn_blocking(move || serde_json::to_value(delete_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "delete_archived_session" => tokio::task::spawn_blocking(move || serde_json::to_value(delete_archived_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "relocate_session" => tokio::task::spawn_blocking(move || serde_json::to_value(relocate_session(app.clone(), argument(&args, "sessionPath")?, argument(&args, "cwd")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "load_app_settings" => tokio::task::spawn_blocking(move || serde_json::to_value(load_app_settings(app.clone())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "save_app_settings" => tokio::task::spawn_blocking(move || serde_json::to_value(save_app_settings(app.clone(), argument(&args, "settings")?, argument(&args, "agentHostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "codex_usage" => tokio::task::spawn_blocking(move || serde_json::to_value(codex_usage()?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?,
        "opencode_go_usage" => opencode_go_usage().await.and_then(|usage| serde_json::to_value(usage).map_err(|error| error.to_string())),
        _ => Err(format!("Command is not available on the daemon: {command}")),
    }
}
