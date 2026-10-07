use super::super::{controller::Host, protocol::Result};
use std::{fs, path::PathBuf};
use uuid::Uuid;

pub(super) fn create(host: &Host) -> Result<(PathBuf, fs::File)> {
    let root = host.storage_root();
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
