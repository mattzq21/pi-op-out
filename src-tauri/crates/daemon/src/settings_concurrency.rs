use std::{fs, path::Path};
use sha2::{Digest, Sha256};

pub(crate) fn settings_revision(body: Option<&[u8]>) -> String {
    body.map(|body| format!("{:x}", Sha256::digest(body))).unwrap_or_else(|| "missing".into())
}

pub(crate) fn lock_settings(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path.with_extension("lock")).map_err(|error| error.to_string())?;
    file.lock().map_err(|error| format!("Could not lock settings: {error}"))?;
    Ok(file)
}
