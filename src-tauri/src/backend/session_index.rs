use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::thread;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use crate::platform::AppHandle;
use crate::platform::State;
use uuid::Uuid;
use walkdir::WalkDir;
use crate::{AppSettings, CachedSession, DirectoryListing, MAX_GIT_PATH_LIST_BYTES, MAX_REMOTE_HOSTS, MAX_SESSION_INDEX_BATCH_BYTES, ProjectKind, RemoteHost, STORAGE_DIRECTORY, SessionIndexRuntime, SessionSummary, TemporaryChat, node_command, peers};
use crate::worktree_setup::{run_limited, shell_quote};
use crate::pi_launch::{local_launch_directory, remote_directory_path, remote_host, remote_login_command, ssh};
use crate::environment::home_dir;
use crate::settings::{load_app_settings};

fn unix_timestamp(time: SystemTime) -> u64 { time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() }

fn inspect_session_projects(index: &SessionIndexRuntime, sessions: &mut [SessionSummary], host: Option<&RemoteHost>) -> Result<(), String> {
    index.projects.inspect(sessions, host, |pending| inspect_session_projects_with(pending, |script, batch| {
        if let Some(host) = host {
            let arguments = batch.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" ");
            let mut command = ssh(host);
            command.arg(format!("sh -c {} sh {arguments}", shell_quote(script)));
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", script, "sh"]).args(batch);
            command
        }
    }))
}

fn project_kind_from_flag(flag: &[u8]) -> Option<ProjectKind> {
    match flag { b"no-repo" => Some(ProjectKind::NoRepo), b"main" => Some(ProjectKind::Main), b"worktree" => Some(ProjectKind::Worktree), _ => None }
}

fn inspect_project_batches(directories: &[String], script: &str, command: &mut impl FnMut(&str, &[String]) -> Command) -> Result<Vec<(Vec<String>, crate::worktree_setup::LimitedOutput)>, String> {
    let mut outputs = Vec::new();
    for group in directories.chunks(64) {
        let commands = group.chunks(16).map(|batch| (batch.to_vec(), command(script, batch))).collect::<Vec<_>>();
        let completed = thread::scope(|scope| {
            let workers = commands.into_iter().map(|(batch, mut command)| scope.spawn(move || {
                run_limited(&mut command, MAX_GIT_PATH_LIST_BYTES, "Could not inspect session projects").map(|output| (batch, output))
            })).collect::<Vec<_>>();
            workers.into_iter().map(|worker| worker.join().map_err(|_| "Project inspection worker panicked".to_string())?).collect::<Result<Vec<_>, String>>()
        })?;
        outputs.extend(completed);
    }
    Ok(outputs)
}

pub(super) fn inspect_session_projects_with(sessions: &mut [SessionSummary], mut command: impl FnMut(&str, &[String]) -> Command) -> Result<(), String> {
    let mut directories = sessions.iter().map(|session| session.cwd.clone()).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    directories.sort();
    let script = r#"previous_git_dir=
    for path do
        if [ ! -d "$path" ]; then printf 'missing\000\000\000\000'; continue; fi
        git_dir=$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null) || { printf 'no-repo\000\000\000\000'; continue; }
        if [ "$git_dir" != "$previous_git_dir" ] || [ -n "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_COMMON_DIR+x}" ]; then
            common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { printf 'unknown\000\000\000\000'; continue; }
            if [ "$git_dir" = "$common_dir" ]; then project_kind=main; else project_kind=worktree; fi
            project_root=$(git -C "$path" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
            branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=$(git -C "$path" rev-parse --short HEAD 2>/dev/null | sed 's/^/Detached at /')
            worktree_root=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null)
            previous_git_dir=$git_dir
        fi
        printf '%s\000%s\000%s\000%s\000' "$project_kind" "$project_root" "$branch" "$worktree_root"
    done"#;
    let mut projects = HashMap::new();
    for (batch, output) in inspect_project_batches(&directories, script, &mut command)? {
        if !output.status.success() { return Err(format!("Could not inspect session projects: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        let fields = output.stdout.strip_suffix(&[0]).ok_or("Incomplete session project details")?.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != batch.len() * 4 { return Err("Could not inspect every session project".into()); }
        for (path, details) in batch.iter().zip(fields.chunks_exact(4)) {
            let flag = details[0];
            let project_root = (!details[1].is_empty()).then(|| String::from_utf8_lossy(details[1]).into_owned());
            let branch = (!details[2].is_empty()).then(|| String::from_utf8_lossy(details[2]).into_owned());
            let worktree_root = (!details[3].is_empty()).then(|| String::from_utf8_lossy(details[3]).into_owned());
            let kind = project_kind_from_flag(flag);
            projects.insert(path.clone(), (flag != b"missing", kind, project_root, branch, worktree_root));
        }
    }
    for session in sessions {
        if let Some((exists, kind, project_root, branch, worktree_root)) = projects.get(session.cwd.as_str()) { session.cwd_exists = *exists; session.project_kind = *kind; session.project_root = project_root.clone(); session.branch = branch.clone(); session.worktree_root = worktree_root.clone(); }
    }
    Ok(())
}

pub(super) fn read_session_summaries(candidates: &[(String, String, u64, u64)], host: Option<&RemoteHost>) -> Result<HashMap<String, CachedSession>, String> {
    read_session_summaries_with(candidates, host, |script, batch| {
        if let Some(host) = host {
            let mut command = ssh(host); command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), batch.iter().map(|item| shell_quote(&item.0)).collect::<Vec<_>>().join(" ")))); command
        } else { let mut command = node_command(); command.args(["-e", script]).args(batch.iter().map(|item| &item.0)); command }
    })
}

pub(super) fn read_session_summaries_with(candidates: &[(String, String, u64, u64)], host: Option<&RemoteHost>,
    mut command: impl FnMut(&str, &[(String, String, u64, u64)]) -> Command,
) -> Result<HashMap<String, CachedSession>, String> {
    let script = include_str!("../../resources/index-sessions.bundle.mjs");
    let mut result = HashMap::new(); let mut cursor = 0;
    while cursor < candidates.len() {
        let mut end = cursor; let mut argument_bytes = 0;
        while end < candidates.len() && end - cursor < 128 {
            let size = shell_quote(&candidates[end].0).len() + 1;
            if end > cursor && argument_bytes + size > 16 * 1024 { break; }
            argument_bytes += size; end += 1;
        }
        let batch = &candidates[cursor..end];
        let output = run_limited(&mut command(script, batch), MAX_SESSION_INDEX_BATCH_BYTES, "Could not read session summaries")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        for line in output.stdout.split(|byte| *byte == b'\n') {
            let Ok(value) = serde_json::from_slice::<Value>(line) else { continue };
            let Some(path) = value.get("path").and_then(Value::as_str) else { continue };
            let Some((_, fingerprint, modified_at, _)) = batch.iter().find(|item| item.0 == path) else { continue };
            let string = |key| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let cwd = string("cwd"); let project = Path::new(&cwd).file_name().and_then(|name| name.to_str()).unwrap_or("Workspace").to_owned();
            let summary = SessionSummary { group_id: None, subagent_parent_id: value.get("subagentParentId").and_then(Value::as_str).map(str::to_owned), id: string("id"), path: path.to_owned(), name: string("name"), project, cwd, cwd_exists: true, project_kind: None, project_root: None, branch: None, worktree_root: None, modified_at: *modified_at, preview: string("preview"), message_count: value.get("messageCount").and_then(Value::as_u64).unwrap_or(0) as usize, last_message_at: value.get("lastMessageAt").and_then(Value::as_u64).unwrap_or(0), api_cost: value.get("apiCost").and_then(Value::as_f64).unwrap_or(0.0), host_id: host.map(|host| host.id.clone()).unwrap_or_else(|| "local".into()), host_name: host.map(|host| host.name.clone()).unwrap_or_else(|| "Local".into()) };
            result.insert(path.to_owned(), CachedSession { fingerprint: fingerprint.clone(), summary });
        }
        cursor = end;
    }
    Ok(result)
}

pub(super) fn list_local_sessions(index: &SessionIndexRuntime, root: &Path) -> Result<Vec<SessionSummary>, String> {
    crate::restore_recovery::recover(root.parent().ok_or("Session storage root missing")?)?;
    crate::session_registry::index_existing();
    let mut cache = index.local.lock().map_err(|_| "Local session index lock was poisoned")?;
    let mut seen = HashSet::new(); let mut changed = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")) {
        let path = entry.path().to_path_buf(); let Ok(metadata) = entry.metadata() else { continue };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let fingerprint = format!("{}:{}", modified.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos(), metadata.len());
        seen.insert(path.clone());
        if cache.get(&path).is_none_or(|cached| cached.fingerprint != fingerprint) { changed.push((path.to_string_lossy().into_owned(), fingerprint, unix_timestamp(modified), metadata.len())); }
    }
    for (path, summary) in read_session_summaries(&changed, None)? { cache.insert(PathBuf::from(path), summary); }
    cache.retain(|path, _| seen.contains(path)); let mut sessions = cache.values().map(|cached| cached.summary.clone()).collect::<Vec<_>>(); drop(cache);
    inspect_session_projects(index, &mut sessions, None)?; Ok(sessions)
}

pub(super) fn list_remote_sessions(index: &SessionIndexRuntime, host: &RemoteHost) -> Result<Vec<SessionSummary>, String> {
    crate::restore_recovery::recover_remote(host)?;
    let metadata = query_remote_session_metadata(|script| { let mut command = ssh(host); command.arg(script); command })?;
    update_remote_session_index(index, host, &metadata,
        |changed| read_session_summaries(changed, Some(host)),
        |sessions| inspect_session_projects(index, sessions, Some(host)))
}

pub(super) fn query_remote_session_metadata(command: impl FnOnce(&str) -> Command) -> Result<Vec<u8>, String> {
    let mut command = command(&format!(r#"mkdir -p "$HOME/{STORAGE_DIRECTORY}/sessions" && find "$HOME/{STORAGE_DIRECTORY}/sessions" -type f -name '*.jsonl' -printf '%p\000%T@\000%s\000' 2>/dev/null"#));
    let output = run_limited(&mut command, MAX_SESSION_INDEX_BATCH_BYTES, "Could not list remote sessions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    Ok(output.stdout)
}

pub(super) fn update_remote_session_index(
    index: &SessionIndexRuntime, host: &RemoteHost, metadata: &[u8],
    read: impl FnOnce(&[(String, String, u64, u64)]) -> Result<HashMap<String, CachedSession>, String>,
    inspect: impl FnOnce(&mut [SessionSummary]) -> Result<(), String>,
) -> Result<Vec<SessionSummary>, String> {
    let metadata = parse_remote_session_metadata(metadata);
    let previous = index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.get(&host.id).cloned().unwrap_or_default();
    let changed = metadata.iter().filter(|(path, fingerprint, _, _)| previous.get(path).is_none_or(|cached| cached.fingerprint != *fingerprint)).cloned().collect::<Vec<_>>();
    let mut parsed = read(&changed)?;

    let mut next = HashMap::new(); let mut sessions = Vec::new();
    for (path, _, _, _) in metadata {
        let Some(mut cached) = parsed.remove(&path).or_else(|| previous.get(&path).cloned()) else { continue };
        cached.summary.host_name = host.name.clone(); sessions.push(cached.summary.clone()); next.insert(path, cached);
    }
    inspect(&mut sessions)?;
    index.remote.lock().map_err(|_| "Remote session index lock was poisoned")?.insert(host.id.clone(), next); Ok(sessions)
}

pub(super) fn parse_remote_session_metadata(output: &[u8]) -> Vec<(String, String, u64, u64)> {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    fields.chunks_exact(3).filter_map(|frame| {
        let path = String::from_utf8_lossy(frame[0]).into_owned(); let modified = String::from_utf8_lossy(frame[1]); let size = String::from_utf8_lossy(frame[2]).parse().ok()?;
        Some((path, format!("{modified}:{size}"), modified.split('.').next()?.parse().ok()?, size))
    }).collect()
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn home_directory(app: AppHandle, host_id: String) -> Result<String, String> {
    if host_id == "local" { let home = home_dir()?; return Ok(home.canonicalize().unwrap_or(home).to_string_lossy().into_owned()); }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let output = ssh(host).arg("cd \"$HOME\" && pwd -P").output().map_err(|error| format!("Could not resolve home on {}: {error}", host.name))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path).ok_or_else(|| "Remote home directory was unavailable".into())
}

pub(super) fn create_local_temporary_chat(home: &Path, session_id: &str) -> Result<PathBuf, String> {
    let cwd = home.join(STORAGE_DIRECTORY).join("tmp").join(session_id);
    fs::create_dir_all(&cwd).map_err(|error| format!("Could not create temporary chat directory: {error}"))?;
    Ok(cwd)
}

pub(super) fn temporary_chat_id(path: &str) -> Option<&str> {
    let value = Path::new(path); let id = value.file_name()?.to_str()?;
    if Uuid::parse_str(id).ok()?.to_string() != id { return None; }
    let parent = value.parent()?;
    (parent.file_name() == Some(std::ffi::OsStr::new("tmp")) && parent.parent()?.file_name() == Some(std::ffi::OsStr::new(STORAGE_DIRECTORY))).then_some(id)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn remove_temporary_chat(app: AppHandle, path: String, host_id: String) -> Result<(), String> {
    if host_id == "local" {
        return remove_local_temporary_chat(&home_dir()?, &path);
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    remove_remote_temporary_chat(&path, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn remove_remote_temporary_chat(path: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    temporary_chat_id(path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    let script = format!("candidate={}; root=\"$HOME/{STORAGE_DIRECTORY}/tmp\"; [ \"$(dirname -- \"$candidate\")\" = \"$root\" ] && [ ! -L \"$HOME/{STORAGE_DIRECTORY}\" ] && [ ! -L \"$root\" ] && [ ! -L \"$candidate\" ] && {{ [ ! -e \"$candidate\" ] || {{ [ -d \"$candidate\" ] && node -e 'try {{ require(\"node:fs\").rmdirSync(process.argv[1]); }} catch (error) {{ if (![\"ENOTEMPTY\", \"EEXIST\", \"ENOENT\"].includes(error.code)) throw error; }}' \"$candidate\"; }}; }}", shell_quote(path));
    let output = command(script).output().map_err(|error| format!("Could not remove temporary chat directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(format!("Could not remove temporary chat directory on {host_name}: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}

fn temporary_chat_directory_exists(directory: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err("Refusing to remove a temporary chat through a symlink or non-directory".into()),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect temporary chat directory: {error}")),
    }
}

pub(super) fn remove_local_temporary_chat(home: &Path, path: &str) -> Result<(), String> {
    temporary_chat_id(path).ok_or("Refusing to remove a directory not created as a temporary chat")?;
    let expected_root = home.join(STORAGE_DIRECTORY).join("tmp");
    let candidate = PathBuf::from(path);
    if candidate.parent() != Some(expected_root.as_path()) { return Err("Refusing to remove a directory outside the temporary chat root".into()); }
    for directory in [home.join(STORAGE_DIRECTORY), expected_root, candidate.clone()] {
        if !temporary_chat_directory_exists(&directory)? { return Ok(()); }
    }
    match fs::remove_dir(candidate) {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound) => Ok(()),
        Err(error) => Err(format!("Could not remove temporary chat directory: {error}")),
    }
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn validate_project_directory(app: AppHandle, path: String, host_id: String, allow_storage: Option<bool>) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    if allow_storage == Some(true) {
        validate_session_working_directory(&load_app_settings(app)?, &host_id, Some(&path))?;
        return Ok(path);
    }
    if host_id == "local" {
        return validate_local_project_directory(path);
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    validate_remote_project_directory(path, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn validate_session_working_directory(settings: &AppSettings, host_id: &str, cwd: Option<&str>) -> Result<(), String> {
    if host_id == "local" {
        let path = local_launch_directory(cwd)?;
        let metadata = fs::metadata(&path).map_err(|error| format!("Cannot start conversation: project directory {} is unavailable: {error}", path.display()))?;
        if !metadata.is_dir() { return Err(format!("Cannot start conversation: {} is not a directory", path.display())); }
        return Ok(());
    }
    let host = remote_host(settings, host_id)?;
    let script = format!("cd {} && test -d .", remote_directory_path(cwd));
    let output = run_limited(ssh(host).arg(script), 64 * 1024, "Could not check conversation directory")?;
    if !output.status.success() { return Err(format!("Cannot start conversation: project directory {} is unavailable on {}", cwd.unwrap_or("~"), host.name)); }
    Ok(())
}

pub(super) fn validate_local_project_directory(path: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not open project directory: {error}"))?;
    if !metadata.is_dir() { return Err("Project path is not a directory".into()); }
    let canonical = fs::canonicalize(&path).map_err(|error| format!("Could not open project directory: {error}"))?;
    let home = home_dir()?;
    for name in [".piop", ".piop-dev"] {
        let storage = home.join(name);
        if Path::new(&path).starts_with(&storage) || canonical.starts_with(storage.canonicalize().unwrap_or(storage)) {
            return Err("Piop storage directories cannot be selected as projects".into());
        }
    }
    Ok(path)
}

pub(super) fn validate_remote_project_directory(path: String, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    if path.trim().is_empty() { return Err("Path can't be empty".into()); }
    let script = format!("test -d {0} && cd {0} || exit 1; candidate=$(pwd -P); for storage in \"$HOME/.piop\" \"$HOME/.piop-dev\"; do [ ! -d \"$storage\" ] || storage=$(cd \"$storage\" && pwd -P); case \"$candidate\" in \"$storage\"|\"$storage\"/*) echo 'Piop storage directories cannot be selected as projects' >&2; exit 1;; esac; done; printf '%s\\n' \"$candidate\"", shell_quote(&path));
    let output = command(script).output().map_err(|error| format!("Could not validate project directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(format!("Could not open project directory on {host_name}: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(path)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn create_temporary_chat(app: AppHandle, host_id: String, e2e: Option<bool>) -> Result<TemporaryChat, String> {
    let session_id = Uuid::new_v4().to_string();
    let cwd = if host_id == "local" {
        let cwd = create_local_temporary_chat(&home_dir()?, &session_id)?;
        if cfg!(feature = "webdriver") && e2e.unwrap_or(false) { fs::write(cwd.join(".pi-e2e-test"), b"").map_err(|error| format!("Could not mark temporary test chat: {error}"))?; }
        cwd.to_string_lossy().into_owned()
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        create_remote_temporary_chat(&session_id, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })?
    };
    Ok(TemporaryChat { cwd, session_id })
}

pub(super) fn create_remote_temporary_chat(session_id: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<String, String> {
    Uuid::parse_str(session_id).map_err(|_| "Invalid temporary chat session ID")?;
    let remote = format!("mkdir -p \"$HOME/{STORAGE_DIRECTORY}/tmp/{session_id}\" && cd \"$HOME/{STORAGE_DIRECTORY}/tmp/{session_id}\" && pwd -P");
    let output = command(remote).output().map_err(|error| format!("Could not create temporary chat directory on {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { return Err("Remote temporary chat directory was unavailable".into()); }
    Ok(path)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn list_directories(app: AppHandle, host_id: String, path: Option<String>) -> Result<DirectoryListing, String> {
    if host_id == "local" {
        return list_local_directories(&home_dir()?, path.as_deref());
    }
    let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
    let mut command = ssh(host); command.arg(remote_directory_listing_script(path.as_deref()));
    query_remote_directories(&mut command, &host.name)
}

pub(super) fn list_local_directories(home: &Path, path: Option<&str>) -> Result<DirectoryListing, String> {
    let requested = path.filter(|value| !value.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| home.to_path_buf());
    let current = requested.canonicalize().map_err(|error| format!("Could not browse {}: {error}", requested.display()))?;
    if !current.is_dir() { return Err(format!("{} is not a directory", current.display())); }
    let entries = fs::read_dir(&current).map_err(|error| format!("Could not browse {}: {error}", current.display()))?;
    let mut directories: Vec<String> = entries.filter_map(Result::ok).filter(|entry| {
        match entry.file_type() {
            Ok(kind) if !kind.is_symlink() => kind.is_dir(),
            _ => entry.path().is_dir(),
        }
    }).map(|entry| entry.path().to_string_lossy().into_owned()).collect();
    directories.sort_by_cached_key(|directory| directory.to_lowercase());
    Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories })
}

pub(super) fn remote_directory_listing_script(path: Option<&str>) -> String {
    format!("cd {} && printf '%s\\000' \"$PWD\" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f\\000'", remote_directory_path(path))
}

pub(super) fn query_remote_directories(command: &mut Command, host_name: &str) -> Result<DirectoryListing, String> {
    let output = command.output().map_err(|error| format!("Could not browse {host_name}: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    parse_remote_directories(&output.stdout)
}

pub(super) fn parse_remote_directories(output: &[u8]) -> Result<DirectoryListing, String> {
    let mut parts = output.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let current = PathBuf::from(String::from_utf8_lossy(parts.next().ok_or("Remote directory was unavailable")?).into_owned());
    let mut directories: Vec<String> = parts.map(|name| current.join(String::from_utf8_lossy(name).as_ref()).to_string_lossy().into_owned()).collect();
    directories.sort_by_cached_key(|directory| directory.to_lowercase());
    Ok(DirectoryListing { path: current.to_string_lossy().into_owned(), parent: current.parent().map(|parent| parent.to_string_lossy().into_owned()), directories })
}

#[cfg(not(feature = "desktop"))]
pub(super) fn collect_sessions(app: &AppHandle, index: &SessionIndexRuntime) -> Result<Vec<SessionSummary>, String> { peers::all_summaries(app, index) }

#[cfg(feature = "desktop")]
pub(super) fn collect_sessions(app: &AppHandle, index: &SessionIndexRuntime) -> Result<Vec<SessionSummary>, String> {
    let home = home_dir()?; let root = ensure_desktop_sessions_dir(&home)?;
    let settings = load_app_settings(app.clone())?;
    let sessions = if settings.local_enabled { list_local_sessions(index, &root)? } else { Vec::new() };
    let hosts = settings.hosts;
    collect_host_sessions(sessions, hosts, |host| list_remote_sessions(index, host), session_groups::attach_assignments)
}

pub(super) fn collect_host_sessions(
    mut sessions: Vec<SessionSummary>, hosts: Vec<RemoteHost>,
    list: impl Fn(&RemoteHost) -> Result<Vec<SessionSummary>, String> + Sync,
    assign: impl FnOnce(&mut [SessionSummary]) -> Result<(), String>,
) -> Result<Vec<SessionSummary>, String> {
    thread::scope(|scope| {
        let list = &list;
        let queue = Arc::new(Mutex::new(hosts.into_iter().filter(|host| host.enabled).collect::<Vec<_>>()));
        let (sender, receiver) = mpsc::channel();
        for _ in 0..MAX_REMOTE_HOSTS.min(4).min(queue.lock().map(|items| items.len()).unwrap_or(0)) {
            let queue = queue.clone(); let sender = sender.clone();
            scope.spawn(move || loop {
                let host = queue.lock().ok().and_then(|mut items| items.pop());
                let Some(host) = host else { break };
                let _ = sender.send(list(&host));
            });
        }
        drop(sender);
        for mut remote in receiver.into_iter().flatten() { sessions.append(&mut remote); }
    });
    assign(&mut sessions)?;
    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at)); Ok(sessions)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn list_sessions(app: AppHandle, index: State<SessionIndexRuntime>) -> Result<Vec<SessionSummary>, String> { collect_sessions(&app, &index) }
