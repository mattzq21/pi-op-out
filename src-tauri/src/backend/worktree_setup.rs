use crate::platform::{AppHandle, State};
use serde::{Deserialize, Serialize};
use std::{fs, thread};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use super::{PiRuntime, STORAGE_DIRECTORY, WORKTREE_CLEANUP_TIMEOUT};
use super::pi_launch::{remote_host, remote_login_command, ssh};
use super::settings::load_app_settings;
use super::settings_types::{AppSettings, RemoteHost, WorktreeSetupScript};
use uuid::Uuid;
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg_attr(feature = "desktop", tauri::command)]
pub(super) fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

pub(super) fn desktop_sessions_dir(home: &Path) -> PathBuf { home.join(STORAGE_DIRECTORY).join("sessions") }

pub(super) fn ensure_desktop_sessions_dir(home: &Path) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home);
    fs::create_dir_all(&root).map_err(|error| format!("Could not create piop session directory: {error}"))?;
    Ok(root)
}

#[derive(Serialize, Deserialize)]
pub(super) struct GitSnapshotToken { pub(super) root: String, pub(super) tree: String, #[serde(default)] pub(super) repository_root: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorktree { pub(super) branch: String, pub(super) path: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorktreeRemoval {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) branch: Option<String>,
    pub(super) branch_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) warning: Option<String>,
}

pub(super) struct LimitedOutput { pub(super) status: ExitStatus, pub(super) stdout: Vec<u8>, pub(super) stderr: Vec<u8> }

#[derive(Clone, Copy)]
pub(super) enum WorktreeScriptPhase { Setup, Cleanup }

impl WorktreeScriptPhase {
    fn name(self) -> &'static str { match self { Self::Setup => "Setup", Self::Cleanup => "Cleanup" } }
    fn cancellation_message(self) -> &'static str { match self { Self::Setup => "Environment setup cancelled", Self::Cleanup => "Worktree cleanup cancelled" } }
}

struct WorktreeScriptTarget<'a> { cwd: &'a str, worktree_path: &'a str, host_id: &'a str, host: Option<&'a RemoteHost> }

pub(super) fn run_worktree_scripts(settings: &AppSettings, cwd: &str, worktree_path: &str, host_id: &str, cancelled: &AtomicBool, phase: WorktreeScriptPhase) -> Result<(), String> {
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?) };
    let target = WorktreeScriptTarget { cwd, worktree_path, host_id, host };
    let mut scripts = settings.worktree_setup_scripts.iter().filter(|setup| setup.enabled).collect::<Vec<_>>();
    if matches!(phase, WorktreeScriptPhase::Cleanup) { scripts.reverse(); }
    for setup in scripts { run_worktree_script(setup, &target, cancelled, phase)?; }
    Ok(())
}

fn run_worktree_script(setup: &WorktreeSetupScript, target: &WorktreeScriptTarget<'_>, cancelled: &AtomicBool, phase: WorktreeScriptPhase) -> Result<(), String> {
    let WorktreeScriptTarget { cwd, worktree_path, host_id, host } = *target;
    let code = match phase { WorktreeScriptPhase::Setup => setup.script.as_str(), WorktreeScriptPhase::Cleanup => setup.cleanup_script.as_deref().unwrap_or_default() };
    if code.trim().is_empty() { return Ok(()); }
    let Some(project_path) = setup.project_path.as_deref().filter(|path| !path.trim().is_empty()) else { return Ok(()); };
    if setup.host_id.as_deref().unwrap_or("local") != host_id { return Ok(()); }
    let phase_name = phase.name();
    if cancelled.load(Ordering::SeqCst) { return Err(phase.cancellation_message().into()); }
    let context = format!("{phase_name} script '{}' failed", setup.name);
    if code.len() > 32 * 1024 { return Err(format!("{context}: script exceeds 32 KiB")); }
    let completion_marker = format!("piop-worktree-script-complete-{}", Uuid::new_v4());
    let script = format!(r#"exec 4>&1
exec 1>&2
set +e
source_common=$(git -C {source} rev-parse --path-format=absolute --git-common-dir) || exit 1
source_common=$(cd -- "$source_common" && pwd -P) || exit 1
project_common=$(git -C {project} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && project_common=$(cd -- "$project_common" && pwd -P) || project_common=
if [ "$source_common" != "$project_common" ]; then
printf '\n%s 0\n' {marker} >&4
exit 0
fi
root=$(git -C {source} rev-parse --show-toplevel) || exit 1
PIOP_SOURCE_TREE_PATH=$(cd -- "$root" && pwd -P) || exit 1
PIOP_WORKTREE_BRANCH=$(git -C {target} symbolic-ref --quiet --short HEAD 2>/dev/null) || PIOP_WORKTREE_BRANCH=
cd -- {target} || exit 1
PIOP_WORKTREE_PATH=$(pwd -P) || exit 1
export PIOP_SOURCE_TREE_PATH PIOP_WORKTREE_PATH PIOP_WORKTREE_BRANCH
exec 3<&0
setup_output=$(mktemp "${{TMPDIR:-/tmp}}/piop-worktree-script.XXXXXX") || exit 1
setup_owner=$BASHPID
trap '[ "$BASHPID" != "$setup_owner" ] || rm -f -- "$setup_output"' EXIT
exec 6>"$setup_output" || exit 1
# The drain inherits no SSH streams or cancellation descriptors. It can outlive
# the script while background jobs write, retaining at most 64 KiB.
exec 5> >( trap - EXIT; exec >/dev/null 2>&1 3<&- 4>&-; dd bs=1 count=65536 >&6; exec 6>&-; cat >/dev/null )
output_pid=$!
exec 6>&-
set -m
bash -e -c {code} </dev/null >&5 2>&1 3<&- 4>&- 5>&- &
setup_pid=$!
exec 5>&-
set +m
# Keep cancellation separate from script input. EOF also stops the script if SSH disconnects.
bash -c 'IFS= read -r cancel; kill -KILL -- "-$1" 2>/dev/null' bash "$setup_pid" <&3 4>&- &
watcher=$!
wait "$setup_pid"
status=$?
kill -KILL "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
kill -0 "$output_pid" 2>/dev/null || break
sleep 0.01
done
head -c 65536 "$setup_output" >&2
rm -f -- "$setup_output"
printf '\n%s %s\n' {marker} "$status" >&4
exit "$status""#, source = shell_quote(cwd), project = shell_quote(project_path), target = shell_quote(worktree_path), code = shell_quote(code), marker = shell_quote(&completion_marker));
    let mut command = if let Some(host) = host { let mut command = ssh(host); command.arg(remote_login_command(&script)); command } else { let mut command = Command::new("bash"); command.args(["-c", &script]); command };
    let cancellation_message = phase.cancellation_message();
    let timeout = matches!(phase, WorktreeScriptPhase::Cleanup).then_some(WORKTREE_CLEANUP_TIMEOUT);
    let (status, stderr) = run_setup_process(&mut command, cancelled, &context, completion_marker, cancellation_message, timeout)?;
    if status != 0 {
        let detail = String::from_utf8_lossy(&stderr);
        return Err(format!("{context} (exit status {status}):\n{}", detail.trim()));
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(super) async fn run_worktree_setup(app: AppHandle, setup_id: String, cwd: String, worktree_path: String, host_id: Option<String>) -> Result<(), String> {
    let worker_app = app.clone();
    execute_worktree_setup(&app.state::<PiRuntime>(), &setup_id, move |cancelled| {
        let settings = load_app_settings(worker_app)?;
        let host_id = host_id.as_deref().unwrap_or("local");
        run_worktree_scripts(&settings, &cwd, &worktree_path, host_id, &cancelled, WorktreeScriptPhase::Setup)
    }).await
}

pub(super) async fn execute_worktree_setup(runtime: &PiRuntime, setup_id: &str, work: impl FnOnce(Arc<AtomicBool>) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    let cancelled = runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(setup_id).cloned().ok_or("Unknown setup")?;
    let result = crate::platform::async_runtime::spawn_blocking(move || work(cancelled)).await.map_err(|error| error.to_string());
    runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.remove(setup_id);
    result?
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(super) fn prepare_worktree_setup(runtime: State<PiRuntime>) -> Result<String, String> {
    register_worktree_setup(&runtime)
}

pub(super) fn register_worktree_setup(runtime: &PiRuntime) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.insert(id.clone(), Arc::new(AtomicBool::new(false)));
    Ok(id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(super) fn cancel_worktree_setup(runtime: State<PiRuntime>, setup_id: String) -> Result<(), String> {
    signal_worktree_setup_cancellation(&runtime, &setup_id)
}

pub(super) fn signal_worktree_setup_cancellation(runtime: &PiRuntime, setup_id: &str) -> Result<(), String> {
    if let Some(cancelled) = runtime.worktree_setups.lock().map_err(|_| "Setup lock was poisoned")?.get(setup_id) { cancelled.store(true, Ordering::SeqCst); }
    Ok(())
}

pub(super) fn run_setup_process(command: &mut Command, cancelled: &AtomicBool, context: &str, completion_marker: String, cancellation_message: &str, timeout: Option<Duration>) -> Result<(i32, Vec<u8>), String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("{context}: {error}"))?;
    let mut input = child.stdin.take();
    let stdout = child.stdout.take().ok_or("Setup stdout was unavailable")?;
    let (completed_tx, completed_rx) = mpsc::channel();
    thread::spawn(move || {
        let prefix = format!("{completion_marker} ");
        let mut line = Vec::new();
        for byte in BufReader::new(stdout).bytes() {
            let Ok(byte) = byte else { break };
            if byte == b'\n' {
                if let Some(status) = std::str::from_utf8(&line).ok().and_then(|line| line.strip_prefix(&prefix)).and_then(|status| status.parse::<i32>().ok()) {
                    let _ = completed_tx.send(status);
                    break;
                }
                line.clear();
            } else if line.len() < 256 { line.push(byte); }
        }
    });
    let mut stderr = child.stderr.take().ok_or("Setup stderr was unavailable")?;
    let retained = Arc::new(Mutex::new(Vec::new()));
    let reader_output = retained.clone();
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 { break; }
            let mut output = reader_output.lock().unwrap();
            let remaining = (64 * 1024usize).saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        let _ = done_tx.send(());
    });
    let wait = SetupWait { cancelled, context, cancellation_message, timeout };
    let (status, stop_reason) = wait_setup_process(&mut child, &mut input, &completed_rx, wait)?;
    drop(input);
    if let Some(reason) = stop_reason { return Err(reason); }
    if cancelled.load(Ordering::SeqCst) { return Err(cancellation_message.into()); }
    let _ = done_rx.recv_timeout(Duration::from_millis(100));
    let stderr = retained.lock().map_err(|_| "Setup output lock was poisoned")?.clone();
    Ok((status, stderr))
}

struct SetupWait<'a> { cancelled: &'a AtomicBool, context: &'a str, cancellation_message: &'a str, timeout: Option<Duration> }

impl SetupWait<'_> {
    fn cancellation_reason(&self, started_at: Instant) -> Option<String> {
        if self.cancelled.load(Ordering::SeqCst) { return Some(self.cancellation_message.to_string()); }
        if self.timeout.is_some_and(|limit| started_at.elapsed() >= limit) { return Some(format!("{} timed out after 5 minutes", self.context)); }
        None
    }
}

fn signal_setup_stop(input: &mut Option<ChildStdin>, reason: &Option<String>, stopping_at: &mut Option<Instant>) {
    if reason.is_some() && stopping_at.is_none() {
        if let Some(mut input) = input.take() { let _ = input.write_all(b"cancel\n"); }
        *stopping_at = Some(Instant::now());
    }
}

fn wait_setup_process(child: &mut Child, input: &mut Option<ChildStdin>, completed_rx: &mpsc::Receiver<i32>, wait: SetupWait<'_>) -> Result<(i32, Option<String>), String> {
    let started_at = Instant::now();
    let mut stopping_at = None;
    let mut stop_reason = None;
    let status = loop {
        if stop_reason.is_none() { stop_reason = wait.cancellation_reason(started_at); }
        signal_setup_stop(input, &stop_reason, &mut stopping_at);
        if stopping_at.is_some_and(|started: Instant| started.elapsed() >= Duration::from_secs(2)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(stop_reason.unwrap_or_else(|| wait.cancellation_message.to_string()));
        }
        if let Ok(status) = completed_rx.try_recv() {
            let _ = child.kill();
            let _ = child.wait();
            break status;
        }
        match child.try_wait() {
            Ok(Some(status)) => break completed_rx.recv_timeout(Duration::from_millis(100)).unwrap_or_else(|_| status.code().unwrap_or(1)),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => { drop(input.take()); let _ = child.kill(); let _ = child.wait(); return Err(format!("{}: {error}", wait.context)); }
        }
    };
    Ok((status, stop_reason))
}

pub(super) fn run_limited(command: &mut Command, max_stdout: usize, context: &str) -> Result<LimitedOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("{context}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{context}: stdout was unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{context}: stderr was unavailable"))?;
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr; let mut retained = Vec::new(); let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => { let remaining = (64 * 1024usize).saturating_sub(retained.len()); retained.extend_from_slice(&buffer[..count.min(remaining)]); }
            }
        }
        retained
    });
    let mut bytes = Vec::new(); stdout.take((max_stdout + 1) as u64).read_to_end(&mut bytes).map_err(|error| format!("{context}: {error}"))?;
    let oversized = bytes.len() > max_stdout;
    if oversized { let _ = child.kill(); }
    let status = child.wait().map_err(|error| format!("{context}: {error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if oversized { return Err(format!("{context}: output exceeded {} MiB", max_stdout / 1024 / 1024)); }
    Ok(LimitedOutput { status, stdout: bytes, stderr })
}
