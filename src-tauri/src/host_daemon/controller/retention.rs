use super::*;
use std::path::Path;

impl Host {
    pub(super) fn watch_retention(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let root = self.storage_root();
        let mut stopped = self.ownership().shutdown_signal();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut reported = None;
            let mut initialized = false;
            loop {
                tokio::select! {
                    _ = stopped.wait_for(|stop| *stop) => break,
                    _ = interval.tick() => {},
                }
                let Some(host) = weak.upgrade() else { break; };
                let result = tokio::select! {
                    _ = stopped.wait_for(|stop| *stop) => break,
                    result = retention_pass(&root, !initialized) => result,
                };
                initialized |= result.is_ok();
                report_retention(&host, result, &mut reported);
            }
        });
    }
}

fn retention_pending(root: &Path) -> Result<bool> {
    if root.join("worktree-retention.pending").try_exists().map_err(|error| error.to_string())? { return Ok(true); }
    if root.join("goal-retention.pending").try_exists().map_err(|error| error.to_string())? { return Ok(true); }
    if pending_entry(&root.join("deleted-sessions"), committed_deletion)? { return Ok(true); }
    pending_entry(&root.join("retention-candidates"), |entry| {
        Ok(entry.path().extension().is_some_and(|extension| extension == "json"))
    })
}

fn committed_deletion(entry: &std::fs::DirEntry) -> Result<bool> {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    Ok(name.len() == 36 && Uuid::parse_str(&name).is_ok()
        && entry.file_type().map_err(|error| error.to_string())?.is_dir())
}

fn pending_entry(directory: &Path, matches: impl Fn(&std::fs::DirEntry) -> Result<bool>) -> Result<bool> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        if matches(&entry.map_err(|error| error.to_string())?)? { return Ok(true); }
    }
    Ok(false)
}

async fn retention_pass(root: &Path, initialize: bool) -> Result<()> {
    if initialize { mark_retention_scan(root, "goal-retention.pending")?; mark_retention_scan(root, "worktree-retention.pending")?; }
    if !retention_pending(root)? { return Ok(()); }
    tokio::time::timeout(Duration::from_secs(30), super::recovery::collect_retention(root)).await
        .map_err(|_| "Deferred retention cleanup timed out; candidates remain available for retry".to_string())?
}

fn mark_retention_scan(root: &Path, marker: &str) -> Result<()> {
    crate::ensure_private_dir(root)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(root.join(marker)).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() { return Err("Invalid retention recovery marker".into()); }
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::File::open(root).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())
}

fn report_retention(host: &Host, result: Result<()>, reported: &mut Option<String>) {
    if let Err(error) = result {
        if reported.as_ref() != Some(&error) {
            host.output(json!({"type":"diagnostic","line":format!("Deferred retention cleanup is pending: {error}")}));
        }
        *reported = Some(error);
    } else {
        *reported = None;
    }
}
