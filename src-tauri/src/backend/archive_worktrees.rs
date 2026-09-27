fn archived_worktree_cwd(app: &AppHandle, host_id: &str, session_path: &str) -> Option<String> {
    let settings = load_app_settings(app.clone()).ok()?;
    let sessions = sessions_on_host(&settings, &app.state::<SessionIndexRuntime>(), host_id).ok()?;
    sessions.into_iter().find(|session| session.path == session_path).map(|session| session.cwd)
}

fn archive_worktree_command(settings: &AppSettings, host_id: &str, target: &WorktreeRemovalTarget, action: &str) -> Result<LimitedOutput, String> {
    let script = include_str!("../../resources/archive-worktree.cjs");
    let mut command = if host_id == "local" {
        let mut command = node_command();
        command.args(["-e", script, "--", action, &target.path, &target.source, STORAGE_DIRECTORY]); command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("node -e {} -- {} {} {} {}", shell_quote(script), shell_quote(action), shell_quote(&target.path), shell_quote(&target.source), shell_quote(STORAGE_DIRECTORY)))); command
    };
    run_limited(&mut command, 64 * 1024, "Could not clean up archived worktree")
}

fn cleanup_archived_worktree(app: &AppHandle, host_id: &str, cwd: &str) -> Result<(), String> {
    let settings = load_app_settings(app.clone())?;
    let Ok(target) = validated_removal_target(app, &settings, cwd, host_id) else { return Ok(()); };
    let eligible = archive_worktree_command(&settings, host_id, &target, "check")?;
    if eligible.stdout != b"eligible" { return Ok(()); }
    run_worktree_scripts(&settings, &target.source, &target.path, host_id, &AtomicBool::new(false), WorktreeScriptPhase::Cleanup)?;
    let target = validated_removal_target(app, &settings, cwd, host_id)?;
    preserve_worktree_checkpoints(&settings, host_id, &target)?;
    let removed = archive_worktree_command(&settings, host_id, &target, "remove")?;
    if !removed.status.success() { return Err(String::from_utf8_lossy(&removed.stderr).into_owned()); }
    Ok(())
}
