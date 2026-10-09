use super::*;
use crate::settings_concurrency::{lock_settings, settings_revision};

#[path = "../../../shared/rust/settings_records.rs"]
mod records;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientSettings {
    keybindings: HashMap<String, String>,
    hidden_models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    known_models: Option<Vec<String>>,
    debug_mode: bool,
}

fn storage_path() -> Result<PathBuf, String> {
    let directory = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&directory)?;
    Ok(directory.join("client-settings.json"))
}

fn read_preferences(path: &Path) -> Result<Option<ClientSettings>, String> {
    records::read(path)?.map(|body| serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))).transpose()
}

fn merge_memberships(latest: &[String], baseline: &[String], intended: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = latest.iter().filter(|id| !baseline.contains(id) || intended.contains(id)).cloned().collect();
    for id in intended {
        if !baseline.contains(id) && !merged.contains(id) { merged.push(id.clone()); }
    }
    merged
}

fn merge_keybindings(latest: &mut HashMap<String, String>, baseline: &HashMap<String, String>, intended: &HashMap<String, String>) -> Result<(), String> {
    for key in baseline.keys().chain(intended.keys()) {
        let before = baseline.get(key);
        let after = intended.get(key);
        if before == after { continue; }
        let current = latest.get(key);
        if current != before && current != after { return Err(format!("Client preference conflict at keybindings.{key}: another window changed this shortcut. Reload the latest preferences and choose the shortcut again.")); }
    }
    for key in baseline.keys().chain(intended.keys()) {
        if baseline.get(key) == intended.get(key) { continue; }
        if let Some(value) = intended.get(key) { latest.insert(key.clone(), value.clone()); }
        else { latest.remove(key); }
    }
    Ok(())
}

fn merge_preferences(mut latest: ClientSettings, baseline: &ClientSettings, intended: &ClientSettings) -> Result<ClientSettings, String> {
    merge_keybindings(&mut latest.keybindings, &baseline.keybindings, &intended.keybindings)?;
    latest.hidden_models = merge_memberships(&latest.hidden_models, &baseline.hidden_models, &intended.hidden_models);
    if latest.known_models.is_some() || intended.known_models.is_some() {
        latest.known_models = Some(merge_memberships(latest.known_models.as_deref().unwrap_or_default(), baseline.known_models.as_deref().unwrap_or_default(), intended.known_models.as_deref().unwrap_or_default()));
    }
    if intended.debug_mode != baseline.debug_mode { latest.debug_mode = intended.debug_mode; }
    Ok(latest)
}

fn intended_preferences(path: &Path, baseline: &ClientSettings, intended: ClientSettings, initialize: bool) -> Result<ClientSettings, String> {
    match read_preferences(path)? {
        Some(latest) if initialize => Ok(latest),
        Some(latest) => merge_preferences(latest, baseline, &intended),
        None => Ok(intended),
    }
}

#[tauri::command]
pub(crate) fn load_client_settings() -> Result<Value, String> {
    let path = storage_path()?;
    let _guard = lock_settings(&path)?;
    match records::read(&path)? {
        Some(body) => {
            let settings: ClientSettings = serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))?;
            Ok(json!({"settings":settings,"revision":settings_revision(Some(&body))}))
        }
        None => Ok(json!({"settings":null,"revision":settings_revision(None)})),
    }
}

#[tauri::command]
pub(crate) fn save_client_settings(app: AppHandle, settings: ClientSettings, baseline: ClientSettings, initialize: Option<bool>) -> Result<Value, String> {
    let path = storage_path()?;
    let _guard = lock_settings(&path)?;
    let settings = intended_preferences(&path, &baseline, settings, initialize.unwrap_or(false))?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    let publication = records::publish(&path, &body)?;
    for window in app.webview_windows().values() { let _ = window.emit("pi://client-settings-changed", ()); }
    Ok(json!({"settings":settings,"revision":settings_revision(Some(&body)),"publication":publication}))
}
