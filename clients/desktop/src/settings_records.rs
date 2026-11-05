use std::{fs, io::Write, path::Path};

// The desktop app's own preference file. Only the desktop app writes it; the daemon's storage is not touched.

#[derive(serde::Serialize)]
pub(crate) struct Publication {
    committed: bool,
    durable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

pub(crate) fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

// Replaces the file in one step: a crash leaves the old or the new contents.
pub(crate) fn publish(path: &Path, body: &[u8]) -> Result<Publication, String> {
    let directory = path.parent().ok_or("Preferences have no folder")?;
    crate::private_fs::ensure_private_dir(directory)?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(directory)?.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not save {}: {error}", path.display()));
    }
    Ok(Publication { committed: true, durable: true, error: None })
}
