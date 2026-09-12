use std::{collections::{HashMap, HashSet}, fs, path::PathBuf, sync::Mutex};
use serde::{Deserialize, Serialize};

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

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
    Rename { id: String, name: String },
    Remove { id: String },
    Assign { key: String, group: Option<String> },
}

fn storage_path() -> Result<PathBuf, String> {
    Ok(super::ensure_desktop_sessions_dir(&super::home_dir()?)?.join("groups.json"))
}

fn read(path: &PathBuf) -> Result<Option<SessionGroups>, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice(&body).map(Some).map_err(|error| format!("Could not read session groups: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read session groups: {error}")),
    }
}

fn write(path: &PathBuf, groups: &SessionGroups) -> Result<(), String> {
    super::atomic_write_private(path, &serde_json::to_vec_pretty(groups).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Could not save session groups: {error}"))
}

pub fn attach_assignments(sessions: &mut [super::SessionSummary]) -> Result<(), String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    if let Some(state) = read(&storage_path()?)? {
        for session in sessions {
            session.group_id = state.assignments.get(&format!("{}:{}", session.host_id, session.id)).cloned().flatten();
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn load_session_groups(seeds: Vec<SessionSeed>, legacy: SessionGroups) -> Result<SessionGroups, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = storage_path()?;
    let stored = read(&path)?;
    let mut dirty = stored.is_none();
    let mut state = stored.unwrap_or(legacy);
    for group in &mut state.groups {
        if group.name != "Workspace" { continue; }
        let Some(cwd) = group.cwd.as_deref() else { continue; };
        if !cwd.ends_with('/') || group.id != format!("{}:{cwd}", group.host_id.as_deref().unwrap_or("local")) { continue; }
        if let Some(name) = cwd.rsplit('/').find(|part| !part.is_empty()) {
            if name != group.name { group.name = name.to_owned(); dirty = true; }
        }
    }
    for seed in seeds {
        if state.assignments.contains_key(&seed.session_key) { continue; }
        let destination = if state.removed_projects.contains(&seed.project.id) { None } else {
            if !state.groups.iter().any(|group| group.id == seed.project.id) {
                state.groups.insert(0, seed.project.clone());
            }
            Some(seed.project.id)
        };
        state.assignments.insert(seed.session_key, destination);
        dirty = true;
    }
    let ids: HashSet<_> = state.groups.iter().map(|group| group.id.clone()).collect();
    for destination in state.assignments.values_mut() {
        if destination.as_ref().is_some_and(|id| !ids.contains(id)) { *destination = None; dirty = true; }
    }
    if dirty { write(&path, &state)?; }
    Ok(state)
}

#[tauri::command(async)]
pub fn change_session_groups(change: GroupChange) -> Result<SessionGroups, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Session groups lock was poisoned")?;
    let path = storage_path()?;
    let mut state = read(&path)?.ok_or("Session groups have not loaded yet")?;
    match change {
        GroupChange::Project { project, key } => {
            if project.cwd.as_ref().is_none_or(|cwd| cwd.trim().is_empty()) { return Err("Enter a project directory".into()); }
            state.removed_projects.remove(&project.id);
            if let Some(key) = key { state.assignments.insert(key, Some(project.id.clone())); }
            if let Some(group) = state.groups.iter_mut().find(|group| group.id == project.id) {
                if project.project_kind.is_some() { group.project_kind = project.project_kind; }
            } else { state.groups.insert(0, project); }
        }
        GroupChange::Create { name } => {
            let name = name.trim();
            if name.is_empty() { return Err("Enter a group name".into()); }
            if state.groups.iter().any(|group| group.name.to_lowercase() == name.to_lowercase()) { return Err("A group already uses that name".into()); }
            state.groups.insert(0, SessionGroup { id: format!("__pi-desktop-custom-group__:{}", uuid::Uuid::new_v4()), name: name.into(), cwd: None, host_id: None, host_name: None, project_kind: None });
        }
        GroupChange::Rename { id, name } => {
            let name = name.trim();
            if name.is_empty() { return Err("Enter a group name".into()); }
            if state.groups.iter().any(|group| group.id != id && group.name.to_lowercase() == name.to_lowercase()) { return Err("A group already uses that name".into()); }
            state.groups.iter_mut().find(|group| group.id == id).ok_or("Group no longer exists")?.name = name.into();
        }
        GroupChange::Remove { id } => {
            let group = state.groups.iter().find(|group| group.id == id).ok_or("Group no longer exists")?;
            if group.cwd.is_some() { state.removed_projects.insert(id.clone()); }
            state.groups.retain(|group| group.id != id);
            for destination in state.assignments.values_mut() {
                if destination.as_ref() == Some(&id) { *destination = None; }
            }
        }
        GroupChange::Assign { key, group } => {
            if group.as_ref().is_some_and(|id| !state.groups.iter().any(|item| &item.id == id)) { return Err("Group no longer exists".into()); }
            state.assignments.insert(key, group);
        }
    }
    write(&path, &state)?;
    Ok(state)
}
