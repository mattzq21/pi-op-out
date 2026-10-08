use serde_json::Value;
use crate::platform::AppHandle;
use crate::{STORAGE_DIRECTORY, node_command};

use crate::git_ops::worktree_setup::{run_limited, shell_quote};
use crate::pi_launch::{remote_host, remote_login_command, ssh};
use crate::settings::{load_app_settings};

pub(crate) fn project_branches(app: AppHandle, cwd: String, host_id: Option<String>, branch: Option<String>) -> Result<Value, String> {
    let _invalidate = branch.as_deref().filter(|branch| !branch.is_empty()).map(|_| app.state::<crate::SessionIndexRuntime>().projects.invalidate_after(host_id.as_deref().unwrap_or("local")));
    let settings = load_app_settings(app)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    let script = include_str!("../../resources/project-branches.cjs");
    let selected = branch.as_deref().unwrap_or("");
    let mut command = if host_id == "local" {
        let mut command = node_command(); command.args(["-e", script, "--", &cwd, STORAGE_DIRECTORY, selected]); command
    } else {
        let mut command = ssh(remote_host(&settings, host_id)?);
        command.arg(remote_login_command(&format!("node -e {} -- {} {} {}", shell_quote(script), shell_quote(&cwd), shell_quote(STORAGE_DIRECTORY), shell_quote(selected)))); command
    };
    let output = run_limited(&mut command, 4 * 1024 * 1024, "Could not inspect project branches")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().into()); }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

pub(crate) fn branch_is_missing(settings: &crate::AppSettings, cwd: &str, host_id: &str, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    let script = format!("git -C {} rev-parse --git-dir >/dev/null 2>&1 || exit 2; git -C {} show-ref --verify --quiet {} && exit 0; [ $? -eq 1 ] || exit 2; printf branch-missing", shell_quote(cwd), shell_quote(cwd), shell_quote(&reference));
    let mut command = if host_id == "local" {
        let mut command = std::process::Command::new("sh"); command.args(["-c", &script]); command
    } else {
        let Ok(host) = remote_host(settings, host_id) else { return false; };
        let mut command = ssh(host); command.arg(remote_login_command(&script)); command
    };
    run_limited(&mut command, 64 * 1024, "Could not check group branch").is_ok_and(|output| output.status.success() && output.stdout == b"branch-missing")
}
