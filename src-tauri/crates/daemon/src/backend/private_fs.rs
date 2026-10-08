use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

#[derive(serde::Serialize)]
pub(super) struct Publication {
    committed: bool,
    durable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}

impl Publication {
    fn committed(result: Result<(), String>) -> Self {
        Self { committed: true, durable: result.is_ok(), error: result.err() }
    }
}

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

pub(super) fn atomic_write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    match publish_private(path, body)?.error { Some(error) => Err(error), None => Ok(()) }
}

pub(super) fn publish_private(path: &Path, body: &[u8]) -> Result<Publication, String> {
    let parent = path.parent().ok_or("Configuration file has no parent directory")?;
    ensure_private_dir(parent)?;
    if private_file_matches(path, body)? {
        let result = fs::File::open(path).and_then(|file| file.sync_all()).map_err(|error| format!("Could not sync saved configuration: {error}"))
            .and_then(|()| sync_directory_ancestors(parent));
        return Ok(Publication::committed(result));
    }
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
        Ok(Publication::committed(sync_directory_ancestors(parent)))
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

pub(super) fn sync_directory_ancestors(path: &Path) -> Result<(), String> {
    let directory = fs::canonicalize(path).map_err(|error| format!("Could not resolve saved directory {}: {error}", path.display()))?;
    for ancestor in directory.ancestors() {
        fs::File::open(ancestor).and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync saved directory {}: {error}", ancestor.display()))?;
    }
    Ok(())
}
