use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use crate::platform::AppHandle;

static STORAGE_LOCK: Mutex<()> = Mutex::new(());
const DIRLESS_KEY: &str = "__pi-desktop-dirless__";

#[path = "session_group_deletions.rs"]
mod deletions;

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
pub fn load_session_groups(app: AppHandle, seeds: Vec<SessionSeed>, legacy: SessionGroups) -> Result<SessionGroups, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = storage_path()?;
    deletions::refresh(&path, &super::load_app_settings(app.clone())?, &seeds, None)?;
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
    let mut moved = false;
    for group in &state.groups.clone() {
        let Some(branch) = group.branch.as_deref() else { continue; };
        let host = group.host_id.as_deref().unwrap_or("local");
        let listed = sessions.entry(host.to_owned()).or_insert_with(|| super::sessions_on_host(&settings, &index, host));
        let Ok(listed) = listed else { continue; };
        let (changed, remove) = inspect_empty_branch_group(state, group, listed, &settings, branch);
        moved |= changed;
        if remove { removed.insert(group.id.clone()); }
    }
    if removed.is_empty() && !moved { return Ok(()); }
    state.groups.retain(|group| !removed.contains(&group.id));
    state.assignments.retain(|_, group| !group.as_ref().is_some_and(|id| removed.contains(id)));
    write(path, state)?;
    let _ = app.emit("pi://groups-changed", &*state);
    Ok(())
}

fn inspect_empty_branch_group(state: &mut SessionGroups, group: &SessionGroup, sessions: &[super::SessionSummary], settings: &super::AppSettings, branch: &str) -> (bool, bool) {
    let moved = move_missing_group_sessions(state, group, sessions);
    let remove = !group_has_sessions(state, group, sessions) && (moved || branch_is_missing(settings, group, branch));
    (moved, remove)
}

fn move_missing_group_sessions(state: &mut SessionGroups, group: &SessionGroup, sessions: &[super::SessionSummary]) -> bool {
    let mut moved = false;
    for session in sessions.iter().filter(|session| !session.cwd_exists) {
        let key = format!("{}:{}", session.host_id, session.id);
        if state.assignments.get(&key).and_then(|id| id.as_deref()) == Some(group.id.as_str()) {
            state.assignments.insert(key, Some(DIRLESS_KEY.into()));
            moved = true;
        }
    }
    moved
}

fn group_has_sessions(state: &SessionGroups, group: &SessionGroup, sessions: &[super::SessionSummary]) -> bool {
    sessions.iter().any(|session| {
        let key = format!("{}:{}", session.host_id, session.id);
        state.assignments.get(&key).and_then(|id| id.as_deref()) == Some(group.id.as_str())
    })
}

fn branch_is_missing(settings: &super::AppSettings, group: &SessionGroup, branch: &str) -> bool {
    let Some(cwd) = group.cwd.as_deref() else { return false; };
    crate::git_ops::project_branches::branch_is_missing(settings, cwd, group.host_id.as_deref().unwrap_or("local"), branch)
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
    let deleted = deletions::known(path)?;
    dirty |= deletions::prune(&mut state, &deleted);
    let seeds: Vec<_> = seeds.into_iter().filter(|seed| !deletions::contains(&deleted, &seed.session_key)).collect();
    dirty |= restore_suppressed_projects(&mut state, &seeds);
    dirty |= migrate_group_names(&mut state);
    for seed in seeds {
        dirty |= update_seed_metadata(&mut state, &seed);
        dirty |= assign_seed(&mut state, seed);
    }
    dirty |= refresh_group_branches(&mut state);
    let ids: HashSet<_> = state.groups.iter().map(|group| group.id.clone()).collect();
    for destination in state.assignments.values_mut() {
        if destination.as_ref().is_some_and(|id| id != DIRLESS_KEY && !ids.contains(id)) { *destination = None; dirty = true; }
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
    }
    dirty
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
pub fn change_session_groups(app: AppHandle, change: GroupChange) -> Result<SessionGroups, String> {
    let path = storage_path()?;
    deletions::refresh(&path, &super::load_app_settings(app.clone())?, &[], deletions::change_key(&change))?;
    change_with(change, storage_path, |state| { let _ = app.emit("pi://groups-changed", state); })
}

pub(crate) fn refresh_deletions(app: &AppHandle, host_id: &str) -> Result<(), String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = storage_path()?;
    let key = format!("{host_id}:");
    deletions::refresh(&path, &super::load_app_settings(app.clone())?, &[], Some(&key))?;
    if let Some(state) = read(&path)? { let _ = app.emit("pi://groups-changed", state); }
    Ok(())
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
    let deleted = deletions::known(path)?;
    deletions::prune(&mut state, &deleted);
    if deletions::change_key(&change).is_some_and(|key| deletions::contains(&deleted, key)) { return Err("Conversation was permanently deleted".into()); }
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
    state.groups.insert(0, SessionGroup { id: format!("__pi-desktop-custom-group__:{}", uuid::Uuid::new_v4()), name: name.into(), cwd: None, host_id: None, host_name: None, project_kind: None, branch: None });
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
    if group.as_ref().is_some_and(|id| id != DIRLESS_KEY && !state.groups.iter().any(|item| &item.id == id)) { return Err("Group no longer exists".into()); }
    state.assignments.insert(key, group);
    Ok(())
}
