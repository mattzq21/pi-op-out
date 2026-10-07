use super::*;

fn argument<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|error| format!("Invalid {key}: {error}"))
}

pub(super) async fn dispatch(app: AppHandle, owner: String, command: String, args: Value) -> Result<Value, String> {
    let routing_app = app.clone(); let routing_owner = owner.clone(); let routing_command = command.clone(); let routing_args = args.clone();
    {
        let state = app.state::<crate::daemon_restart::Runtime>();
        let _guard = state.gate.read().await;
        if crate::daemon_restart::blocking() && command != "daemon_restart_status" { return Err("The daemon is restarting. Reconnect before retrying.".into()); }
        if let Some(result) = tokio::task::spawn_blocking(move || peers::route(&routing_app, &routing_owner, &routing_command, &routing_args)).await.map_err(|error| error.to_string())?? { return Ok(result); }
    }
    dispatch_local(app, owner, command, args).await
}

pub(super) async fn dispatch_peer(app: AppHandle, owner: String, command: String, args: Value) -> Result<Value, String> {
    if args["hostId"].as_str().is_some_and(|id| id != "local") { return Err("Peer connections expose only this daemon's local machine".into()); }
    if matches!(command.as_str(), "save_app_settings" | "change_session_groups" | "load_session_groups") { return Err("Configure this machine through its own Piop settings".into()); }
    if command == "list_sessions" {
        return tokio::task::spawn_blocking(move || peers::local_sessions(&app)).await.map_err(|error| error.to_string())?;
    }
    if command == "storage_report" {
        return tokio::task::spawn_blocking(move || serde_json::to_value(StorageReport { hosts: vec![inspect_storage(None)?] }).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?;
    }
    dispatch_local(app, owner, command, args).await
}

async fn dispatch_local(app: AppHandle, owner: String, command: String, args: Value) -> Result<Value, String> {
    if command == "daemon_restart_status" { return crate::daemon_restart::status(&argument::<String>(&args, "restartId")?); }
    let state = app.state::<crate::daemon_restart::Runtime>();
    if command == "restart_daemon" {
        let _guard = tokio::time::timeout(std::time::Duration::from_secs(30), state.gate.write()).await
            .map_err(|_| "Pending daemon requests did not finish within 30 seconds. Try restarting again once they finish.")?;
        return handle_restart_daemon(app.clone(), owner, args).await;
    }
    if command == "plugin_call" {
        if crate::daemon_restart::blocking() { return Err("The daemon is restarting. Reconnect before retrying.".into()); }
        return dispatch_command(app.clone(), owner, command, args).await;
    }
    let _guard = if command == "check_daemon_idle" {
        state.gate.try_read().map_err(|_| "The remote daemon is preparing a restart")?
    } else { state.gate.read().await };
    if crate::daemon_restart::blocking() { return Err("The daemon is restarting. Reconnect before retrying.".into()); }
    dispatch_command(app.clone(), owner, command, args).await
}

async fn dispatch_command(app: AppHandle, owner: String, command: String, args: Value) -> Result<Value, String> {
    if let Some(id) = args.get("runtimeId").and_then(Value::as_str) {
        crate::pi_runtime::ensure_runtime_owner(&app.state::<PiRuntime>(), id, &owner)?;
    }
    if let Some(id) = args.get("terminalId").and_then(Value::as_str) {
        app.state::<TerminalRuntime>().ensure_owner(id, &owner)?;
    }
    let handler = COMMANDS.iter().find(|(name, _)| *name == command).map(|(_, handler)| handler)
        .ok_or_else(|| format!("Command is not available on the daemon: {command}"))?;
    handler(app, owner, args).await
}

type CommandFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;
type CommandHandler = fn(AppHandle, String, Value) -> CommandFuture;
const COMMANDS: &[(&str, CommandHandler)] = &[
    ("check_daemon_idle", handle_check_daemon_idle),
    ("plugin_call", handle_plugin_call),
    ("plugin_status", handle_plugin_status),
    ("shared_terminal", handle_shared_terminal),
    ("reassign_terminal", handle_reassign_terminal),
    ("dictation_configuration", handle_dictation_configuration),
    ("dictation_transcribe", handle_dictation_transcribe),
    ("broker_request", handle_broker_request),
    ("load_host_settings", handle_load_host_settings),
    ("save_host_settings", handle_save_host_settings),
    ("host_storage_report", handle_host_storage_report),
    ("provider_auth", handle_provider_auth),
    ("open_project_directory", handle_open_project_directory),
    ("start_pi", handle_start_pi),
    ("stop_pi", handle_stop_pi),
    ("pi_command", handle_pi_command),
    ("pi_presence", handle_pi_presence),
    ("start_terminal", handle_start_terminal),
    ("write_terminal", handle_write_terminal),
    ("resize_terminal", handle_resize_terminal),
    ("close_terminal", handle_close_terminal),
    ("list_sessions", handle_list_sessions),
    ("storage_report", handle_storage_report),
    ("load_session_groups", handle_load_session_groups),
    ("change_session_groups", handle_change_session_groups),
    ("home_directory", handle_home_directory),
    ("create_temporary_chat", handle_create_temporary_chat),
    ("remove_temporary_chat", handle_remove_temporary_chat),
    ("validate_project_directory", handle_validate_project_directory),
    ("list_directories", handle_list_directories),
    ("list_project_files", handle_list_project_files),
    ("read_project_file", handle_read_project_file),
    ("read_image_file", handle_read_image_file),
    ("save_project_file", handle_save_project_file),
    ("is_git_repository", handle_is_git_repository),
    ("git_branch", handle_git_branch),
    ("git_project_kind", handle_git_project_kind),
    ("project_branches", handle_project_branches),
    ("git_worktree_roots", handle_git_worktree_roots),
    ("create_project_worktree", handle_create_project_worktree),
    ("create_git_worktree", handle_create_git_worktree),
    ("remove_git_worktree", handle_remove_git_worktree),
    ("prepare_worktree_setup", handle_prepare_worktree_setup),
    ("cancel_worktree_setup", handle_cancel_worktree_setup),
    ("run_worktree_setup", handle_run_worktree_setup),
    ("capture_git_tree", handle_capture_git_tree),
    ("discard_git_tree", handle_discard_git_tree),
    ("load_git_diff", handle_load_git_diff),
    ("load_git_diffs", handle_load_git_diffs),
    ("save_git_diffs", handle_save_git_diffs),
    ("archive_session", handle_archive_session),
    ("delete_session", handle_delete_session),
    ("delete_archived_session", handle_delete_archived_session),
    ("restore_archived_worktree", handle_restore_archived_worktree),
    ("restore_archived_session", handle_restore_archived_session),
    ("relocate_session", handle_relocate_session),
    ("recover_missing_session", handle_recover_missing_session),
    ("load_app_settings", handle_load_app_settings),
    ("save_app_settings", handle_save_app_settings),
    ("codex_usage", handle_codex_usage),
    ("opencode_go_usage", handle_opencode_go_usage),
];

fn handle_check_daemon_idle(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || crate::daemon_restart::ensure_local_idle(&app).map(|()| Value::Null)).await.map_err(|error| error.to_string())?
    })
}

fn handle_dictation_configuration(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        Ok(dictation::configuration(&app))
    })
}

fn handle_dictation_transcribe(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        dictation::dictate(app, argument(&args, "audio")?).await
    })
}

fn handle_broker_request(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || peers::local_broker_request(&app, &argument::<String>(&args, "path")?, &argument::<Value>(&args, "body")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_load_host_settings(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(load_app_settings(app)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_save_host_settings(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            let mut settings: AppSettings = argument(&args, "settings")?;
            let previous = load_app_settings(app.clone())?;
            settings.keybindings = previous.keybindings;
            settings.hidden_models = previous.hidden_models;
            settings.known_models = previous.known_models;
            settings.debug_mode = previous.debug_mode;
            let agents_changed: bool = argument(&args, "agentsChanged")?;
            save_app_settings(app, settings, agents_changed.then(|| "local".into()))
        }).await.map_err(|error| error.to_string())?
    })
}

fn handle_host_storage_report(_app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(StorageReport { hosts: vec![inspect_storage(None)?] }).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_plugin_call(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || plugins::dispatch(app, "plugin_call", args)).await.map_err(|error| error.to_string())?
    })
}

fn handle_plugin_status(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || plugins::dispatch(app, "plugin_status", args)).await.map_err(|error| error.to_string())?
    })
}

fn handle_restart_daemon(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || crate::daemon_restart::prepare(app, args)).await.map_err(|error| error.to_string())?
    })
}

fn handle_provider_auth(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || provider_auth::for_owner(app, owner, argument(&args, "hostId")?, argument(&args, "request")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_open_project_directory(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || open_project_directory(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?).map(|_| Value::Null)).await.map_err(|error| error.to_string())?
    })
}

fn handle_start_pi(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || (|| { let mut result = start_pi_for_owner(app.clone(), owner, app.state(), app.state(), start_pi_options(&args)?)?; result["daemonId"] = json!(daemon_endpoint::identity()?); Ok(result) })()).await.map_err(|error| error.to_string())?
    })
}

fn handle_stop_pi(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            let id = argument::<String>(&args, "runtimeId")?;
            let result = if args["preserveRunning"].as_bool().unwrap_or(false) { detach_pi_with(&app.state(), &id, false, true) }
                else { stop_pi(app.state(), id, argument(&args, "discardBlank")?) }?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }).await.map_err(|error| error.to_string())?
    })
}

fn handle_pi_command(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(pi_command(app.clone(), app.state(), app.state(), argument(&args, "runtimeId")?, argument(&args, "command")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_pi_presence(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(pi_presence(app.state(), argument(&args, "runtimeId")?, argument(&args, "presence")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_start_terminal(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(start_terminal_for_owner(app.clone(), owner, app.state(), start_terminal_options(&args)?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_shared_terminal(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || terminal_lookup::shared(&app, &owner, &args)).await.map_err(|error| error.to_string())?
    })
}

fn handle_write_terminal(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(write_terminal(app.state(), argument(&args, "terminalId")?, argument(&args, "data")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_resize_terminal(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(resize_terminal(app.state(), argument(&args, "terminalId")?, argument(&args, "cols")?, argument(&args, "rows")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_close_terminal(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(close_terminal(app.state(), argument(&args, "terminalId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_list_sessions(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(list_sessions(app.clone(), app.state())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_storage_report(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(storage_report(app.clone())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_load_session_groups(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(load_session_groups(app, argument(&args, "seeds")?, argument(&args, "legacy")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_change_session_groups(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(change_session_groups(app.clone(), argument(&args, "change")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_home_directory(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(home_directory(app.clone(), argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_create_temporary_chat(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(create_temporary_chat(app.clone(), argument(&args, "hostId")?, argument(&args, "e2e")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_remove_temporary_chat(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(remove_temporary_chat(app.clone(), argument(&args, "path")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_validate_project_directory(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(validate_project_directory(app.clone(), argument(&args, "path")?, argument(&args, "hostId")?, argument(&args, "allowStorage")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_list_directories(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(list_directories(app.clone(), argument(&args, "hostId")?, argument(&args, "path")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_list_project_files(_app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || project_files::list(&argument::<String>(&args, "cwd")?, &argument::<String>(&args, "path")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_read_project_file(_app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || project_files::read(&argument::<String>(&args, "cwd")?, &argument::<String>(&args, "path")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_read_image_file(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || project_files::read_image(app, &argument::<String>(&args, "cwd")?, &argument::<String>(&args, "path")?, &argument::<String>(&args, "hostId")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_save_project_file(_app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || project_files::save(&argument::<String>(&args, "cwd")?, &argument::<String>(&args, "path")?, &argument::<String>(&args, "content")?, &argument::<String>(&args, "revision")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_is_git_repository(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(is_git_repository(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_git_branch(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(git_branch(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_git_project_kind(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(git_project_kind(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_project_branches(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || project_branches(app, argument(&args, "cwd")?, argument(&args, "hostId")?, argument(&args, "branch")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_git_worktree_roots(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        serde_json::to_value(git_worktree_roots(app.clone(), argument(&args, "paths")?, argument(&args, "hostId")?).await?).map_err(|error| error.to_string())
    })
}

fn handle_create_project_worktree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(create_project_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "name")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_create_git_worktree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(create_git_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "name")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_remove_git_worktree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        serde_json::to_value(remove_git_worktree(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?, argument(&args, "deleteBranch")?).await?).map_err(|error| error.to_string())
    })
}

fn handle_prepare_worktree_setup(app: AppHandle, owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || {
            let runtime = app.state::<PiRuntime>();
            Ok(json!(crate::worktree_setup::prepare_for_owner(&runtime, owner)?))
        }).await.map_err(|error| error.to_string())?
    })
}

fn handle_cancel_worktree_setup(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        verify_setup_owner(&app.state::<PiRuntime>(), &argument::<String>(&args, "setupId")?, &owner)?;
        tokio::task::spawn_blocking(move || serde_json::to_value(cancel_worktree_setup(app.state(), argument(&args, "setupId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_run_worktree_setup(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        verify_setup_owner(&app.state::<PiRuntime>(), &argument::<String>(&args, "setupId")?, &owner)?;
        serde_json::to_value(run_worktree_setup(app.clone(), argument(&args, "setupId")?, argument(&args, "cwd")?, argument(&args, "worktreePath")?, argument(&args, "hostId")?).await?).map_err(|error| error.to_string())
    })
}

fn handle_capture_git_tree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(capture_git_tree(app.clone(), argument(&args, "cwd")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_discard_git_tree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(discard_git_tree(app.clone(), argument(&args, "snapshot")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_load_git_diff(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(load_git_diff(app.clone(), argument(&args, "cwd")?, argument(&args, "baseTree")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_load_git_diffs(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(load_git_diffs(app.clone(), argument(&args, "sessionPath")?, argument(&args, "hostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_save_git_diffs(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(save_git_diffs(app.clone(), argument(&args, "sessionPath")?, argument(&args, "snapshots")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_archive_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(archive_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "terminalIds")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_delete_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(delete_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_delete_archived_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(delete_archived_session(app.clone(), app.state(), argument(&args, "sessionPath")?, argument(&args, "sessionPaths")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_restore_archived_worktree(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || restore_archived_worktree(app.clone(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "clientId")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_restore_archived_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(restore_archived_session(app.clone(), argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_recover_missing_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || archives::recover_missing_session(app, argument(&args, "sessionPath")?, argument(&args, "hostId")?, argument(&args, "action")?, argument(&args, "repository")?, argument(&args, "branch")?, argument(&args, "clientId")?)).await.map_err(|error| error.to_string())?
    })
}

fn handle_relocate_session(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(relocate_session(app.clone(), argument(&args, "sessionPath")?, argument(&args, "cwd")?, argument(&args, "hostId")?, argument(&args, "clientId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_load_app_settings(app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(load_app_settings(app.clone())?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_save_app_settings(app: AppHandle, _owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(save_app_settings(app.clone(), argument(&args, "settings")?, argument(&args, "agentHostId")?)?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_codex_usage(_app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || serde_json::to_value(codex_usage()?).map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
    })
}

fn handle_opencode_go_usage(_app: AppHandle, _owner: String, _args: Value) -> CommandFuture {
    Box::pin(async move {
        opencode_go_usage().await.and_then(|usage| serde_json::to_value(usage).map_err(|error| error.to_string()))
    })
}

fn start_pi_options(args: &Value) -> Result<StartPiOptions, String> {
    serde_json::from_value(args.clone()).map_err(|error| error.to_string())
}

fn start_terminal_options(args: &Value) -> Result<StartTerminalOptions, String> {
    Ok(StartTerminalOptions {
        terminal_id: argument(args, "terminalId")?,
        session_key: argument(args, "sessionKey")?,
        cwd: argument(args, "cwd")?,
        cols: argument(args, "cols")?,
        rows: argument(args, "rows")?,
        host_id: argument(args, "hostId")?
    })
}

fn handle_reassign_terminal(app: AppHandle, owner: String, args: Value) -> CommandFuture {
    Box::pin(async move {
        terminal_lookup::reassign(&app.state::<TerminalRuntime>(), &owner, &argument::<String>(&args, "terminalId")?, &argument::<String>(&args, "sessionKey")?).map(|_| Value::Null)
    })
}
