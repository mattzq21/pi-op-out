use std::path::Path;

pub(crate) fn recover_remote(host: &crate::RemoteHost) -> Result<(), String> {
    use crate::pi_launch::{remote_login_command, ssh};
    use crate::worktree_setup::{run_limited, shell_quote};
    let script = include_str!("../resources/restore-archived-worktree.bundle.mjs");
    let storage = crate::STORAGE_DIRECTORY;
    let command = format!("for pending in \"$HOME/{storage}/restore-transactions/\"*.json; do [ -f \"$pending\" ] || continue; PIOP_STORAGE_DIRECTORY={storage} node -e {} -- --recover; exit $?; done", shell_quote(script));
    let output = run_limited(ssh(host).arg(remote_login_command(&command)), 64 * 1024, "Could not recover session restoration")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    Ok(())
}

pub(crate) fn recover(root: &Path) -> Result<(), String> {
    let directory = root.join("restore-transactions");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut pending = false;
    for entry in entries {
        if entry.map_err(|error| error.to_string())?.path().extension().is_some_and(|extension| extension == "json") { pending = true; break; }
    }
    if !pending { return Ok(()); }
    let output = crate::node_command()
        .env("PIOP_RESTORE_ROOT", root)
        .args(["-e", include_str!("../resources/restore-archived-worktree.bundle.mjs"), "--", "--recover"])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("Session restore recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}
