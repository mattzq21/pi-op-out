use std::{fs, path::Path, thread, time::{Duration, Instant}};
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
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() { return Err("Could not lock settings within 3 seconds: another settings operation is still running. Try again.".into()); }
                thread::sleep(remaining.min(Duration::from_millis(25)));
            }
            Err(fs::TryLockError::Error(error)) => return Err(format!("Could not lock settings: {error}")),
        }
    }
    Ok(file)
}
