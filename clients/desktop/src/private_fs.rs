use std::{fs, path::Path};

pub(super) fn set_private_file_permissions(path: &Path) -> Result<(), String> {
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

pub(super) fn ensure_private_dir(path: &Path) -> Result<(), String> {
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
