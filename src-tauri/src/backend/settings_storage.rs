use crate::platform::AppHandle;
use std::fs;
use std::path::{Path, PathBuf};
use super::{DEVELOPMENT, STORAGE_DIRECTORY};
use super::environment::home_dir;
use super::private_fs::{atomic_write_private, ensure_private_dir, set_private_file_permissions};
#[cfg(feature = "desktop")]
use tauri::Manager;

pub(super) fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    settings_path_at(&home_dir()?, DEVELOPMENT, || app.path().app_config_dir().map_err(|error| error.to_string()).map(|dir| dir.join("settings.json")))
}

pub(super) fn settings_path_at(home: &Path, development: bool, legacy_path: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    let dir = home.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("settings.json");
    if !development && !path.exists() {
        let legacy = legacy_path()?;
        migrate_legacy_settings(&legacy, &path)?;
    }
    set_private_file_permissions(&path)?;
    Ok(path)
}

fn migrate_legacy_settings(legacy: &Path, path: &Path) -> Result<(), String> {
    match fs::read(legacy) {
        Ok(body) => {
            atomic_write_private(path, &body)?;
            fs::remove_file(legacy).map_err(|error| format!("Settings migrated, but could not remove old settings: {error}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not migrate settings: {error}")),
    }
    Ok(())
}
