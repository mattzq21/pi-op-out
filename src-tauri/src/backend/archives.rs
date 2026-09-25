fn inspect_storage(host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    let script = include_str!("../../resources/storage-inventory.cjs");
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

#[cfg_attr(feature = "desktop", tauri::command(async))]
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
    hosts[1..].sort_by_key(|left| left.host_name.to_lowercase());
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

fn retire_archived_session(app: &AppHandle, client: &PiRuntime, host_id: &str, session_path: &str) -> Result<(), String> {
    let daemon = client.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?.get(host_id).cloned();
    if let Some(daemon) = daemon {
        let settings = load_app_settings(app.clone())?;
        let path = desktop_session_file(&settings, host_id, session_path)?;
        let key = session_identity(&settings, host_id, &path)?;
        if daemon.alive.load(Ordering::SeqCst) { daemon.request(json!({"type":"retire","sessionKey":key,"sessionPath":path}))?; }
        // Retirement stops new captures; its response follows all previously queued capture packets.
        daemon.drain_captures(Some(&key))?;
    }

    Ok(())
}

fn archive_session_on_host(app: &AppHandle, host_id: &str, session_path: &str) -> Result<(), String> {
    if host_id != "local" {
        let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, host_id)?;
        return archive_remote_session(session_path, |script| { let mut command = ssh(host); command.arg(script); command });
    }
    archive_local_session(&home_dir()?, session_path)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, terminal_ids: Vec<String>, client_id: String) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let client = app.state::<PiRuntime>();
    let _lifecycle = client.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let mutation = conversation_ownership::MutationGuard::acquire(&app, &host_id, &session_path, &client_id, false, "archive")?;
    retire_archived_session(&app, &client, &host_id, &session_path)?;
    archive_session_on_host(&app, &host_id, &session_path)?;
    let _ = stop_terminals(&runtime, &terminal_ids);
    mutation.finish()?;
    let _ = app.emit("pi://session-removed", json!({"hostId":host_id,"sessionPath":session_path}));
    Ok(())
}

fn archive_remote_session(session_path: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let file_name = Path::new(session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
    let destination = format!("{}-{file_name}", Uuid::new_v4());
    let diff_destination = Path::new(&destination).with_extension("diffs.json").to_string_lossy().into_owned();
    let remote = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) archive="$HOME/{STORAGE_DIRECTORY}/archived"; mkdir -p "$archive" || exit 1; diff=${{target%.jsonl}}.diffs.json; diff_target="$archive"/{}; moved_diff=0; if [ -f "$diff" ]; then mv -- "$diff" "$diff_target" || exit 1; moved_diff=1; fi; if ! mv -- "$target" "$archive"/{}; then if [ "$moved_diff" = 1 ]; then mv -- "$diff_target" "$diff" || true; fi; exit 1; fi ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(session_path), shell_quote(&diff_destination), shell_quote(&destination));
    let remote = format!(r#"{remote} && {{ rm -f -- "$target.loop-detection.json" || true; }}"#);
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
    let _ = fs::remove_file(format!("{}.loop-detection.json", source.display()));
    Ok(())
}

fn stored_session_file(settings: &AppSettings, host_id: &str, session_path: &str, archived: bool) -> Result<String, String> {
    if archived { archived_session_file(settings, host_id, session_path) } else { desktop_session_file(settings, host_id, session_path) }
}

fn session_store_root(archived: bool) -> Result<PathBuf, String> {
    let home = home_dir()?;
    Ok(if archived { home.join(STORAGE_DIRECTORY).join("archived") } else { desktop_sessions_dir(&home) })
}

fn delete_stored_session(app: AppHandle, runtime: &PiRuntime, session_path: String, host_id: Option<String>, archived: bool, client_id: String) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let mutation = conversation_ownership::MutationGuard::acquire(&app, &host_id, &session_path, &client_id, archived, "delete")?;
    let settings = load_app_settings(app.clone())?;
    let path = stored_session_file(&settings, &host_id, &session_path, archived)?;
    let local_root = session_store_root(archived)?;
    let host = if host_id == "local" { None } else { Some(remote_host(&settings, &host_id)?.clone()) };
    delete_session_files(runtime, &path, &host_id, host.as_ref(), &local_root, archived)?;
    mutation.finish()?;
    let _ = app.emit("pi://session-removed", json!({"hostId":host_id,"sessionPath":session_path}));
    Ok(())
}

fn delete_session_files(runtime: &PiRuntime, path: &str, host_id: &str, host: Option<&RemoteHost>, local_root: &Path, archived: bool) -> Result<(), String> {
    if runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .any(|agent| !agent.messageable && agent.host_id == host_id && agent.session_path.as_deref() == Some(path)) {
        return Err("Close the session before deleting it".into());
    }
    let active_session_ids: Vec<String> = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .filter(|agent| !agent.messageable && agent.host_id == host_id).filter_map(|agent| agent.session_id.clone()).collect();
    let arguments = json!({ "path": path, "activeSessionIds": active_session_ids, "area": if archived { "archived" } else { "sessions" }, "root": if host_id == "local" { Some(local_root) } else { None } }).to_string();
    let script = include_str!("../../resources/delete-session.cjs");
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
    run_session_deletion(&mut command)
}

fn run_session_deletion(command: &mut Command) -> Result<(), String> {
    let output = run_limited(command, 256 * 1024, "Could not delete session")?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not delete session".into() } else { error })
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn delete_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>, client_id: String) -> Result<(), String> {
    delete_stored_session(app, &runtime, session_path, host_id, false, client_id)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn delete_archived_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>, client_id: String) -> Result<(), String> {
    delete_stored_session(app, &runtime, session_path, host_id, true, client_id)
}

fn restore_worktree_command(settings: &AppSettings, host_id: &str, path: &str) -> Result<Command, String> {
    let script = include_str!("../../resources/restore-archived-worktree.cjs");
    let command = if host_id == "local" {
        let mut command = node_command();
        command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, path]);
        command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(path))));
        command
    };
    Ok(command)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn restore_archived_worktree(app: AppHandle, session_path: String, host_id: Option<String>, client_id: String) -> Result<serde_json::Value, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    let mutation = conversation_ownership::MutationGuard::acquire(&app, &host_id, &session_path, &client_id, true, "restore")?;
    let settings = load_app_settings(app.clone())?;
    let path = archived_session_file(&settings, &host_id, &session_path)?;
    let mut command = restore_worktree_command(&settings, &host_id, &path)?;
    let output = run_limited(&mut command, 64 * 1024, "Could not restore archived worktree")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let result = serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid worktree restoration response: {error}"))?;
    mutation.finish()?;
    Ok(result)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn relocate_session(app: AppHandle, session_path: String, cwd: String, host_id: Option<String>, client_id: String) -> Result<(), String> {
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let mutation = conversation_ownership::MutationGuard::acquire(&app, &host_id, &session_path, &client_id, false, "relocate")?;
    if host_id != "local" {
        let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, &host_id)?;
        relocate_remote_session(&session_path, &cwd, &host.name, |script| { let mut command = ssh(host); command.arg(remote_login_command(&script)); command })?;
        return mutation.finish();
    }
    relocate_local_session(&home_dir()?, &session_path, &cwd)?;
    mutation.finish()
}

fn relocate_remote_session(session_path: &str, cwd: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let session = shell_quote(session_path); let replacement = shell_quote(cwd.trim());
    let relocate = shell_quote(include_str!("../../resources/relocate-session.cjs"));
    let script = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) || exit 1; path=$(realpath -- {session}) || exit 1; case "$path" in "$root"/*.jsonl) ;; *) printf 'Refusing to relocate a non-desktop session file' >&2; exit 1 ;; esac; replacement={replacement}; [ -d "$replacement" ] || {{ printf 'Project directory does not exist: %s' "$replacement" >&2; exit 1; }}; node -e {relocate} "$path" "$replacement""#);
    let output = run_limited(&mut command(script), 64 * 1024, &format!("Could not relocate conversation on {host_name}"))?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { format!("Could not relocate conversation on {host_name}") } else { error })
}

fn relocate_local_session(home: &Path, session_path: &str, cwd: &str) -> Result<(), String> {
    let replacement = PathBuf::from(cwd.trim());
    if !replacement.is_dir() { return Err(format!("Project directory does not exist: {}", replacement.display())); }
    let path = local_desktop_session_file_at(home, session_path)?;
    let output = run_limited(node_command().arg("-e").arg(include_str!("../../resources/relocate-session.cjs")).arg(&path).arg(&replacement), 64 * 1024, "Could not relocate conversation")?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not relocate conversation".into() } else { error })
}
