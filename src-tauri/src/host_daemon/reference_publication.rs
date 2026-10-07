use super::protocol::Result;
use sha2::{Digest, Sha256};
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
    let file = options.open(root.join("reference-publication.lock")).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Invalid reference publication lock".into());
    }
    file.lock_shared().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(super) fn register_transcript(root: &Path, transcript: &Path) -> Result<()> {
    if !transcript.is_absolute() { return Err("External transcript path must be absolute".into()); }
    let directory = root.join("external-transcripts");
    crate::ensure_private_dir(&directory)?;
    let path = transcript.to_str().ok_or("Invalid external transcript path")?;
    let record = directory.join(format!("{:x}.json", Sha256::digest(path.as_bytes())));
    crate::atomic_write_private(&record, &serde_json::to_vec(&serde_json::json!({"path":path})).map_err(|error| error.to_string())?)?;
    for path in [&record, &directory, root] {
        File::open(path).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    }
    Ok(())
}
