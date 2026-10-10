use crate::platform::AppHandle;
use crate::{AppSettings, STORAGE_DIRECTORY, SessionIndexRuntime, node_command};

use crate::process_io::{LimitedOutput, run_limited, shell_quote};
use crate::pi_launch::{remote_host, remote_login_command, ssh};
use crate::settings::{load_app_settings};

pub(crate) fn archive_conversations(app: &AppHandle, host_id: &str, paths: &[String]) -> Result<(), String> {
    let _invalidate = app.state::<SessionIndexRuntime>().projects.invalidate_after(host_id);
    let settings = load_app_settings(app.clone())?;
    archive_command(&settings, host_id, &serde_json::json!({ "action": "archive", "paths": paths }))?;
    Ok(())
}


fn archive_command(settings: &AppSettings, host_id: &str, arguments: &serde_json::Value) -> Result<LimitedOutput, String> {
    let arguments = arguments.to_string();
    let script = include_str!("../resources/storage-transaction.bundle.mjs");
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, &arguments]); command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments)))); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not archive conversations")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    if !output.stderr.is_empty() { eprintln!("{}", String::from_utf8_lossy(&output.stderr).trim()); }
    Ok(output)
}
