use super::*;
use super::super::queue::{recover_missing_transcripts, Recovery};
use std::{path::Path, process::Stdio};
use tokio::sync::watch;

impl Host {
    pub(super) fn recover_queued_input(self: &Arc<Self>) {
        let root = self.home.join(&self.storage);
        let recovery = recover_missing_transcripts(&root, self.ownership());
        let mut reported = HashSet::new();
        report(self, &recovery, &mut reported);
        if !recovery.retry { return; }
        let weak = Arc::downgrade(self);
        let ownership = self.ownership.get().expect("Ownership initialized before recovery").clone();
        let stopped = ownership.shutdown_signal();
        tokio::spawn(retry_recovery(weak, root, ownership, recovery, reported, stopped));
    }
}

async fn retry_recovery(
    host: Weak<Host>, root: PathBuf, ownership: Arc<ConversationOwnership>,
    mut recovery: Recovery, mut reported: HashSet<String>, mut stopped: watch::Receiver<bool>,
) {
    let mut delay = Duration::from_secs(1);
    while recovery.retry {
        tokio::select! {
            _ = stopped.wait_for(|stop| *stop) => break,
            _ = tokio::time::sleep(delay) => {},
        }
        delay = (delay * 2).min(Duration::from_secs(60));
        let result = tokio::select! {
            _ = stopped.wait_for(|stop| *stop) => break,
            result = retry_once(&root, &ownership, recovery.transactions_pending) => result,
        };
        recovery = result.unwrap_or_else(|error| Recovery {
            errors: vec![error], retry: true, transactions_pending: recovery.transactions_pending, ..Recovery::default()
        });
        let Some(host) = host.upgrade() else { break; };
        report(&host, &recovery, &mut reported);
    }
}

async fn retry_once(root: &Path, ownership: &Arc<ConversationOwnership>, transactions_pending: bool) -> Result<Recovery> {
    if transactions_pending { replay_transactions(root).await?; }
    let root = root.to_owned();
    let ownership = ownership.clone();
    tokio::task::spawn_blocking(move || recover_missing_transcripts(&root, &ownership)).await.map_err(|error| error.to_string())
}

fn report(host: &Host, recovery: &Recovery, reported: &mut HashSet<String>) {
    for error in &recovery.errors {
        if reported.insert(error.clone()) {
            host.output(json!({"type":"diagnostic","line":format!("Queued input retained for recovery: {error}")}));
        }
    }
    if recovery.recovered { host.output(json!({"type":"sessions_changed"})); }
}

async fn replay_transactions(root: &Path) -> Result<()> {
    run_recovery(root, include_str!("../../../resources/restore-archived-worktree.bundle.mjs"), &["--", "--recover"]).await
}

pub(super) async fn collect_retention(root: &Path) -> Result<()> {
    let request = json!({"retentionOnly":true,"root":root}).to_string();
    run_recovery(root, include_str!("../../../resources/delete-session.bundle.mjs"), &[&request]).await
}

async fn run_recovery(root: &Path, script: &str, arguments: &[&str]) -> Result<()> {
    let mut command = tokio::process::Command::from(crate::node_command());
    command.env("PIOP_RESTORE_ROOT", root)
        .args(["-e", script]).args(arguments)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let mut group = RecoveryProcessGroup(child.id());
    let output = child.wait_with_output().await.map_err(|error| error.to_string())?;
    #[cfg(unix)]
    { group.0 = None; }
    if !output.status.success() && output.status.code() != Some(75) {
        return Err(format!("Session storage recovery is pending: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

#[cfg(unix)]
struct RecoveryProcessGroup(Option<u32>);

#[cfg(unix)]
impl Drop for RecoveryProcessGroup {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            unsafe { libc::kill(-(id as libc::pid_t), libc::SIGKILL); }
        }
    }
}
