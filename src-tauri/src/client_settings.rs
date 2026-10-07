use super::*;
use crate::settings_concurrency::{lock_settings, settings_revision};
use crate::private_fs::publish_private;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientSettings {
    #[serde(default, rename = "_revision", skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
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
pub(crate) fn load_client_settings() -> Result<Value, String> {
    let path = storage_path()?;
    match fs::read(&path) {
        Ok(body) => {
            let settings: ClientSettings = serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))?;
            Ok(json!({"settings":settings,"revision":settings_revision(Some(&body))}))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"settings":null,"revision":settings_revision(None)})),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn save_client_settings(app: AppHandle, mut settings: ClientSettings, expected_revision: String) -> Result<Value, String> {
    let path = storage_path()?;
    let _guard = lock_settings(&path)?;
    let previous = load_client_settings()?;
    if previous["revision"].as_str() != Some(&expected_revision) {
        return Err("Client preferences changed in another window. Reload the latest settings before saving.".into());
    }
    settings.revision = Some(Uuid::new_v4().to_string());
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    let publication = publish_private(&path, &body)?;
    for window in app.webview_windows().values() { let _ = window.emit("pi://client-settings-changed", ()); }
    Ok(json!({"revision":settings_revision(Some(&body)),"publication":publication}))
}
