use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use crate::platform::AppHandle;
use crate::{GitDiffSnapshot, GitDiffSnapshots, MAX_GIT_DIFFS_BYTES, MAX_GIT_PATCH_BYTES, RemoteHost, STORAGE_DIRECTORY, conversation_ownership};
use crate::archives::{local_desktop_session_file_at};
use crate::worktree_setup::{GitSnapshotToken, ensure_desktop_sessions_dir, run_limited, shell_quote};
use crate::pi_launch::{remote_login_command, saved_remote_host, ssh};
use crate::defaults_usage::{home_dir};
use crate::settings_storage::{atomic_write_private};
use crate::snapshot_capture::{local_git_diff, local_git_diff_between, local_git_tree, parse_local_snapshot};

pub(super) fn valid_remote_snapshot(snapshot: &GitSnapshotToken) -> bool {
    let path = Path::new(&snapshot.root);
    path.is_absolute()
        && path.components().all(|component| matches!(component, std::path::Component::RootDir | std::path::Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-"))
        && snapshot.tree.len() >= 40 && snapshot.tree.len() <= 64 && snapshot.tree.chars().all(|character| character.is_ascii_hexdigit())
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let script = format!("cd {} && PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {}", shell_quote(cwd), shell_quote(include_str!("../../resources/capture-git-tree.cjs")));
    let mut command = ssh(host); command.arg(remote_login_command(&script));
    query_remote_git_tree(&mut command, &host.name)
}

pub(super) fn query_remote_git_tree(command: &mut Command, host_name: &str) -> Result<Option<String>, String> {
    let output = run_limited(command, 64 * 1024, &format!("Could not capture Git snapshot on {host_name}"))?;
    if let Some(3 | 4 | 6) = output.status.code() { return Ok(None) }
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let snapshot: GitSnapshotToken = serde_json::from_slice(&output.stdout).map_err(|error| format!("Remote Git snapshot was invalid: {error}"))?;
    if !valid_remote_snapshot(&snapshot) || !Path::new(&snapshot.repository_root).is_absolute() { return Err("Remote Git snapshot was invalid".into()); }
    serde_json::to_string(&snapshot).map(Some).map_err(|error| error.to_string())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn capture_git_tree(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    capture_git_tree_at_host(&cwd, saved_remote_host(app, host_id)?.as_ref())
}

fn capture_git_tree_at_host(cwd: &str, host: Option<&RemoteHost>) -> Result<Option<String>, String> {
    match host { Some(host) => remote_git_tree(host, cwd), None => local_git_tree(cwd) }
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn discard_git_tree(app: AppHandle, snapshot: String, host_id: Option<String>) -> Result<(), String> {
    discard_git_tree_at_host(&snapshot, saved_remote_host(app, host_id)?.as_ref())
}

pub(super) fn discard_git_tree_at_host(snapshot: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let Some(host) = host else { let snapshot = parse_local_snapshot(snapshot)?; return fs::remove_dir_all(snapshot.root).map_err(|error| format!("Could not discard Git snapshot: {error}")); };
    discard_remote_git_tree(snapshot, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn discard_remote_git_tree(snapshot: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(snapshot).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&snapshot) { return Err("Invalid remote Git snapshot location".into()); }
    let root = shell_quote(&snapshot.root);
    let script = format!("parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; snap=$(cd {root} && pwd -P) || exit 7; [ \"$(dirname -- \"$snap\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snap\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; rm -rf -- \"$snap\"");
    let output = command(script).output().map_err(|error| format!("Could not discard Git snapshot on {host_name}: {error}"))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<GitDiffSnapshot>, String> {
    load_git_diff_at_host(&cwd, &base_tree, saved_remote_host(app, host_id)?.as_ref())
}

pub(super) fn load_git_diff_at_host(cwd: &str, base_tree: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff(cwd, base_tree); };
    load_remote_git_diff_with(base_tree,
        || remote_git_tree(host, cwd),
        |base_tree, current_token| load_git_diff_between_at_host(cwd, base_tree, current_token, Some(host)),
        |token| discard_git_tree_at_host(token, Some(host)))
}

pub(super) fn load_remote_git_diff_with(base_tree: &str,
    capture: impl FnOnce() -> Result<Option<String>, String>,
    diff: impl FnOnce(&str, &str) -> Result<Option<GitDiffSnapshot>, String>,
    mut discard: impl FnMut(&str) -> Result<(), String>,
) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) { return Err("Invalid remote Git snapshot location".into()); }
    let Some(current_token) = capture()? else { return Ok(None) };
    let result = diff(base_tree, &current_token);
    let _ = discard(base_tree);
    let _ = discard(&current_token);
    result
}

pub(super) fn load_git_diff_between_at_host(cwd: &str, base_tree: &str, current_token: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff_between(cwd, &parse_local_snapshot(base_tree)?, &parse_local_snapshot(current_token)?); };
    load_remote_git_diff_between(base_tree, current_token, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn load_remote_git_diff_between(base_tree: &str, current_token: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    let current: GitSnapshotToken = serde_json::from_str(current_token).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) || !valid_remote_snapshot(&current) { return Err("Invalid remote Git snapshot location".into()); }
    let script = format!("cd {} || exit 2; parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; base=$(cd {} && pwd -P) || exit 7; current=$(cd {} && pwd -P) || exit 7; for snapshot in \"$base\" \"$current\"; do [ \"$(dirname -- \"$snapshot\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snapshot\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; done; repo_objects=$(git rev-parse --git-path objects) || exit 3; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 3; GIT_OBJECT_DIRECTORY=\"$current/objects\" GIT_ALTERNATE_OBJECT_DIRECTORIES=\"$base/objects:$repo_objects\" git diff --no-relative --no-color --no-ext-diff --find-renames {} {} --", shell_quote(&current.repository_root), shell_quote(&base.root), shell_quote(&current.root), shell_quote(&base.tree), shell_quote(&current.tree));
    let output = run_limited(&mut command(script), MAX_GIT_PATCH_BYTES, &format!("Git patch on {host_name} is too large"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot::Located { patch, repository_root: current.repository_root, tool_paths: Vec::new() }))
}

pub(super) fn remote_session_sidecar_script(session_path: &str, action: &str) -> String {
    format!("session=$(readlink -f -- {}) || exit 7; sessions=$(cd \"$HOME/{STORAGE_DIRECTORY}/sessions\" && pwd -P) || exit 7; case \"$session\" in \"$sessions\"/*.jsonl) ;; *) exit 7;; esac; sidecar=${{session%.jsonl}}.diffs.json; {action}", shell_quote(session_path))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>) -> Result<GitDiffSnapshots, String> {
    load_git_diffs_at_host(&session_path, saved_remote_host(app, host_id)?.as_ref())
}

fn validate_unsaved_session(home: &Path, candidate: &Path) -> Result<(), String> {
        let root = ensure_desktop_sessions_dir(home)?.canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
        let parent = candidate.parent().ok_or("Session path has no parent directory")?.canonicalize().map_err(|error| format!("Could not locate session directory: {error}"))?;
        if !candidate.is_absolute() || !parent.starts_with(&root) || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") { return Err("Only piop session files can be accessed".into()); }
        Ok(())
}

pub(super) fn load_local_git_diffs(home: &Path, session_path: &str) -> Result<GitDiffSnapshots, String> {
    let candidate = PathBuf::from(session_path);
    if !candidate.exists() {
        validate_unsaved_session(home, &candidate)?;
        return Ok(HashMap::new());
    }
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    if !path.exists() { return Ok(HashMap::new()); }
    if fs::metadata(&path).map_err(|error| format!("Could not inspect saved diffs: {error}"))?.len() > MAX_GIT_DIFFS_BYTES as u64 { return Err("Saved diffs exceed the 16 MiB limit".into()); }
    let content = fs::read_to_string(&path).map_err(|error| format!("Could not read saved diffs: {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

pub(super) fn load_git_diffs_at_host(session_path: &str, host: Option<&RemoteHost>) -> Result<GitDiffSnapshots, String> {
    let content = if let Some(host) = host {
        let mut command = ssh(host); command.arg(remote_session_sidecar_script(session_path, "if [ -f \"$sidecar\" ]; then cat -- \"$sidecar\"; else printf '{}'; fi"));
        return query_remote_git_diffs(&mut command, &host.name);
    } else {
        let snapshots = load_local_git_diffs(&home_dir()?, session_path)?;
        serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

pub(super) fn query_remote_git_diffs(command: &mut Command, host_name: &str) -> Result<GitDiffSnapshots, String> {
    let content = {
        let output = run_limited(command, MAX_GIT_DIFFS_BYTES, &format!("Saved diffs on {host_name} exceed the limit"))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        String::from_utf8(output.stdout).map_err(|_| "Saved remote diffs were not valid UTF-8".to_string())?
    };
    serde_json::from_str(&content).map_err(|error| format!("Could not parse saved diffs: {error}"))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>, client_id: String) -> Result<(), String> {
    let mutation = conversation_ownership::MutationGuard::acquire(&app, host_id.as_deref().unwrap_or("local"), &session_path, &client_id, false, "save_diffs")?;
    save_git_diffs_at_host(&session_path, snapshots, saved_remote_host(app, host_id)?.as_ref())?;
    mutation.finish()
}

pub(super) fn save_git_diffs_at_host(session_path: &str, snapshots: GitDiffSnapshots, host: Option<&RemoteHost>) -> Result<(), String> {
    let body = serde_json::to_string(&snapshots).map_err(|error| format!("Could not serialize diffs: {error}"))?;
    if body.len() > MAX_GIT_DIFFS_BYTES { return Err("Diff history exceeds the 16 MiB limit".into()); }
    let Some(host) = host else { return save_local_git_diffs(&home_dir()?, session_path, &body); };
    let mut command = ssh(host); command.arg(remote_save_git_diffs_script(session_path));
    write_remote_git_diffs(&mut command, &body)
}

pub(super) fn save_local_git_diffs(home: &Path, session_path: &str, body: &str) -> Result<(), String> {
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    atomic_write_private(&path, body.as_bytes()).map_err(|error| format!("Could not save diffs: {error}"))
}

pub(super) fn remote_save_git_diffs_script(session_path: &str) -> String {
    remote_session_sidecar_script(session_path, "umask 077; temporary=$(mktemp \"$sidecar.XXXXXX\") || exit 1; trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\" && chmod 600 -- \"$temporary\" && mv -f -- \"$temporary\" \"$sidecar\"")
}

pub(super) fn write_remote_git_diffs(command: &mut Command, body: &str) -> Result<(), String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let write = child.stdin.take().ok_or("SSH stdin unavailable")?.write_all(body.as_bytes());
    let output = child.wait_with_output().map_err(|e| e.to_string())?; write.map_err(|e| e.to_string())?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}
