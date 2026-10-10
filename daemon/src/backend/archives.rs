use serde_json::json;
#[cfg(test)]
use std::fs;
use std::thread;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use crate::platform::AppHandle;
use crate::platform::State;
#[cfg(test)]
use uuid::Uuid;
use crate::{AppSettings, HostStorage, MAX_PATH_LIST_BYTES, MAX_REMOTE_HOSTS, MAX_SESSION_INDEX_BATCH_BYTES, PiRuntime, RemoteHost, STORAGE_DIRECTORY, StorageInventory, StorageReport, TerminalRuntime, conversation_ownership, node_command};
use crate::terminals::{stop_terminals, terminal_lookup};
use crate::archive_sessions::archive_conversations;
use crate::process_io::{LimitedOutput, desktop_sessions_dir, run_limited, shell_quote};
use crate::pi_launch::{remote_host, remote_login_command, session_identity, ssh};
use crate::environment::home_dir;
use crate::settings::{load_app_settings};

fn recover_host_transactions(settings: &AppSettings, host_id: &str) -> Result<(), String> {
    if host_id == "local" { crate::restore_recovery::recover(&home_dir()?.join(STORAGE_DIRECTORY)) }
    else { crate::restore_recovery::recover_remote(remote_host(settings, host_id)?) }
}

fn transaction_settings(app: AppHandle, host_id: &str) -> Result<AppSettings, String> {
    let settings = load_app_settings(app)?;
    recover_host_transactions(&settings, host_id)?;
    Ok(settings)
}

pub(super) fn inspect_storage(host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    if host.is_none() { crate::restore_recovery::recover(&home_dir()?.join(STORAGE_DIRECTORY))?; }
    if let Some(host) = host { crate::restore_recovery::recover_remote(host)?; }
    let script = include_str!("../../resources/storage-inventory.bundle.mjs");
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

pub(super) fn query_storage_inventory(command: &mut Command, host: Option<&RemoteHost>) -> Result<HostStorage, String> {
    let label = host.map(|value| value.name.as_str()).unwrap_or("Local");
    let output = run_limited(command, MAX_SESSION_INDEX_BATCH_BYTES, &format!("Could not inspect storage on {label}"))?;
    parse_storage_inventory(output, host)
}

pub(super) fn parse_storage_inventory(output: LimitedOutput, host: Option<&RemoteHost>) -> Result<HostStorage, String> {
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

pub(super) fn failed_storage(host_id: String, host_name: String, error: String) -> HostStorage {
    HostStorage { host_id, host_name, categories: Vec::new(), archives: Vec::new(), warnings: Vec::new(), error: Some(error) }
}
pub(super) fn storage_report(app: AppHandle) -> Result<StorageReport, String> {
    let local = inspect_storage(None);
    let remote_hosts = load_app_settings(app)?.hosts;
    Ok(collect_storage_report(local, remote_hosts, |host| inspect_storage(Some(host))))
}

pub(super) fn collect_storage_report(local: Result<HostStorage, String>, remote_hosts: Vec<RemoteHost>, inspect: impl Fn(&RemoteHost) -> Result<HostStorage, String> + Sync) -> StorageReport {
    let mut hosts = vec![local.unwrap_or_else(|error| failed_storage("local".into(), "Local".into(), error))];
    thread::scope(|scope| {
        let inspect = &inspect;
        let queue = Arc::new(Mutex::new(remote_hosts.into_iter().filter(|host| host.enabled).collect::<Vec<_>>()));
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

pub(super) fn local_desktop_session_file_at(home: &Path, session_path: &str) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home).canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate session file: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only piop session files can be accessed".into()); }
    Ok(source)
}

fn local_archived_session_file(session_path: &str) -> Result<PathBuf, String> {
    local_archived_session_file_at(&home_dir()?, session_path)
}

pub(super) fn local_archived_session_file_at(home: &Path, session_path: &str) -> Result<PathBuf, String> {
    let root = home.join(STORAGE_DIRECTORY).join("archived").canonicalize().map_err(|error| format!("Could not locate piop archives: {error}"))?;
    let source = PathBuf::from(session_path).canonicalize().map_err(|error| format!("Could not locate archived conversation: {error}"))?;
    if !source.starts_with(&root) || source.extension().and_then(|value| value.to_str()) != Some("jsonl") || !source.is_file() { return Err("Only archived piop conversations can be accessed".into()); }
    Ok(source)
}

pub(super) fn desktop_session_file(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    if host_id == "local" { return Ok(local_desktop_session_file(path)?.to_string_lossy().into_owned()); }
    let host = remote_host(settings, host_id)?;
    remote_session_file(path, false, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn archived_session_file(settings: &AppSettings, host_id: &str, path: &str) -> Result<String, String> {
    if host_id == "local" { return Ok(local_archived_session_file(path)?.to_string_lossy().into_owned()); }
    let host = remote_host(settings, host_id)?;
    remote_session_file(path, true, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn remote_session_file(path: &str, archived: bool, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    let (area, context, rejected) = if archived {
        ("archived", "Could not locate archived Piop conversation", "Only archived conversation files in this Piop profile can be deleted")
    } else {
        ("sessions", "Could not locate Piop session", "Only session files in this Piop profile can be opened")
    };
    let script = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/{area}" && pwd -P) && session=$(realpath -- {}) && [ -f "$session" ] && case "$session" in "$root"/*.jsonl) printf '%s' "$session" ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(path));
    let output = run_limited(&mut command(script), MAX_PATH_LIST_BYTES, context)?;
    if !output.status.success() { return Err(rejected.into()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn retire_archived_session(app: &AppHandle, client: &PiRuntime, host_id: &str, session_path: &str) -> Result<(), String> {
    let daemon = client.connections.get(host_id)?;
    if let Some(daemon) = daemon {
        let settings = load_app_settings(app.clone())?;
        let path = desktop_session_file(&settings, host_id, session_path)?;
        let key = session_identity(&settings, host_id, &path)?;
        if daemon.alive.load(Ordering::SeqCst) { daemon.request(json!({"type":"retire","sessionKey":key,"sessionPath":path,"archive":true}))?; }
    }

    Ok(())
}

fn archive_session_paths(app: &AppHandle, client: &PiRuntime, host_id: &str, session_path: &str, client_id: &str) -> Result<(Vec<String>, Vec<conversation_ownership::MutationGuard>), String> {
    let mut mutations = vec![conversation_ownership::MutationGuard::acquire(app, host_id, session_path, client_id, false, "archive")?];
    retire_archived_session(app, client, host_id, session_path)?;
    let mut paths = vec![session_path.to_owned()];
    loop {
        let descendants: Vec<_> = session_descendants(app, host_id, session_path, false, false)?.into_iter()
            .map(|(path, _)| path).filter(|path| !paths.contains(path)).collect();
        if descendants.is_empty() { break; }
        for path in descendants {
            mutations.push(conversation_ownership::MutationGuard::acquire(app, host_id, &path, client_id, false, "archive")?);
            retire_archived_session(app, client, host_id, &path)?;
            paths.push(path);
        }
    }
    Ok((paths, mutations))
}
pub(super) fn archive_session(app: AppHandle, runtime: State<TerminalRuntime>, session_path: String, host_id: Option<String>, mut terminal_ids: Vec<String>, client_id: String) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let client = app.state::<PiRuntime>();
    let _lifecycle = client.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let settings = transaction_settings(app.clone(), &host_id)?;
    let (paths, mutations) = archive_session_paths(&app, &client, &host_id, &session_path, &client_id)?;
    let session_ids = paths.iter().map(|path| session_identity(&settings, &host_id, path)).collect::<Result<Vec<_>, _>>()?;
    terminal_ids.extend(terminal_lookup::session_terminals(&runtime, &host_id, &session_ids)?);
    stop_terminals(&runtime, &terminal_ids)?;
    archive_conversations(&app, &host_id, &paths)?;
    for ((path, session_id), guard) in paths.iter().zip(&session_ids).zip(mutations) {
        guard.finish()?;
        let _ = app.emit("pi://session-removed", json!({"hostId":host_id,"sessionPath":path,"sessionId":session_id}));
    }
    Ok(())
}

fn session_descendants(app: &AppHandle, host_id: &str, session_path: &str, archived: bool, include_other_area: bool) -> Result<Vec<(String, bool)>, String> {
    let script = include_str!("../../resources/session-descendants.bundle.mjs");
    let settings = load_app_settings(app.clone())?;
    let root = if host_id == "local" { Some(session_store_root(archived)?) } else { None };
    let arguments = json!({"path":session_path,"root":root,"archived":archived,"includeOtherArea":include_other_area}).to_string();
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.args(["-e", script, &arguments]);
        command
    } else {
        let mut command = ssh(remote_host(&settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments))));
        command
    };
    let output = run_limited(&mut command, MAX_SESSION_INDEX_BATCH_BYTES, "Could not find subagent conversations")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    if include_other_area {
        serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid subagent conversation list: {error}"))
    } else {
        serde_json::from_slice::<Vec<String>>(&output.stdout).map(|paths| paths.into_iter().map(|path| (path, archived)).collect()).map_err(|error| format!("Invalid subagent conversation list: {error}"))
    }
}

#[cfg(test)]
pub(super) fn archive_remote_session(session_path: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let file_name = Path::new(session_path).file_name().and_then(|name| name.to_str()).ok_or("Session path has no file name")?;
    let destination = format!("{}-{file_name}", Uuid::new_v4());
    let remote = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) && target=$(realpath -- {}) && case "$target" in "$root"/*.jsonl) archive="$HOME/{STORAGE_DIRECTORY}/archived"; mkdir -p "$archive" && mv -- "$target" "$archive"/{} ;; *) printf 'Refusing to archive a non-desktop session file' >&2; exit 1 ;; esac"#, shell_quote(session_path), shell_quote(&destination));
    let remote = format!(r#"{remote} && {{ rm -f -- "$target.loop-detection.json" || true; }}"#);
    let output = command(remote).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(())
}

#[cfg(test)]
pub(super) fn archive_local_session(home: &Path, session_path: &str) -> Result<(), String> {
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
    if let Err(error) = fs::rename(&source, &destination) {
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

type DeletionPaths = (Vec<(String, bool)>, Vec<conversation_ownership::MutationGuard>);

fn initial_deletion_paths(app: &AppHandle, settings: &AppSettings, host_id: &str, session_paths: Vec<String>, archived: bool, client_id: &str) -> Result<DeletionPaths, String> {
    let mut mutations = Vec::new();
    let mut paths = Vec::new();
    for session_path in session_paths {
        let path = stored_session_file(settings, host_id, &session_path, archived)?;
        if paths.iter().any(|(existing, _)| existing == &path) { continue; }
        mutations.push(conversation_ownership::MutationGuard::acquire(app, host_id, &path, client_id, archived, "delete")?);
        paths.push((path, archived));
    }
    Ok((paths, mutations))
}

fn acquire_deletion_descendants(app: &AppHandle, host_id: &str, client_id: &str, paths: &mut Vec<(String, bool)>, mutations: &mut Vec<conversation_ownership::MutationGuard>) -> Result<(), String> {
    let roots = paths.clone();
    loop {
        let mut children = Vec::new();
        for (path, archived) in &roots {
            children.extend(session_descendants(app, host_id, path, *archived, true)?);
        }
        let mut added = false;
        for (child, child_archived) in children {
            if paths.iter().any(|(path, _)| path == &child) { continue; }
            mutations.push(conversation_ownership::MutationGuard::acquire(app, host_id, &child, client_id, child_archived, "delete")?);
            paths.push((child, child_archived));
            added = true;
        }
        if !added { break; }
    }
    Ok(())
}

fn deletion_targets(settings: &AppSettings, host_id: &str, paths: &[(String, bool)]) -> Result<Vec<serde_json::Value>, String> {
    let mut targets = Vec::new();
    for (path, archived) in paths {
        let path = stored_session_file(settings, host_id, path, *archived)?;
        targets.push(json!({"path":path,"area":if *archived { "archived" } else { "sessions" },"root":if host_id == "local" { Some(session_store_root(*archived)?) } else { None }}));
    }
    Ok(targets)
}

fn finish_deleted_sessions(app: &AppHandle, host_id: &str, paths: &[(String, bool)], session_ids: &[String], mutations: Vec<conversation_ownership::MutationGuard>) {
    for (((path, _), session_id), mutation) in paths.iter().zip(session_ids).zip(mutations) {
        if let Err(error) = mutation.finish_committed() {
            eprintln!("Conversation deletion committed, but ownership cleanup failed for {path}: {error}");
        }
        let _ = app.emit("pi://session-removed", json!({"hostId":host_id,"sessionPath":path,"sessionId":session_id}));
    }
    if let Err(error) = crate::session_groups::refresh_deletions(app, host_id) {
        eprintln!("Committed deletion group cleanup will retry: {error}");
    }
}

fn close_deleted_session_terminals(app: &AppHandle, host_id: &str, session_ids: &[String]) -> Result<(), String> {
    let terminals = app.state::<TerminalRuntime>();
    let terminal_ids = terminal_lookup::session_terminals(&terminals, host_id, session_ids)?;
    stop_terminals(&terminals, &terminal_ids)
}

fn delete_conversation_files(app: &AppHandle, runtime: &PiRuntime, settings: &AppSettings, host_id: &str, paths: &[(String, bool)]) -> Result<Vec<String>, String> {
    let targets = deletion_targets(settings, host_id, paths)?;
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?) };
    let session_ids = paths.iter().map(|(path, _)| session_identity(settings, host_id, path)).collect::<Result<Vec<_>, _>>()?;
    close_deleted_session_terminals(app, host_id, &session_ids)?;
    delete_session_targets(runtime, &targets, host_id, host)?;
    Ok(session_ids)
}

fn delete_stored_sessions(app: AppHandle, runtime: &PiRuntime, session_paths: Vec<String>, host_id: Option<String>, archived: bool, client_id: String) -> Result<Vec<String>, String> {
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let settings = transaction_settings(app.clone(), &host_id)?;
    if session_paths.is_empty() { return Err("Select at least one conversation to delete".into()); }
    let (mut paths, mut mutations) = initial_deletion_paths(&app, &settings, &host_id, session_paths, archived, &client_id)?;
    acquire_deletion_descendants(&app, &host_id, &client_id, &mut paths, &mut mutations)?;
    let session_ids = delete_conversation_files(&app, runtime, &settings, &host_id, &paths)?;
    finish_deleted_sessions(&app, &host_id, &paths, &session_ids, mutations);
    Ok(paths.into_iter().map(|(path, _)| path).collect())
}

#[cfg(test)]
pub(super) fn delete_session_files(runtime: &PiRuntime, path: &str, host_id: &str, host: Option<&RemoteHost>, local_root: &Path, archived: bool) -> Result<(), String> {
    delete_session_targets(runtime, &[json!({"path":path,"area":if archived { "archived" } else { "sessions" },"root":if host_id == "local" { Some(local_root) } else { None }})], host_id, host)
}

fn delete_session_targets(runtime: &PiRuntime, targets: &[serde_json::Value], host_id: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    if runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .any(|agent| !agent.messageable && agent.host_id == host_id && targets.iter().any(|target| agent.session_path.as_deref() == target["path"].as_str())) {
        return Err("Close the session before deleting it".into());
    }
    let active_session_ids: Vec<String> = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values()
        .filter(|agent| !agent.messageable && agent.host_id == host_id).filter_map(|agent| agent.session_id.clone()).collect();
    let arguments = json!({ "action": "delete", "targets": targets, "activeSessionIds": active_session_ids }).to_string();
    let script = include_str!("../../resources/storage-transaction.bundle.mjs");
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.args(["-e", script, &arguments]);
        command
    } else {
        let host = host.ok_or("Remote host is required")?;
        let mut command = ssh(host);
        let remote = format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments));
        command.arg(remote_login_command(&remote));
        command
    };
    run_session_deletion(&mut command)
}

pub(super) fn run_session_deletion(command: &mut Command) -> Result<(), String> {
    let output = run_limited(command, 256 * 1024, "Could not delete session")?;
    if output.status.success() {
        if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not delete session".into() } else { error })
}
pub(super) fn delete_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, host_id: Option<String>, client_id: String) -> Result<Vec<String>, String> {
    delete_stored_sessions(app, &runtime, vec![session_path], host_id, false, client_id)
}
pub(super) fn delete_archived_session(app: AppHandle, runtime: State<PiRuntime>, session_path: String, session_paths: Option<Vec<String>>, host_id: Option<String>, client_id: String) -> Result<Vec<String>, String> {
    let mut paths = session_paths.unwrap_or_default();
    paths.push(session_path);
    delete_stored_sessions(app, &runtime, paths, host_id, true, client_id)
}

fn restore_session_command(settings: &AppSettings, host_id: &str, request: serde_json::Value) -> Result<Command, String> {
    let script = include_str!("../../resources/storage-transaction.bundle.mjs");
    let request = request.to_string();
    let command = if host_id == "local" {
        let mut command = node_command();
        command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, &request]);
        command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&request))));
        command
    };
    Ok(command)
}
pub(super) fn restore_archived_session(app: AppHandle, session_path: String, host_id: Option<String>, client_id: String) -> Result<(), String> {
    restore_archived_session_result(app, session_path, host_id, client_id).map(|_| ())
}

fn restore_result(settings: &AppSettings, host_id: &str, path: &str) -> Result<serde_json::Value, String> {
    let mut command = restore_session_command(settings, host_id, json!({"action":"result","path":path}))?;
    let result = run_session_restoration(&mut command)?;
    if result.is_null() { return Err("No committed restoration is available".into()); }
    Ok(result)
}

fn restored_conversations(result: &serde_json::Value) -> &[serde_json::Value] {
    result.get("sessions").and_then(serde_json::Value::as_array).map(Vec::as_slice).unwrap_or_else(|| std::slice::from_ref(result))
}

fn restore_mutations(app: &AppHandle, host_id: &str, path: &str, client_id: &str, parent: conversation_ownership::MutationGuard) -> Result<Vec<(String, conversation_ownership::MutationGuard)>, String> {
    let mut mutations = vec![(path.to_owned(), parent)];
    for (child, _) in session_descendants(app, host_id, path, true, false)? {
        let mutation = conversation_ownership::MutationGuard::acquire(app, host_id, &child, client_id, true, "restore")?;
        mutations.push((child, mutation));
    }
    Ok(mutations)
}

fn finish_restore_mutations(mutations: Vec<(String, conversation_ownership::MutationGuard)>, result: &serde_json::Value) -> Result<(), String> {
    let restored = restored_conversations(result);
    let paths = mutations.iter().map(|(source, _)| {
        restored.iter().find(|session| session["sourcePath"].as_str() == Some(source.as_str()))
            .or_else(|| (mutations.len() == 1).then_some(result))
            .and_then(|session| session["sessionPath"].as_str()).map(str::to_owned).ok_or("Restored session path missing".to_owned())
    }).collect::<Result<Vec<_>, _>>()?;
    for ((_, mutation), path) in mutations.into_iter().zip(paths) {
        if let Err(error) = mutation.finish_restore(&path) { eprintln!("Restore committed; could not acknowledge ownership release: {error}"); }
    }
    Ok(())
}

fn perform_restore(app: &AppHandle, settings: &AppSettings, host_id: &str, session_path: &str, client_id: &str) -> Result<serde_json::Value, String> {
    let path = match archived_session_file(settings, host_id, session_path) {
        Ok(path) => path,
        Err(error) => return restore_result(settings, host_id, session_path).map_err(|_| error),
    };
    let mutation = match conversation_ownership::MutationGuard::acquire(app, host_id, &path, client_id, true, "restore") {
        Ok(mutation) => mutation,
        Err(error) => return restore_result(settings, host_id, &path).map_err(|_| error),
    };
    let mutations = restore_mutations(app, host_id, &path, client_id, mutation)?;
    let paths = mutations.iter().map(|(source, _)| source).collect::<Vec<_>>();
    let mut command = restore_session_command(settings, host_id, json!({"action":"restore","paths":paths}))?;
    let result = run_session_restoration(&mut command).or_else(|error| restore_result(settings, host_id, &path).map_err(|_| error))?;
    finish_restore_mutations(mutations, &result)?;
    Ok(result)
}
pub(super) fn restore_archived_session_result(app: AppHandle, session_path: String, host_id: Option<String>, client_id: String) -> Result<serde_json::Value, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    let settings = transaction_settings(app.clone(), &host_id)?;
    let result = perform_restore(&app, &settings, &host_id, &session_path, &client_id)?;
    for session in restored_conversations(&result) {
        let _ = app.emit("pi://session-restored", json!({"hostId":host_id,"sessionId":session["sessionId"],"sessionPath":session["sessionPath"]}));
    }
    let _ = app.emit("pi://sessions-changed", json!({}));
    Ok(result)
}

fn run_session_restoration(command: &mut Command) -> Result<serde_json::Value, String> {
    let output = run_limited(command, MAX_SESSION_INDEX_BATCH_BYTES, "Could not restore archived chat")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid chat restoration response: {error}"))?;
    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
}
pub(super) fn relocate_session(app: AppHandle, session_path: String, cwd: String, host_id: Option<String>, client_id: String) -> Result<(), String> {
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

pub(super) fn recover_missing_session(app: AppHandle, session_path: String, host_id: Option<String>, action: String, client_id: String) -> Result<serde_json::Value, String> {
    validate_recovery_action(&action)?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let settings = load_app_settings(app.clone())?;
    let path = desktop_session_file(&settings, &host_id, &session_path)?;
    let mutation = conversation_ownership::MutationGuard::acquire(&app, &host_id, &path, &client_id, false, "relocate")?;
    let arguments = json!({"sessionPath":path,"action":action,"storage":STORAGE_DIRECTORY}).to_string();
    let script = include_str!("../../resources/recover-missing-session.bundle.mjs");
    let relocate = include_str!("../../resources/relocate-session.bundle.mjs");
    let registry = crate::session_registry::source();
    let mut command = directory_recovery_command(&settings, &host_id, script, &arguments, relocate, &registry)?;
    let result = run_directory_recovery(&mut command)?;
    mutation.finish()?;
    let _ = app.emit("pi://sessions-changed", ());
    Ok(result)
}

fn validate_recovery_action(action: &str) -> Result<(), String> {
    if action == "empty" { Ok(()) } else { Err("Unknown recovery action".into()) }
}

fn directory_recovery_command(settings: &AppSettings, host_id: &str, script: &str, arguments: &str, relocate: &str, registry: &str) -> Result<Command, String> {
    let command = if host_id == "local" {
        let mut command = node_command(); command.args(["-e", script, arguments, relocate, registry]); command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {} {} {}", shell_quote(script), shell_quote(arguments), shell_quote(relocate), shell_quote(registry)))); command
    };
    Ok(command)
}

fn run_directory_recovery(command: &mut Command) -> Result<serde_json::Value, String> {
    let output = run_limited(command, 64 * 1024, "Could not recover the session directory")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid recovery response: {error}"))
}

pub(super) fn relocate_remote_session(session_path: &str, cwd: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let session = shell_quote(session_path); let replacement = shell_quote(cwd.trim());
    let relocate = shell_quote(include_str!("../../resources/relocate-session.bundle.mjs"));
    let script = format!(r#"root=$(cd "$HOME/{STORAGE_DIRECTORY}/sessions" && pwd -P) || exit 1; path=$(realpath -- {session}) || exit 1; case "$path" in "$root"/*.jsonl) ;; *) printf 'Refusing to relocate a non-desktop session file' >&2; exit 1 ;; esac; replacement={replacement}; [ -d "$replacement" ] || {{ printf 'Project directory does not exist: %s' "$replacement" >&2; exit 1; }}; PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {relocate} "$path" "$replacement""#);
    let output = run_limited(&mut command(script), 64 * 1024, &format!("Could not relocate conversation on {host_name}"))?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { format!("Could not relocate conversation on {host_name}") } else { error })
}

pub(super) fn relocate_local_session(home: &Path, session_path: &str, cwd: &str) -> Result<(), String> {
    let replacement = PathBuf::from(cwd.trim());
    if !replacement.is_dir() { return Err(format!("Project directory does not exist: {}", replacement.display())); }
    let path = local_desktop_session_file_at(home, session_path)?;
    let output = run_limited(node_command().arg("-e").arg(include_str!("../../resources/relocate-session.bundle.mjs")).arg(&path).arg(&replacement), 64 * 1024, "Could not relocate conversation")?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() { "Could not relocate conversation".into() } else { error })
}
