use super::*;
use std::io::Write;

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
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

#[tauri::command]
pub(crate) fn load_client_settings() -> Result<Option<ClientSettings>, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    let path = storage_path()?;
    match fs::read(&path) {
        Ok(body) => serde_json::from_slice(&body).map(Some).map_err(|error| format!("Could not read client preferences: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn save_client_settings(app: AppHandle, settings: ClientSettings) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    let path = storage_path()?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    if fs::read(&path).ok().as_deref() == Some(body.as_slice()) { return Ok(()); }
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
        fs::rename(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result?;
    for window in app.webview_windows().values() { let _ = window.emit("pi://client-settings-changed", ()); }
    Ok(())
}
