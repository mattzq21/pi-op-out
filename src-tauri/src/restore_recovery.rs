use std::path::Path;

pub(crate) fn recover_remote(host: &crate::RemoteHost) -> Result<(), String> {
    use crate::pi_launch::{remote_login_command, ssh};
    use crate::worktree_setup::{run_limited, shell_quote};
    let script = include_str!("../resources/restore-archived-worktree.bundle.mjs");
    let storage = crate::STORAGE_DIRECTORY;
    let command = format!(r#"piopPending=; for candidate in "$HOME/{storage}/restore-transactions/"*.json "$HOME/{storage}/fork-transactions/"* "$HOME/{storage}/fork-transactions/".cleanup-* "$HOME/{storage}/fork-preparations/"* "$HOME/{storage}/fork-preparations/".cleanup-* "$HOME/{storage}/archive-transaction-"* "$HOME/{storage}/deleted-sessions/"*; do [ ! -e "$candidate" ] || piopPending=1; done; for area in sessions archived; do [ -d "$HOME/{storage}/$area" ] || continue; candidate=$(find "$HOME/{storage}/$area" -type d -name '*.snapshots' -prune -o -type d -name '.delete-*.lock' -print -quit) || exit $?; [ -z "$candidate" ] || piopPending=1; done; [ -n "$piopPending" ] || exit 0; PIOP_STORAGE_DIRECTORY={storage} node -e {} -- --recover"#, shell_quote(script));
    let output = run_limited(ssh(host).arg(remote_login_command(&command)), 64 * 1024, "Could not recover session storage")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    Ok(())
}

fn restoration_pending(root: &Path) -> Result<bool, String> {
    let directory = root.join("restore-transactions");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let mut pending = false;
    for entry in entries {
        if entry.map_err(|error| error.to_string())?.path().extension().is_some_and(|extension| extension == "json") { pending = true; break; }
    }
    Ok(pending)
}

fn archive_pending(root: &Path) -> Result<bool, String> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map_err(|error| error.to_string())?.is_dir() && entry.file_name().to_string_lossy().starts_with("archive-transaction-") { return Ok(true); }
    }
    Ok(false)
}

fn deletion_pending(root: &Path, area: &str) -> Result<bool, String> {
    let directory = root.join(area);
    if !directory.try_exists().map_err(|error| error.to_string())? { return Ok(false); }
    let entries = walkdir::WalkDir::new(directory).min_depth(1).follow_links(false).into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().ends_with(".snapshots"));
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_dir() { continue; }
        let name = entry.file_name().to_string_lossy();
        if area == "deleted-sessions" || (name.starts_with(".delete-") && name.ends_with(".lock")) { return Ok(true); }
    }
    Ok(false)
}

fn fork_publication_pending(root: &Path, area: &str) -> Result<bool, String> {
    match std::fs::read_dir(root.join(area)) {
        Ok(mut entries) => entries.next().transpose().map(|entry| entry.is_some()).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn transaction_directories_pending(root: &Path) -> Result<bool, String> {
    if archive_pending(root)? || fork_publication_pending(root, "fork-transactions")? || fork_publication_pending(root, "fork-preparations")? { return Ok(true); }
    for area in ["sessions", "archived", "deleted-sessions"] {
        if deletion_pending(root, area)? { return Ok(true); }
    }
    Ok(false)
}

pub(crate) fn recover(root: &Path) -> Result<(), String> {
    if !restoration_pending(root)? && !transaction_directories_pending(root)? { return Ok(()); }
    let output = crate::node_command()
        .env("PIOP_RESTORE_ROOT", root)
        .args(["-e", include_str!("../resources/restore-archived-worktree.bundle.mjs"), "--", "--recover"])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("Session storage recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}
