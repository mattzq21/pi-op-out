use super::*;
use std::io::Write;

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

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

fn storage_lock(path: &Path) -> Result<fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path.with_extension("lock")).map_err(|error| error.to_string())?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

fn read_preferences(path: &Path) -> Result<Option<ClientSettings>, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice(&body).map(Some).map_err(|error| format!("Could not read client preferences: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
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

fn publish_preferences(path: &Path, settings: &ClientSettings) -> Result<bool, String> {
    let body = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    if fs::read(path).ok().as_deref() == Some(body.as_slice()) { return Ok(false); }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&body).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn load_client_settings() -> Result<Option<ClientSettings>, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    let path = storage_path()?;
    let _file_guard = storage_lock(&path)?;
    read_preferences(&path)
}

#[tauri::command]
pub(crate) fn save_client_settings(app: AppHandle, settings: ClientSettings, baseline: ClientSettings, initialize: Option<bool>) -> Result<ClientSettings, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    let path = storage_path()?;
    let _file_guard = storage_lock(&path)?;
    let settings = intended_preferences(&path, &baseline, settings, initialize.unwrap_or(false))?;
    if publish_preferences(&path, &settings)? {
        for window in app.webview_windows().values() { let _ = window.emit("pi://client-settings-changed", ()); }
    }
    Ok(settings)
}
