use super::super::{controller::Host, protocol::Result};
use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

fn lock_recovery(root: &Path) -> Result<fs::File> {
    crate::ensure_private_dir(root)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock = options.open(root.join("restore.lock")).map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    Ok(lock)
}

pub(super) fn create(host: &Host) -> Result<(PathBuf, fs::File)> {
    let root = host.storage_root();
    let _recovery = lock_recovery(&root)?;
    let preparations = root.join("fork-preparations");
    crate::ensure_private_dir(&preparations)?;
    fs::File::open(&root).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    let directory = preparations.join(Uuid::new_v4().to_string());
    crate::ensure_private_dir(&directory)?;
    let lock = super::private_file(&directory.join("active.lock"))?;
    lock.lock().map_err(|error| error.to_string())?;
    lock.sync_all().map_err(|error| error.to_string())?;
    fs::File::open(&directory).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    fs::File::open(preparations).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    Ok((directory, lock))
}
