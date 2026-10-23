use super::*;
use crate::settings_concurrency::{lock_settings, settings_revision};

#[path = "settings_records.rs"]
pub(crate) mod records;

/// Sent to all windows after a save. The payload is the saved client settings object.
pub(crate) const CLIENT_SETTINGS_CHANGED: &str = "pi://client-settings-changed";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientSettings {
    keybindings: HashMap<String, String>,
    debug_mode: bool,
    #[serde(default)]
    debug_features_off: Vec<String>,
}

fn storage_path() -> Result<PathBuf, String> {
    let directory = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&directory)?;
    Ok(directory.join("client-settings.json"))
}

fn read_preferences(path: &Path) -> Result<Option<ClientSettings>, String> {
    records::read(path)?.map(|body| serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))).transpose()
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

fn validate_keybindings(keybindings: &HashMap<String, String>) -> Result<(), String> {
    let mut shortcuts = Vec::new();
    for (action, shortcut) in keybindings {
        if shortcut.trim().is_empty() { continue; }
        let mut raw: Vec<_> = shortcut.split('+').collect();
        let plus = raw.len() > 1 && raw.last().is_some_and(|part| part.trim().is_empty());
        if plus { raw.pop(); }
        let mut parts: Vec<String> = raw.into_iter().map(|part| part.trim().to_lowercase()).filter(|part| !part.is_empty()).collect();
        if plus { parts.push("+".into()); }
        let has = |part: &str| parts.iter().any(|value| value == part);
        let keys: Vec<_> = parts.iter().filter(|part| !matches!(part.as_str(), "mod" | "ctrl" | "meta" | "alt" | "shift")).collect();
        if keys.len() != 1 || keys[0] == "control" || !(has("mod") || has("ctrl") || has("meta") || has("alt")) { return Err(format!("Invalid shortcut for {action}: {shortcut}")); }
        if matches!(keys[0].as_str(), "f" | "g") && !has("alt") && !has("shift") && (has("mod") || has("ctrl") || has("meta")) { return Err(format!("Shortcut {shortcut} is reserved for search")); }
        let primary = u8::from(has("mod") || has("ctrl")) | (u8::from(has("mod") || has("meta")) << 1);
        let parsed = (keys[0].clone(), has("alt"), has("shift"), primary);
        if shortcuts.iter().any(|other: &(String, bool, bool, u8)| other.0 == parsed.0 && other.1 == parsed.1 && other.2 == parsed.2 && (other.3 & primary != 0 || (other.3 == 0 && primary == 0))) { return Err(format!("Client preference conflict at keybindings.{action}: shortcut {shortcut} is assigned more than once. Choose another shortcut.")); }
        shortcuts.push(parsed);
    }
    Ok(())
}

fn merge_preferences(mut latest: ClientSettings, baseline: &ClientSettings, intended: &ClientSettings) -> Result<ClientSettings, String> {
    merge_keybindings(&mut latest.keybindings, &baseline.keybindings, &intended.keybindings)?;
    if intended.debug_mode != baseline.debug_mode { latest.debug_mode = intended.debug_mode; }
    if intended.debug_features_off != baseline.debug_features_off { latest.debug_features_off = intended.debug_features_off.clone(); }
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
pub(crate) async fn load_client_settings() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = storage_path()?;
        let _guard = lock_settings(&path)?;
        match records::read(&path)? {
            Some(body) => {
                let settings: ClientSettings = serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))?;
                Ok(json!({"settings":settings,"revision":settings_revision(Some(&body))}))
            }
            None => Ok(json!({"settings":null,"revision":settings_revision(None)})),
        }
    }).await.map_err(|error| format!("Client settings task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_client_settings(app: AppHandle, settings: ClientSettings, baseline: ClientSettings, initialize: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = storage_path()?;
        let _guard = lock_settings(&path)?;
        let settings = intended_preferences(&path, &baseline, settings, initialize.unwrap_or(false))?;
        validate_keybindings(&settings.keybindings)?;
        let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
        let publication = records::publish(&path, &body)?;
        let saved = serde_json::to_value(&settings).map_err(|error| error.to_string())?;
        if let Err(error) = app.emit(CLIENT_SETTINGS_CHANGED, &saved) { eprintln!("Could not report client settings change: {error}"); }
        Ok(json!({"settings":settings,"revision":settings_revision(Some(&body)),"publication":publication}))
    }).await.map_err(|error| format!("Client settings task failed: {error}"))?
}
