use std::path::Path;

pub(crate) fn recover_remote(host: &crate::RemoteHost) -> Result<(), String> {
    use crate::pi_launch::{remote_login_command, ssh};
    use crate::git_ops::worktree_setup::{run_limited, shell_quote};
    let script = include_str!("../resources/restore-archived-worktree.bundle.mjs");
    let storage = crate::STORAGE_DIRECTORY;
    let command = format!("PIOP_STORAGE_DIRECTORY={storage} node -e {} -- --recover", shell_quote(script));
    let output = run_limited(ssh(host).arg(remote_login_command(&command)), 256 * 1024, "Could not recover session transactions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(())
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
            if legacy_deletion_lock(&entry) || legacy_publication_temporary(&entry) { return Ok(true); }
        }
    }
    Ok(false)
}

fn legacy_deletion_lock(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    entry.file_type().is_dir() && name.starts_with(".delete-") && name.ends_with(".lock")
}

fn legacy_publication_temporary(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_file() { return false; }
    let name = entry.file_name().to_string_lossy();
    let Some((_, suffix)) = name.rsplit_once(".jsonl.") else { return false; };
    suffix.strip_suffix(".tmp").is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn recovery_pending(root: &Path) -> Result<bool, String> {
    let database = crate::session_registry::open(root)?;
    let publications: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM session_publications) OR EXISTS(SELECT 1 FROM session_restorations) OR EXISTS(SELECT 1 FROM session_restore_receipts)", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if publications { return Ok(true); }
    for (directory, marker) in [("archive-transactions", "pending.json"), ("delete-transactions", "recovery.json"), ("deleted-sessions", "recovery.json")] {
        if operation_pending(root, directory, marker)? { return Ok(true); }
    }
    legacy_pending(root)
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

fn released_snapshots_pending(root: &Path) -> Result<bool, String> {
    let db = crate::session_registry::open(root)?;
    db.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_reader_releases)", [], |row| row.get(0)).map_err(|error| error.to_string())
}

fn snapshot_cleanup_pending(root: &Path) -> Result<bool, String> {
    if released_snapshots_pending(root)? { return Ok(true); }
    let db = crate::session_registry::open(root)?;
    db.query_row("SELECT EXISTS(SELECT 1 FROM snapshot_directories)", [], |row| row.get(0)).map_err(|error| error.to_string())
}

pub(crate) fn recover(root: &Path) -> Result<(), String> {
    if !recovery_pending(root)? && !transaction_directories_pending(root)? && !snapshot_cleanup_pending(root)? { return Ok(()); }
    let output = crate::node_command()
        .env("PIOP_RESTORE_ROOT", root)
        .args(["-e", include_str!("../resources/restore-archived-worktree.bundle.mjs"), "--", "--recover"])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("Session transaction recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(())
}
