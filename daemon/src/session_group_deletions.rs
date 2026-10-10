use std::{collections::HashSet, path::Path};
use super::{SessionGroups, SessionSeed};

fn command(settings: &crate::AppSettings, host_id: &str) -> Result<std::process::Command, String> {
    let script = crate::session_registry::source();
    let request = r#"{"action":"ids"}"#;
    if host_id == "local" {
        let mut command = crate::node_command();
        command.args(["-e", &script, request]);
        return Ok(command);
    }
    let host = crate::remote_host(settings, host_id)?;
    let mut command = crate::ssh(host);
    let remote = format!("PIOP_STORAGE_DIRECTORY={} node -e {} {}", crate::shell_quote(crate::STORAGE_DIRECTORY), crate::shell_quote(&script), crate::shell_quote(request));
    command.arg(crate::remote_login_command(&remote));
    Ok(command)
}

fn discover(settings: &crate::AppSettings, host_id: &str) -> Result<Vec<String>, String> {
    let output = crate::run_limited(&mut command(settings, host_id)?, 16 * 1024 * 1024, "Could not read current session IDs")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn hosts(state: &SessionGroups, seeds: &[SessionSeed], key: Option<&str>) -> HashSet<String> {
    let mut hosts: HashSet<String> = state.assignments.keys().chain(seeds.iter().map(|seed| &seed.session_key))
        .filter_map(|key| key.rsplit_once(':').map(|(host, _)| host.to_owned())).collect();
    if let Some((host, _)) = key.and_then(|key| key.rsplit_once(':')) { hosts.insert(host.to_owned()); }
    hosts.insert("local".into());
    hosts
}

pub(super) fn refresh(path: &Path, settings: &crate::AppSettings, seeds: &[SessionSeed], key: Option<&str>) -> Result<(), String> {
    let _lock = super::lock_storage(path)?;
    let mut state = super::read(path)?.unwrap_or_default();
    let previous = state.assignments.len();
    for host in hosts(&state, seeds, key) {
        match discover(settings, &host) {
            Ok(ids) => {
                let live: HashSet<_> = ids.into_iter().collect();
                let prefix = format!("{host}:");
                state.assignments.retain(|key, _| key.strip_prefix(&prefix).is_none_or(|id| live.contains(id)));
            }
            Err(error) => eprintln!("Session group cleanup for {host} will retry: {error}"),
        }
    }
    if previous != state.assignments.len() { super::write(path, &state)?; }
    Ok(())
}

pub(super) fn change_key(change: &super::GroupChange) -> Option<&str> {
    match change {
        super::GroupChange::Project { key, .. } => key.as_deref(),
        super::GroupChange::Relocate { key, .. } | super::GroupChange::Assign { key, .. } => Some(key),
        _ => None,
    }
}
