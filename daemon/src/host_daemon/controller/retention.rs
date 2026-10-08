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
    if pending_entry(&root.join("deleted-sessions"), committed_deletion)? { return Ok(true); }
    let database = crate::session_registry::open(root)?;
    database.query_row("SELECT EXISTS(SELECT 1 FROM retention_candidates) OR EXISTS(SELECT 1 FROM cleanup_requests)", [], |row| row.get(0)).map_err(|error| error.to_string())
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
    if initialize { mark_retention_scan(root, "goal")?; mark_retention_scan(root, "worktree")?; }
    if !retention_pending(root)? { return Ok(()); }
    tokio::time::timeout(Duration::from_secs(30), super::recovery::collect_retention(root)).await
        .map_err(|_| "Deferred retention cleanup timed out; candidates remain available for retry".to_string())?
}

fn mark_retention_scan(root: &Path, marker: &str) -> Result<()> {
    let database = crate::session_registry::open(root)?;
    database.execute("INSERT INTO cleanup_requests VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1", [marker])
        .map_err(|error| error.to_string())?;
    Ok(())
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
