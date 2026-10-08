use std::path::Path;

pub(crate) fn recover_remote(host: &crate::RemoteHost) -> Result<(), String> {
    use crate::pi_launch::{remote_login_command, ssh};
    use crate::worktree_setup::{run_limited, shell_quote};
    let script = include_str!("../resources/restore-archived-worktree.bundle.mjs");
    let storage = crate::STORAGE_DIRECTORY;
    let command = format!("PIOP_STORAGE_DIRECTORY={storage} node -e {} -- --recover", shell_quote(script));
    let output = run_limited(ssh(host).arg(remote_login_command(&command)), 256 * 1024, "Could not recover session transactions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
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

fn operation_pending(root: &Path, name: &str, marker: &str) -> Result<bool, String> {
    let entries = match std::fs::read_dir(root.join(name)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        if entry.map_err(|error| error.to_string())?.path().join(marker).is_file() { return Ok(true); }
    }
    Ok(false)
}

fn legacy_pending(root: &Path) -> Result<bool, String> {
    if !root.exists() { return Ok(false); }
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        if entry.map_err(|error| error.to_string())?.file_name().to_string_lossy().starts_with("archive-transaction-") { return Ok(true); }
    }
    for area in ["sessions", "archived"] {
        for entry in walkdir::WalkDir::new(root.join(area)).follow_links(false).into_iter().filter_map(Result::ok) {
            if legacy_deletion_lock(&entry) { return Ok(true); }
        }
    }
    Ok(false)
}

fn legacy_deletion_lock(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    entry.file_type().is_dir() && name.starts_with(".delete-") && name.ends_with(".lock")
}

fn recovery_pending(root: &Path) -> Result<bool, String> {
    if restoration_pending(root)? { return Ok(true); }
    for (directory, marker) in [("archive-transactions", "pending.json"), ("delete-transactions", "recovery.json"), ("deleted-sessions", "recovery.json")] {
        if operation_pending(root, directory, marker)? { return Ok(true); }
    }
    legacy_pending(root)
}

pub(crate) fn recover(root: &Path) -> Result<(), String> {
    if !recovery_pending(root)? { return Ok(()); }
    let output = crate::node_command()
        .env("PIOP_RESTORE_ROOT", root)
        .args(["-e", include_str!("../resources/restore-archived-worktree.bundle.mjs"), "--", "--recover"])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("Session transaction recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(())
}
