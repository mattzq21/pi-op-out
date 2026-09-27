use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use crate::platform::AppHandle;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[path = "session_groups_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub cwd: Option<String>,
    pub host_id: Option<String>,
    pub host_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_kind: Option<super::ProjectKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_appearance: Option<serde_json::Value>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroups {
    pub groups: Vec<SessionGroup>,
    pub assignments: HashMap<String, Option<String>>,
    pub removed_projects: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSeed {
    pub session_key: String,
    pub project: SessionGroup,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GroupChange {
    Create { name: String },
    Project { project: SessionGroup, key: Option<String> },
    Relocate { project: SessionGroup, key: String },
    InspectProject { id: String, #[serde(rename = "projectKind")] project_kind: super::ProjectKind },
    Rename { id: String, name: String },
    Remove { id: String },
    Assign { key: String, group: Option<String> },
}

fn storage_path() -> Result<PathBuf, String> {
    Ok(super::ensure_desktop_sessions_dir(&super::home_dir()?)?.join("groups.json"))
}

fn lock_storage(path: &Path) -> Result<fs::File, String> {
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path.with_extension("lock")).map_err(|error| error.to_string())?;
    file.lock().map_err(|error| format!("Could not lock session groups: {error}"))?;
    Ok(file)
}

fn read(path: &Path) -> Result<Option<SessionGroups>, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice(&body).map(Some).map_err(|error| format!("Could not read session groups: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read session groups: {error}")),
    }
}

fn write(path: &Path, groups: &SessionGroups) -> Result<(), String> {
    super::atomic_write_private(path, &serde_json::to_vec_pretty(groups).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Could not save session groups: {error}"))
}

pub fn attach_assignments(sessions: &mut [super::SessionSummary]) -> Result<(), String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    attach_assignments_at(sessions, &storage_path()?)
}

fn attach_assignments_at(sessions: &mut [super::SessionSummary], path: &Path) -> Result<(), String> {
    if let Some(state) = read(path)? {
        for session in sessions {
            session.group_id = state.assignments.get(&format!("{}:{}", session.host_id, session.id)).cloned().flatten();
        }
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn load_session_groups(app: AppHandle, seeds: Vec<SessionSeed>, legacy: SessionGroups) -> Result<SessionGroups, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = storage_path()?;
    let mut state = load_at(&path, seeds, legacy)?;
    prune_missing_branch_groups(&app, &path, &mut state)?;
    Ok(state)
}

fn prune_missing_branch_groups(app: &AppHandle, path: &Path, state: &mut SessionGroups) -> Result<(), String> {
    let _file_lock = lock_storage(path)?;
    if let Some(latest) = read(path)? { *state = latest; }
    let settings = super::load_app_settings(app.clone())?;
    let index = app.state::<super::SessionIndexRuntime>();
    let mut sessions = HashMap::new();
    let mut removed = HashSet::new();
    for group in &state.groups {
        let Some(branch) = group.branch.as_deref() else { continue; };
        let host = group.host_id.as_deref().unwrap_or("local");
        let listed = sessions.entry(host.to_owned()).or_insert_with(|| super::sessions_on_host(&settings, &index, host));
        let Ok(listed) = listed else { continue; };
        if group_has_sessions(state, group, listed) { continue; }
        if branch_is_missing(&settings, group, branch) { removed.insert(group.id.clone()); }
    }
    if removed.is_empty() { return Ok(()); }
    state.groups.retain(|group| !removed.contains(&group.id));
    state.assignments.retain(|_, group| !group.as_ref().is_some_and(|id| removed.contains(id)));
    write(path, state)?;
    let _ = app.emit("pi://groups-changed", &*state);
    Ok(())
}

fn group_has_sessions(state: &SessionGroups, group: &SessionGroup, sessions: &[super::SessionSummary]) -> bool {
    sessions.iter().any(|session| {
        let key = format!("{}:{}", session.host_id, session.id);
        state.assignments.get(&key).and_then(|id| id.as_deref()) == Some(group.id.as_str())
    })
}

fn branch_is_missing(settings: &super::AppSettings, group: &SessionGroup, branch: &str) -> bool {
    let Some(cwd) = group.cwd.as_deref() else { return false; };
    let reference = format!("refs/heads/{branch}");
    let script = format!("git -C {} rev-parse --git-dir >/dev/null 2>&1 || exit 2; git -C {} show-ref --verify --quiet {} && exit 0; [ $? -eq 1 ] || exit 2; printf branch-missing", super::shell_quote(cwd), super::shell_quote(cwd), super::shell_quote(&reference));
    let host_id = group.host_id.as_deref().unwrap_or("local");
    let mut command = if host_id == "local" {
        let mut command = std::process::Command::new("sh"); command.args(["-c", &script]); command
    } else {
        let Ok(host) = super::remote_host(settings, host_id) else { return false; };
        let mut command = super::ssh(host); command.arg(super::remote_login_command(&script)); command
    };
    super::run_limited(&mut command, 64 * 1024, "Could not check group branch").is_ok_and(|output| output.status.success() && output.stdout == b"branch-missing")
}

fn migrate_group_names(state: &mut SessionGroups) -> bool {
    let mut dirty = false;
    for group in &mut state.groups {
        if group.name != "Workspace" { continue; }
        let Some(cwd) = group.cwd.as_deref() else { continue; };
        if !cwd.ends_with('/') || group.id != format!("{}:{cwd}", group.host_id.as_deref().unwrap_or("local")) { continue; }
        if let Some(name) = cwd.rsplit('/').find(|part| !part.is_empty()) {
            if name != group.name { group.name = name.to_owned(); dirty = true; }
        }
    }
    dirty
}

fn update_seed_metadata(state: &mut SessionGroups, seed: &SessionSeed) -> bool {
    let mut dirty = false;
    for group in state.groups.iter_mut().filter(|group| group.host_id == seed.project.host_id) {
        if group.host_name != seed.project.host_name { group.host_name = seed.project.host_name.clone(); dirty = true; }
        if group.id == seed.project.id && seed.project.project_kind.is_some() && group.project_kind != seed.project.project_kind { group.project_kind = seed.project.project_kind; dirty = true; }
        if group.id == seed.project.id && group.branch != seed.project.branch { group.branch = seed.project.branch.clone(); dirty = true; }
        if group.id == seed.project.id && group.branch_appearance != seed.project.branch_appearance { group.branch_appearance = seed.project.branch_appearance.clone(); dirty = true; }
    }
    dirty
}

fn assign_seed(state: &mut SessionGroups, seed: SessionSeed) -> bool {
    if state.assignments.contains_key(&seed.session_key) { return false; }
    if state.removed_projects.contains(&seed.project.id) { state.assignments.insert(seed.session_key, None); return true; }
    if !state.groups.iter().any(|group| group.id == seed.project.id) {
        state.groups.insert(0, seed.project.clone());
    }
    state.assignments.insert(seed.session_key, Some(seed.project.id));
    true
}

fn load_at(path: &Path, seeds: Vec<SessionSeed>, legacy: SessionGroups) -> Result<SessionGroups, String> {
    let _file_lock = lock_storage(path)?;
    let stored = read(path)?;
    let mut dirty = stored.is_none();
    let mut state = stored.unwrap_or(legacy);
    dirty |= restore_suppressed_projects(&mut state, &seeds);
    dirty |= migrate_group_names(&mut state);
    for seed in seeds {
        dirty |= update_seed_metadata(&mut state, &seed);
        dirty |= assign_seed(&mut state, seed);
    }
    dirty |= refresh_group_branches(&mut state);
    let ids: HashSet<_> = state.groups.iter().map(|group| group.id.clone()).collect();
    for destination in state.assignments.values_mut() {
        if destination.as_ref().is_some_and(|id| !ids.contains(id)) { *destination = None; dirty = true; }
    }
    if dirty { write(path, &state)?; }
    Ok(state)
}

fn branch_from_group_id(id: &str) -> Option<String> {
    let (_, encoded) = id.rsplit_once("#branch=")?;
    let mut bytes = Vec::new();
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = (input.next()? as char).to_digit(16)?;
            let low = (input.next()? as char).to_digit(16)?;
            bytes.push((high * 16 + low) as u8);
        } else { bytes.push(byte); }
    }
    String::from_utf8(bytes).ok()
}

fn refresh_group_branches(state: &mut SessionGroups) -> bool {
    let mut dirty = false;
    for group in &mut state.groups {
        let Some(branch) = branch_from_group_id(&group.id) else { continue; };
        if group.branch.as_ref() != Some(&branch) { group.branch = Some(branch.clone()); dirty = true; }
        if group.host_id.as_deref().unwrap_or("local") != "local" { continue; }
        if let Some(appearance) = local_group_appearance(group, &branch) {
            if group.branch_appearance != appearance { group.branch_appearance = appearance; dirty = true; }
        }
    }
    dirty
}

fn local_group_appearance(group: &SessionGroup, branch: &str) -> Option<Option<serde_json::Value>> {
    use std::io::Read;
    let path = Path::new(group.cwd.as_deref()?).join(".piop/branches.json");
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(32769).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 32768 { return None; }
    let config: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if config["version"] != 1 { return None; }
    Some(config.get("branches").and_then(|branches| branches.get(branch)).filter(|value| value.is_object()).cloned())
}

fn restore_suppressed_projects(state: &mut SessionGroups, seeds: &[SessionSeed]) -> bool {
    if state.removed_projects.is_empty() { return false; }
    for seed in seeds {
        if state.removed_projects.contains(&seed.project.id) && state.assignments.get(&seed.session_key) == Some(&None) {
            state.assignments.remove(&seed.session_key);
        }
    }
    let previous_count = state.removed_projects.len();
    for seed in seeds { state.removed_projects.remove(&seed.project.id); }
    state.removed_projects.len() != previous_count
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn change_session_groups(app: AppHandle, change: GroupChange) -> Result<SessionGroups, String> {
    change_with(change, storage_path, |state| { let _ = app.emit("pi://groups-changed", state); })
}

fn change_with(change: GroupChange, path: impl FnOnce() -> Result<PathBuf, String>, emit: impl FnOnce(&SessionGroups)) -> Result<SessionGroups, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = path()?;
    let state = change_at(&path, change)?;
    emit(&state);
    Ok(state)
}

fn change_at(path: &Path, change: GroupChange) -> Result<SessionGroups, String> {
    let _file_lock = lock_storage(path)?;
    let mut state = read(path)?.ok_or("Session groups have not loaded yet")?;
    apply_group_change(&mut state, change)?;
    write(path, &state)?;
    Ok(state)
}

fn apply_group_change(state: &mut SessionGroups, change: GroupChange) -> Result<(), String> {
    match change {
        GroupChange::Relocate { project, key } => relocate_group(state, project, key),
        GroupChange::InspectProject { id, project_kind } => inspect_project_group(state, id, project_kind),
        GroupChange::Project { project, key } => project_group(state, project, key),
        GroupChange::Create { name } => create_group(state, name),
        GroupChange::Rename { id, name } => rename_group(state, id, name),
        GroupChange::Remove { id } => remove_group(state, id),
        GroupChange::Assign { key, group } => assign_group(state, key, group),
    }
}

fn relocate_group(state: &mut SessionGroups, project: SessionGroup, key: String) -> Result<(), String> {
    if project.cwd.as_ref().is_none_or(|cwd| cwd.is_empty()) { return Err("Enter a project directory".into()); }
    let previous = state.assignments.get(&key).cloned();
    let old_id = previous.clone().flatten();
    let automatic = old_id.as_ref().is_some_and(|id| state.groups.iter().any(|group| &group.id == id && group.cwd.is_some()));
    if previous.is_none() || automatic {
        state.removed_projects.remove(&project.id);
        state.assignments.insert(key, Some(project.id.clone()));
        if !state.groups.iter().any(|group| group.id == project.id) { state.groups.insert(0, project); }
        if let Some(old_id) = old_id {
            if !state.assignments.values().any(|id| id.as_ref() == Some(&old_id)) {
                state.groups.retain(|group| group.id != old_id);
            }
        }
    }
    Ok(())
}

fn inspect_project_group(state: &mut SessionGroups, id: String, project_kind: super::ProjectKind) -> Result<(), String> {
    if !state.removed_projects.contains(&id) {
        if let Some(group) = state.groups.iter_mut().find(|group| group.id == id) { group.project_kind = Some(project_kind); }
    }
    Ok(())
}

fn project_group(state: &mut SessionGroups, project: SessionGroup, key: Option<String>) -> Result<(), String> {
    if project.cwd.as_ref().is_none_or(|cwd| cwd.trim().is_empty()) { return Err("Enter a project directory".into()); }
    state.removed_projects.remove(&project.id);
    if let Some(key) = key { state.assignments.insert(key, Some(project.id.clone())); }
    if let Some(group) = state.groups.iter_mut().find(|group| group.id == project.id) {
        if project.project_kind.is_some() { group.project_kind = project.project_kind; }
    } else { state.groups.insert(0, project); }
    Ok(())
}

fn create_group(state: &mut SessionGroups, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() { return Err("Enter a group name".into()); }
    if state.groups.iter().any(|group| group.name.to_lowercase() == name.to_lowercase()) { return Err("A group already uses that name".into()); }
    state.groups.insert(0, SessionGroup { id: format!("__pi-desktop-custom-group__:{}", uuid::Uuid::new_v4()), name: name.into(), cwd: None, host_id: None, host_name: None, project_kind: None, branch: None, branch_appearance: None });
    Ok(())
}

fn rename_group(state: &mut SessionGroups, id: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() { return Err("Enter a group name".into()); }
    if state.groups.iter().any(|group| group.id != id && group.name.to_lowercase() == name.to_lowercase()) { return Err("A group already uses that name".into()); }
    state.groups.iter_mut().find(|group| group.id == id).ok_or("Group no longer exists")?.name = name.into();
    Ok(())
}

fn remove_group(state: &mut SessionGroups, id: String) -> Result<(), String> {
    if !state.groups.iter().any(|group| group.id == id) { return Err("Group no longer exists".into()); }
    state.groups.retain(|group| group.id != id);
    for destination in state.assignments.values_mut() {
        if destination.as_ref() == Some(&id) { *destination = None; }
    }
    Ok(())
}

fn assign_group(state: &mut SessionGroups, key: String, group: Option<String>) -> Result<(), String> {
    if group.as_ref().is_some_and(|id| !state.groups.iter().any(|item| &item.id == id)) { return Err("Group no longer exists".into()); }
    state.assignments.insert(key, group);
    Ok(())
}
