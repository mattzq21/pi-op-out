use std::{collections::HashSet, fs, path::Path};
use super::{SessionGroups, SessionSeed};

fn normalize(key: &str) -> String {
    match key.rsplit_once(':') {
        Some((host, id)) => format!("{host}:{}", id.to_lowercase()),
        None => key.to_owned(),
    }
}

pub(super) fn known(path: &Path) -> Result<HashSet<String>, String> {
    match fs::read(path.with_extension("deletions.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Could not read permanent deletion metadata: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashSet::new()),
        Err(error) => Err(format!("Could not read permanent deletion metadata: {error}")),
    }
}

pub(super) fn contains(deleted: &HashSet<String>, key: &str) -> bool { deleted.contains(&normalize(key)) }

pub(super) fn prune(state: &mut SessionGroups, deleted: &HashSet<String>) -> bool {
    let previous = state.assignments.len();
    state.assignments.retain(|key, _| !contains(deleted, key));
    previous != state.assignments.len()
}

fn command(settings: &crate::AppSettings, host_id: &str) -> Result<std::process::Command, String> {
    let script = include_str!("../../../resources/session-registry.cjs");
    let request = r#"{"action":"deleted"}"#;
    if host_id == "local" {
        let mut command = crate::node_command();
        command.args(["-e", script, request]);
        return Ok(command);
    }
    let host = crate::remote_host(settings, host_id)?;
    let mut command = crate::ssh(host);
    let remote = format!("PIOP_STORAGE_DIRECTORY={} node -e {} {}", crate::shell_quote(crate::STORAGE_DIRECTORY), crate::shell_quote(script), crate::shell_quote(request));
    command.arg(crate::remote_login_command(&remote));
    Ok(command)
}

fn discover(settings: &crate::AppSettings, host_id: &str) -> Result<Vec<String>, String> {
    let output = crate::run_limited(&mut command(settings, host_id)?, 16 * 1024 * 1024, "Could not read permanent deletion metadata")?;
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
    let mut deleted = known(path)?;
    let previous = deleted.len();
    learn(settings, hosts(&state, seeds, key), &mut deleted);
    if deleted.len() != previous {
        let bytes = serde_json::to_vec(&deleted).map_err(|error| error.to_string())?;
        crate::atomic_write_private(&path.with_extension("deletions.json"), &bytes).map_err(|error| error.to_string())?;
    }
    if prune(&mut state, &deleted) { super::write(path, &state)?; }
    Ok(())
}

fn learn(settings: &crate::AppSettings, hosts: HashSet<String>, deleted: &mut HashSet<String>) {
    for host in hosts {
        match discover(settings, &host) {
            Ok(ids) => deleted.extend(ids.into_iter().map(|id| normalize(&format!("{host}:{id}")))),
            Err(error) => eprintln!("Permanent deletion metadata for {host} will be retried: {error}"),
        }
    }
}

pub(super) fn change_key(change: &super::GroupChange) -> Option<&str> {
    match change {
        super::GroupChange::Project { key, .. } => key.as_deref(),
        super::GroupChange::Relocate { key, .. } | super::GroupChange::Assign { key, .. } => Some(key),
        _ => None,
    }
}
