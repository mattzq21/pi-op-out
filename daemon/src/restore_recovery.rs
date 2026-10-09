use std::path::Path;

pub(crate) fn recover_remote(host: &crate::RemoteHost) -> Result<(), String> {
    use crate::pi_launch::{remote_login_command, ssh};
    use crate::process_io::{run_limited, shell_quote};
    let script = include_str!("../resources/restore-session.bundle.mjs");
    let storage = crate::STORAGE_DIRECTORY;
    let command = format!("PIOP_STORAGE_DIRECTORY={storage} node -e {} -- --recover", shell_quote(script));
    let output = run_limited(ssh(host).arg(remote_login_command(&command)), 256 * 1024, "Could not recover session transactions")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(())
}

fn recovery_pending(root: &Path) -> Result<bool, String> {
    let database = crate::session_registry::open(root)?;
    database.query_row("SELECT EXISTS(SELECT 1 FROM session_publications) OR EXISTS(SELECT 1 FROM session_restorations) OR EXISTS(SELECT 1 FROM session_restore_receipts) OR EXISTS(SELECT 1 FROM deletion_records) OR EXISTS(SELECT 1 FROM archive_records WHERE record_json IS NULL OR (COALESCE(json_extract(record_json, '$.finished'), 0) != 1 AND COALESCE(json_extract(record_json, '$.state'), '') != 'planned'))", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

pub(crate) fn recover(root: &Path) -> Result<(), String> {
    if !recovery_pending(root)? { return Ok(()); }
    let output = crate::node_command()
        .env("PIOP_RESTORE_ROOT", root)
        .args(["-e", include_str!("../resources/restore-session.bundle.mjs"), "--", "--recover"])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("Session transaction recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(())
}
