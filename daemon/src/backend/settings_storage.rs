#[cfg(test)]
pub(super) use crate::keybindings::canonical_shortcut;
pub(super) use crate::keybindings::migrate_keybindings;
pub(super) use crate::keybindings::validate_keybindings;
pub(super) use crate::private_fs::set_private_file_permissions;
pub(super) use crate::private_fs::ensure_private_dir;
pub(super) use crate::private_fs::atomic_write_private;
use std::path::Path;
use std::path::PathBuf;
use crate::platform::AppHandle;
use crate::{DEVELOPMENT, STORAGE_DIRECTORY};
use crate::environment::home_dir;
pub(super) use crate::settings_concurrency::{lock_settings, settings_revision};

#[path = "settings_synchronization.rs"]
pub(crate) mod synchronization;

#[path = "app_settings_storage.rs"]
pub(crate) mod records;

pub(super) fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    settings_path_at(&home_dir()?, DEVELOPMENT, || app.path().app_config_dir().map_err(|error| error.to_string()).map(|dir| dir.join("settings.json")))
}

pub(super) fn settings_path_at(home: &Path, development: bool, legacy_path: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    let dir = home.join(STORAGE_DIRECTORY);
    ensure_private_dir(&dir)?;
    let path = dir.join("settings.json");
    let _storage = synchronization::storage_lock(&path)?;
    let _lock = lock_settings(&path)?;
    if !development && records::needs_legacy(&path)? {
        records::import_legacy(&path, &legacy_path()?)?;
    }
    Ok(path)
}
