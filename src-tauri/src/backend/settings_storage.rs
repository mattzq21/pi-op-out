fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    settings_path_at(&home_dir()?, DEVELOPMENT, || app.path().app_config_dir().map_err(|error| error.to_string()).map(|dir| dir.join("settings.json")))
}

fn settings_path_at(home: &Path, development: bool, legacy_path: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
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

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    if path.is_dir() { return Err(format!("Configuration path is a directory: {}", path.display())); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o600 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn private_file_matches(path: &Path, body: &[u8]) -> Result<bool, String> {
    if path.exists() {
        if path.is_dir() { return Err(format!("Configuration path is a directory: {}", path.display())); }
        set_private_file_permissions(path)?;
        match fs::read(path) {
            Ok(current) if current == body => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

fn atomic_write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Configuration file has no parent directory")?;
    ensure_private_dir(parent)?;
    if private_file_matches(path, body)? { return Ok(()); }
    let temporary = parent.join(format!(".{}.{}.tmp", path.file_name().and_then(|name| name.to_str()).unwrap_or("config"), Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
        file.write_all(body).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| if path.is_dir() { format!("Configuration path is a directory: {}", path.display()) } else { error.to_string() })?;
        if let Ok(directory) = fs::File::open(parent) { let _ = directory.sync_all(); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn canonical_shortcut(shortcut: &str) -> Result<Option<String>, String> {
    // A single trailing "+" denotes the "+" key itself: "Ctrl++" -> ["ctrl", "+"].
    let mut raw: Vec<&str> = shortcut.split('+').collect();
    let mut plus_key = false;
    if raw.len() > 1 && raw[raw.len() - 1].trim().is_empty() { plus_key = true; raw.pop(); }
    let mut parts: Vec<String> = raw.iter().map(|part| part.trim().to_lowercase()).filter(|part| !part.is_empty()).collect();
    if plus_key { parts.push("+".to_string()); }
    if parts.is_empty() { return Ok(None); }
    let modifiers = ["ctrl", "meta", "alt", "shift", "mod"];
    let keys: Vec<&String> = parts.iter().filter(|part| !modifiers.contains(&part.as_str())).collect();
    if keys.len() != 1 { return Err(format!("Shortcut '{shortcut}' needs exactly one key")); }
    let key = keys[0];
    if ["control", "meta", "alt", "shift", "mod"].contains(&key.as_str()) { return Err(format!("Shortcut '{shortcut}' needs a key")); }
    let protected = parts.iter().any(|part| matches!(part.as_str(), "ctrl" | "meta" | "alt" | "mod"));
    if !protected { return Err(format!("Shortcut '{shortcut}' needs Ctrl, Alt, or Meta")); }
    let mut canonical: Vec<&str> = modifiers.iter().copied().filter(|modifier| parts.iter().any(|part| part == modifier)).collect(); canonical.push(key); Ok(Some(canonical.join("+")))
}

fn migrate_keybindings(settings: &mut AppSettings) {
    // Retired actions can retain shortcuts now reserved by the app (e.g. conversation search).
    let supported = default_keybindings();
    settings.keybindings.retain(|action, _| supported.contains_key(action));
    for (action, shortcut) in supported {
        settings.keybindings.entry(action).or_insert(shortcut);
    }
    if settings.keybindings.get("focusComposer").map(String::as_str) == Some("Ctrl+L") {
        settings.keybindings.insert("focusComposer".into(), "Ctrl+E".into());
    }
}

fn validate_keybindings(settings: &AppSettings) -> Result<(), String> {
    let mut shortcuts = HashSet::new();
    for shortcut in settings.keybindings.values() {
        if let Some(canonical) = canonical_shortcut(shortcut)? {
            if matches!(canonical.as_str(), "ctrl+g" | "meta+g" | "mod+g") { return Err(format!("Shortcut '{shortcut}' is reserved for conversation search")); }
            if !shortcuts.insert(canonical) { return Err(format!("Shortcut '{shortcut}' is assigned more than once")); }
        }
    }
    Ok(())
}
