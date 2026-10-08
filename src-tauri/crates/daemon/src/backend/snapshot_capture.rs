use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;
use crate::{GitDiffSnapshot, MAX_GIT_CHANGED_PATHS, MAX_GIT_FILE_BYTES, MAX_GIT_PATCH_BYTES, MAX_GIT_PATH_LIST_BYTES, MAX_GIT_SNAPSHOT_BYTES, STORAGE_DIRECTORY, node_command};
use crate::worktree_setup::{GitSnapshotToken, run_limited};
use crate::environment::home_dir;

pub(super) fn git_root_and_objects(cwd: &str) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let requested = Path::new(cwd).canonicalize().map_err(|error| format!("Could not open project directory: {error}"))?;
    let output = run_limited(Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel", "--git-path", "objects"]), 64 * 1024, "Could not locate Git repository")?;
    if !output.status.success() { return Ok(None); }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines().map(str::to_owned);
    let root = PathBuf::from(lines.next().unwrap_or_default()).canonicalize().map_err(|error| format!("Could not resolve Git root: {error}"))?;
    let objects = PathBuf::from(lines.next().unwrap_or_default());
    let objects = if objects.is_absolute() { objects } else { requested.join(objects) }.canonicalize().map_err(|error| format!("Could not resolve Git objects: {error}"))?;
    Ok(Some((root, objects)))
}

pub(super) fn local_git_input_is_bounded(cwd: &str, root: &Path) -> Result<bool, String> {
    let mut output = run_limited(Command::new("git").args(["-C", cwd, "ls-files", "-z", "-m", "-o", "--exclude-standard", "--"]), MAX_GIT_PATH_LIST_BYTES, "Could not inspect Git changes")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let staged = run_limited(Command::new("git").args(["-C", cwd, "diff", "--cached", "--name-only", "-z", "--"]), MAX_GIT_PATH_LIST_BYTES, "Could not inspect staged changes")?;
    if !staged.status.success() { return Err(String::from_utf8_lossy(&staged.stderr).into_owned()); } output.stdout.extend(staged.stdout);
    let mut seen = HashSet::new(); let mut total = 0u64; let mut count = 0usize;
    for raw in output.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
        if !seen.insert(raw) { continue; }
        count += 1; if count > MAX_GIT_CHANGED_PATHS { return Ok(false); }
        let relative = String::from_utf8_lossy(raw); let path = root.join(relative.as_ref());
        let Ok(metadata) = fs::symlink_metadata(path) else { continue };
        let size = metadata.len(); if size > MAX_GIT_FILE_BYTES { return Ok(false); }
        total = total.saturating_add(size); if total > MAX_GIT_SNAPSHOT_BYTES { return Ok(false); }
    }
    Ok(true)
}

fn local_snapshot_parent() -> Result<PathBuf, String> {
    let parent = home_dir()?.join(STORAGE_DIRECTORY).join("git-snapshots"); fs::create_dir_all(&parent).map_err(|error| error.to_string())?; Ok(parent)
}

pub(super) fn parse_local_snapshot(token: &str) -> Result<GitSnapshotToken, String> {
    parse_local_snapshot_with(token, local_snapshot_parent)
}

pub(super) fn parse_local_snapshot_with(token: &str, parent: impl FnOnce() -> Result<PathBuf, String>) -> Result<GitSnapshotToken, String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(token).map_err(|_| "Invalid Git snapshot token".to_string())?;
    if snapshot.tree.len() < 40 || snapshot.tree.len() > 64 || !snapshot.tree.chars().all(|character| character.is_ascii_hexdigit()) { return Err("Invalid Git snapshot tree".into()); }
    let parent = parent()?.canonicalize().map_err(|error| error.to_string())?;
    let root = PathBuf::from(&snapshot.root).canonicalize().map_err(|_| "Git snapshot expired".to_string())?;
    if root.parent() != Some(parent.as_path()) || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-")) { return Err("Invalid Git snapshot location".into()); }
    Ok(GitSnapshotToken { root: root.to_string_lossy().into_owned(), ..snapshot })
}

pub(super) fn local_git_tree(cwd: &str) -> Result<Option<String>, String> { local_git_tree_with(cwd, local_snapshot_parent) }

#[cfg(test)]
pub(super) fn validate_snapshot_location(snapshot: GitSnapshotToken, parent: &Path) -> Result<GitSnapshotToken, String> {
    let root = PathBuf::from(&snapshot.root).canonicalize().map_err(|_| "Git snapshot expired".to_string())?;
    if root.parent() != Some(parent) || !root.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-")) { return Err("Invalid Git snapshot location".into()); }
    Ok(GitSnapshotToken { root: root.to_string_lossy().into_owned(), ..snapshot })
}

pub(super) fn local_git_tree_with(cwd: &str, parent: impl FnOnce() -> Result<PathBuf, String>) -> Result<Option<String>, String> {
    let Some((root, repository_objects)) = git_root_and_objects(cwd)? else { return Ok(None) };
    let cwd = root.to_str().ok_or("Git root is not valid UTF-8")?;
    if !local_git_input_is_bounded(cwd, &root)? { return Ok(None); }
    let snapshot_parent = parent()?;
    capture_local_git_tree(&root, &repository_objects, &snapshot_parent).map(Some)
}

pub(super) fn capture_local_git_tree(root: &Path, repository_objects: &Path, snapshot_parent: &Path) -> Result<String, String> {
    let cwd = root.to_str().ok_or("Git root is not valid UTF-8")?;
    let snapshot_root = snapshot_parent.join(format!("pi-desktop-diff-{}", Uuid::new_v4()));
    let objects = snapshot_root.join("objects"); let index = snapshot_root.join("index");
    let seed = run_limited(Command::new("git").args(["-C", cwd, "write-tree"]), 64 * 1024, "Could not read project index")?;
    if !seed.status.success() { return Err(String::from_utf8_lossy(&seed.stderr).into_owned()); }
    let seed = String::from_utf8_lossy(&seed.stdout).trim().to_owned();
    fs::create_dir_all(&objects).map_err(|error| format!("Could not create Git snapshot: {error}"))?;
    let result = (|| {
        own_local_snapshot(&snapshot_root)?;
        let configure = |command: &mut Command| { command.env("GIT_INDEX_FILE", &index).env("GIT_OBJECT_DIRECTORY", &objects).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", repository_objects); };
        let mut read_tree = Command::new("git"); read_tree.args(["-C", cwd, "read-tree", &seed]); configure(&mut read_tree);
        let output = run_limited(&mut read_tree, 64 * 1024, "Could not prepare Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let mut add = Command::new("git"); add.args(["-C", cwd, "add", "-A", "--", "."]); configure(&mut add);
        let output = run_limited(&mut add, 64 * 1024, "Could not capture Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let mut write_tree = Command::new("git"); write_tree.args(["-C", cwd, "write-tree"]); configure(&mut write_tree);
        let output = run_limited(&mut write_tree, 64 * 1024, "Could not finalize Git snapshot")?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let tree = String::from_utf8_lossy(&output.stdout).trim().to_string();
        fs::remove_file(&index).map_err(|error| format!("Could not remove temporary Git index: {error}"))?;
        local_snapshot_metadata(&snapshot_root, &tree, cwd)?;
        serde_json::to_string(&GitSnapshotToken { root: snapshot_root.to_string_lossy().into_owned(), tree, repository_root: cwd.to_owned() }).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&snapshot_root); }
    result
}

fn own_local_snapshot(root: &Path) -> Result<(), String> {
    let pid = std::process::id();
    let identity = fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| stat.rsplit_once(") ").and_then(|(_, fields)| fields.split_whitespace().nth(19).map(str::to_owned)));
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|value| value.trim().to_owned());
    let owner = serde_json::json!({"version":1,"state":"external","boot":boot,"processes":[{"pid":pid,"identity":identity}]});
    crate::private_fs::atomic_write_private(&root.join("temporary-owner.json"), &serde_json::to_vec(&owner).map_err(|error| error.to_string())?)
}

fn local_snapshot_metadata(root: &Path, tree: &str, cwd: &str) -> Result<(), String> {
    let saved = serde_json::to_vec(&serde_json::json!({"tree":tree,"repositoryRoot":cwd})).map_err(|error| error.to_string())?;
    crate::private_fs::atomic_write_private(&root.join("snapshot.json"), &saved)
}

pub(super) fn local_git_diff(cwd: &str, base_token: &str) -> Result<Option<GitDiffSnapshot>, String> {
    local_git_diff_with(cwd, base_token, parse_local_snapshot, local_git_tree)
}

pub(super) fn local_git_diff_with(cwd: &str, base_token: &str,
    mut parse: impl FnMut(&str) -> Result<GitSnapshotToken, String>,
    capture: impl FnOnce(&str) -> Result<Option<String>, String>) -> Result<Option<GitDiffSnapshot>, String> {
    let base = parse(base_token)?;
    let Some(current_token) = capture(cwd)? else { let _ = fs::remove_dir_all(&base.root); return Ok(None) };
    let current = parse(&current_token)?;
    let result = local_git_diff_between(cwd, &base, &current);
    let _ = fs::remove_dir_all(&base.root); let _ = fs::remove_dir_all(&current.root); result
}

pub(super) fn local_git_diff_between(cwd: &str, base: &GitSnapshotToken, current: &GitSnapshotToken) -> Result<Option<GitDiffSnapshot>, String> {
    let (_, repository_objects) = git_root_and_objects(cwd)?.ok_or("The comparison repository is unavailable")?;
    let alternates = std::env::join_paths([Path::new(&base.root).join("objects"), repository_objects]).map_err(|error| error.to_string())?;
    let mut command = node_command(); command.current_dir(&current.repository_root).args(["-e", include_str!("../../../../resources/capture-git-diff.bundle.mjs"), &base.tree, &current.tree])
        .env("GIT_OBJECT_DIRECTORY", Path::new(&current.root).join("objects")).env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates);
    let output = run_limited(&mut command, MAX_GIT_PATCH_BYTES, "Git patch is too large")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot::Located { patch, repository_root: String::new(), tool_paths: Vec::new() }))
}
