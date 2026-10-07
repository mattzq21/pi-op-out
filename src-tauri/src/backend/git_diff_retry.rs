use std::process::Command;
use std::sync::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use crate::{GitDiffSnapshot, MAX_GIT_DIFFS_BYTES, RemoteHost, STORAGE_DIRECTORY, node_command};
use crate::git_diffs::save_git_diffs_at_host;
use crate::pi_launch::{remote_login_command, ssh};
use crate::worktree_setup::{run_limited, shell_quote};

static RETRIES: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingDiff {
    turn_id: String,
    message_id: String,
}

fn pending_command(request: Value, host: Option<&RemoteHost>) -> Result<Value, String> {
    let script = include_str!("../../resources/capture-git-tree.cjs");
    let arguments = request.to_string();
    let mut command = if let Some(host) = host {
        let mut command = ssh(host);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments))));
        command
    } else {
        let mut command: Command = node_command();
        command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, &arguments]);
        command
    };
    let output = run_limited(&mut command, MAX_GIT_DIFFS_BYTES, "Could not recover pending project changes")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid pending project changes: {error}"))
}

pub(super) fn retain_pending_git_diff(packet: &Value, baseline: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let _guard = RETRIES.lock().map_err(|_| "Project changes retry lock was poisoned")?;
    pending_command(json!({"action":"retain","sessionPath":packet["sessionPath"],"turnId":packet["turnId"],
        "messageId":packet["messageId"],"baseline":baseline,"current":packet["current"]}), host)?;
    Ok(())
}

fn save_pending(session_path: &str, pending: &PendingDiff, host: Option<&RemoteHost>) -> Result<(), String> {
    let patch = pending_command(json!({"action":"diff","sessionPath":session_path,"turnId":pending.turn_id,
        "diffScript":include_str!("../../resources/capture-git-diff.bundle.mjs")}), host)?;
    if let Some(patch) = patch.as_str() {
        save_git_diffs_at_host(session_path, std::collections::HashMap::from([(pending.message_id.clone(), GitDiffSnapshot::Legacy(patch.into()))]), host)?;
    }
    pending_command(json!({"action":"ack","sessionPath":session_path,"turnId":pending.turn_id}), host)?;
    Ok(())
}

pub(super) fn retry_pending_git_diffs(session_path: &str, host: Option<&RemoteHost>) -> Result<bool, String> {
    let _guard = RETRIES.lock().map_err(|_| "Project changes retry lock was poisoned")?;
    let mut saved = false;
    loop {
        let next = pending_command(json!({"action":"next","sessionPath":session_path}), host)?;
        if next.is_null() { return Ok(saved); }
        let pending: PendingDiff = serde_json::from_value(next).map_err(|error| format!("Invalid pending project changes: {error}"))?;
        save_pending(session_path, &pending, host)?;
        saved = true;
    }
}
