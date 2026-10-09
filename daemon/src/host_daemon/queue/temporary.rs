use super::super::protocol::Result;
use std::{fs::{File, OpenOptions}, path::Path};

pub(super) fn lock(root: &Path) -> Result<File> {
    crate::ensure_private_dir(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(root.join("queued-input.lock")).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() { return Err("Invalid queued-input storage lock".into()); }
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}
