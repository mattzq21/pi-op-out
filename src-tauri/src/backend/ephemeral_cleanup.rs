use std::{fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Once, thread, time::Duration};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::{RemoteHost, STORAGE_DIRECTORY, hash_claim_key, node_command};
use crate::environment::home_dir;
use crate::pi_launch::{EphemeralSession, remote_login_command, ssh};
use crate::private_fs::ensure_private_dir;
use crate::worktree_setup::shell_quote;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Location {
    Local { path: PathBuf },
    Remote { host: RemoteHost, path: String },
}

impl Location {
    fn session(&self) -> EphemeralSession {
        match self { Self::Local { path } => EphemeralSession::Local(path.clone()), Self::Remote { host, path } => EphemeralSession::Remote { host: host.clone(), path: path.clone() } }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    token: String,
    owner: String,
    session_id: String,
    identity: String,
    location: Location,
    queued: bool,
    claims: Vec<String>,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inspection { session_id: String, identity: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion { complete: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inactivity { inactive: bool, transcript_present: bool, recover_pending: bool }

pub(super) struct CleanupOutcome {
    pub(super) transferred: bool,
    pub(super) error: Option<String>,
}

fn root_at(home: &Path) -> PathBuf { home.join(STORAGE_DIRECTORY).join("ephemeral-cleanup").join("owners") }

fn record_path(root: &Path, session: &EphemeralSession) -> PathBuf {
    let machine = match session { EphemeralSession::Local(_) => "local", EphemeralSession::Remote { host, .. } => &host.target };
    root.join(format!("{}.json", hash_claim_key(format!("{machine}\n{}", session.path()).as_bytes())))
}

fn private_open(path: &Path, create_new: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new { options.create_new(true); } else { options.create(true).truncate(false); }
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    options.open(path).map_err(|error| format!("Ephemeral cleanup storage {}: {error}", path.display()))
}

fn lock(root: &Path) -> Result<File, String> {
    ensure_directory(root)?;
    let file = private_open(&root.join("queue.lock"), false)?;
    file.try_lock().map_err(|error| format!("Ephemeral cleanup queue is busy or unavailable: {error}"))?;
    Ok(file)
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    if path.exists() { return ensure_private_dir(path); }
    ensure_directory(path.parent().ok_or("Cleanup storage has no parent")?)?;
    ensure_private_dir(path)?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    { File::open(path.parent().ok_or("Cleanup record has no parent")?).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?; }
    #[cfg(not(unix))]
    { let _ = path; }
    Ok(())
}

fn save(path: &Path, record: &Record) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = private_open(&temporary, true)?;
        file.write_all(&serde_json::to_vec(record).map_err(|error| error.to_string())?).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        sync_parent(path)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

fn read(path: &Path) -> Result<Record, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let file = options.open(path).map_err(|error| format!("Ownership record is unavailable: {error}"))?;
    let record: Record = serde_json::from_reader(file).map_err(|error| format!("Invalid ephemeral ownership record: {error}"))?;
    if record.version != 1 || record.owner.is_empty() || record.identity.is_empty() { return Err("Invalid ephemeral ownership provenance".into()); }
    Uuid::parse_str(&record.token).map_err(|_| "Invalid ephemeral ownership token")?;
    Uuid::parse_str(&record.session_id).map_err(|_| "Invalid ephemeral session identity")?;
    if record_path(path.parent().ok_or("Missing ownership root")?, &record.location.session()) != path { return Err("Ephemeral ownership location changed".into()); }
    Ok(record)
}

fn command(session: &EphemeralSession, request: &serde_json::Value, locked: bool) -> Result<Command, String> {
    let script = include_str!("../../resources/cleanup-ephemeral-session.bundle.mjs");
    let request = serde_json::to_string(request).map_err(|error| error.to_string())?;
    match session {
        EphemeralSession::Local(_) => {
            let mut command = node_command();
            command.args(["-e", script, &request]);
            if locked { command.arg("--workers-locked"); }
            Ok(command)
        }
        EphemeralSession::Remote { host, .. } => {
            let remote = format!("PIOP_STORAGE_DIRECTORY={} node -e {} {}", shell_quote(STORAGE_DIRECTORY), shell_quote(script), shell_quote(&request));
            let mut command = ssh(host);
            command.arg(remote_login_command(&remote));
            Ok(command)
        }
    }
}

fn output(command: &mut Command) -> Result<Vec<u8>, String> {
    let output = crate::worktree_setup::run_limited(command, 256 * 1024, "Ephemeral cleanup helper failed")?;
    if !output.status.success() { return Err(format!("Ephemeral cleanup failed: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(output.stdout)
}

pub(super) fn register_at(home: &Path, session: &EphemeralSession, owner: &str, expected_id: Option<&str>) -> Result<(), String> {
    let root = root_at(home);
    let _lock = lock(&root)?;
    let path = record_path(&root, session);
    if path.exists() { return adopt_record(&path, owner, expected_id); }
    let request = serde_json::json!({"action":"inspect", "path":session.path(), "sessionId":expected_id});
    let inspected: Inspection = serde_json::from_slice(&output(&mut command(session, &request, false)?)?).map_err(|error| format!("Invalid ephemeral inspection: {error}"))?;
    Uuid::parse_str(&inspected.session_id).map_err(|_| "Invalid ephemeral session identity")?;
    let location = match session { EphemeralSession::Local(path) => Location::Local { path: path.clone() }, EphemeralSession::Remote { host, path } => Location::Remote { host: host.clone(), path: path.clone() } };
    let record = Record { version: 1, token: Uuid::new_v4().to_string(), owner: owner.into(), session_id: inspected.session_id, identity: inspected.identity, location, queued: false, claims: Vec::new(), last_error: None };
    save(&path, &record)
}

fn adopt_record(path: &Path, owner: &str, expected_id: Option<&str>) -> Result<(), String> {
    let mut record = read(path)?;
    if record.queued { return Err("Side conversation is already queued for cleanup and cannot be reused".into()); }
    if expected_id.is_some_and(|id| id != record.session_id) { return Err("Side conversation session identity changed".into()); }
    record.owner = owner.into();
    save(path, &record)
}

pub(super) fn adopt(session: &EphemeralSession, owner: &str) -> Result<(), String> {
    let root = root_at(&home_dir()?);
    let _lock = lock(&root)?;
    adopt_record(&record_path(&root, session), owner, None)
}

pub(super) fn bind_claim(session: &EphemeralSession, claim: &str) -> Result<(), String> {
    let root = root_at(&home_dir()?);
    let _lock = lock(&root)?;
    let path = record_path(&root, session);
    let mut record = read(&path)?;
    if record.queued { return Err("Side conversation is queued for cleanup".into()); }
    if !record.claims.iter().any(|id| id == claim) { record.claims.push(claim.into()); }
    save(&path, &record)
}

pub(super) fn inherit_claims(previous: &EphemeralSession, session: &EphemeralSession, claim: &str) -> Result<(), String> {
    let root = root_at(&home_dir()?);
    let _lock = lock(&root)?;
    let previous = read(&record_path(&root, previous))?;
    let path = record_path(&root, session);
    let mut record = read(&path)?;
    if record.queued { return Err("Side conversation is queued for cleanup".into()); }
    record.claims.extend(previous.claims);
    record.claims.extend([previous.session_id, claim.to_owned()]);
    record.claims.sort(); record.claims.dedup();
    save(&path, &record)
}

fn inherit_lock(handle: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let descriptor = handle.as_raw_fd();
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 { return Err("Could not retain inactivity locks in the cleanup helper".into()); }
        Ok(())
    }
    #[cfg(not(unix))]
    { let _ = handle; Err("Cleanup requires inherited worker claim locks on this platform; artifacts retained".into()) }
}

fn worker_paths(record: &Record, profile: &Path) -> Result<Vec<PathBuf>, String> {
    let claims = profile.join("session-claims");
    ensure_private_dir(&claims)?;
    let id = Uuid::parse_str(&record.session_id).map_err(|_| "Invalid ephemeral identity")?.to_string();
    let mut paths = vec![claims.join(format!("id-{}.lock", hash_claim_key(id.as_bytes())))];
    for claim in &record.claims { paths.push(claims.join(format!("id-{}.lock", hash_claim_key(claim.to_lowercase().as_bytes())))); }
    paths.sort(); paths.dedup();
    Ok(paths)
}

fn local_locks(record: &Record) -> Result<Vec<File>, String> {
    let session = record.location.session();
    if matches!(session, EphemeralSession::Remote { .. }) { return Ok(Vec::new()); }
    let profile = home_dir()?.join(STORAGE_DIRECTORY);
    let paths = worker_paths(record, &profile)?;
    let mut handles = Vec::new();
    for path in paths {
        let handle = private_open(&path, false)?;
        handle.try_lock().map_err(|error| format!("Side conversation or its storage is still in use; cleanup retained: {error}"))?;
        inherit_lock(&handle)?;
        handles.push(handle);
    }
    Ok(handles)
}

fn worker_descriptors(command: &mut Command, handles: &[File]) {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if !handles.is_empty() { command.env("PIOP_EPHEMERAL_WORKER_FDS", handles.iter().map(|file| file.as_raw_fd().to_string()).collect::<Vec<_>>().join(",")); }
    }
    #[cfg(not(unix))]
    { let _ = (command, handles); }
}

fn perform(record: &Record, authorized: impl FnOnce(bool) -> Result<(), String>) -> Result<(), String> {
    let workers = local_locks(record)?;
    let session = record.location.session();
    let request = serde_json::json!({"action":"cleanup", "path":session.path(), "sessionId":record.session_id, "identity":record.identity, "token":record.token, "owner":record.owner, "claims":record.claims});
    let mut command = command(&session, &request, matches!(session, EphemeralSession::Local(_)))?;
    worker_descriptors(&mut command, &workers);
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| error.to_string())?;
    let stderr = child.stderr.take().ok_or("Cleanup helper errors unavailable")?;
    let errors = thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut bytes = Vec::new();
        let _ = reader.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        bytes
    });
    let mut output = BufReader::new(child.stdout.take().ok_or("Cleanup helper output unavailable")?);
    let result = (|| {
        let mut line = String::new();
        output.by_ref().take(4096).read_line(&mut line).map_err(|error| error.to_string())?;
        let inactive: Inactivity = serde_json::from_str(&line).map_err(|error| format!("Cleanup inactivity was not confirmed: {error}"))?;
        if !inactive.inactive { return Err("Cleanup inactivity was not confirmed".into()); }
        authorized(inactive.transcript_present && inactive.recover_pending)?;
        let mut input = child.stdin.take().ok_or("Cleanup helper authorization input unavailable")?;
        input.write_all(b"cleanup-authorized\n").and_then(|_| input.flush()).map_err(|error| error.to_string())?;
        drop(input);
        let completed: Completion = serde_json::from_reader(output.by_ref().take(4096)).map_err(|error| format!("Cleanup completion was not confirmed: {error}"))?;
        if !completed.complete { return Err("Cleanup completion was not confirmed".into()); }
        Ok(())
    })();
    if result.is_err() { let _ = child.kill(); }
    drop(child.stdin.take());
    let status = child.wait().map_err(|error| error.to_string())?;
    let errors = errors.join().map_err(|_| "Cleanup helper error reader stopped")?;
    if !status.success() { return Err(format!("{}: {}", result.err().unwrap_or_else(|| "Cleanup helper failed".into()), String::from_utf8_lossy(&errors).trim())); }
    result
}

fn attempt(path: &Path, record: &Record) -> Result<(), String> {
    perform(record, |recover| recover_pending(record, recover))?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    sync_parent(path)
}

pub(super) fn release(session: &EphemeralSession, drain: impl FnOnce() -> Result<(), String>) -> CleanupOutcome {
    match queue(session) {
        Ok((path, mut record, _lock)) => {
            let mut transferred = record.queued;
            let request = record.clone();
            let result = perform(&request, |recover| {
                drain()?;
                record.queued = true;
                save(&path, &record)?;
                transferred = true;
                recover_pending(&request, recover)
            }).and_then(|_| { fs::remove_file(&path).map_err(|error| error.to_string())?; sync_parent(&path) });
            if let Err(error) = &result {
                let mut failed = record;
                failed.last_error = Some(error.clone());
                if let Err(save_error) = save(&path, &failed) { eprintln!("Cleanup is queued, but its last error could not be updated: {save_error}"); }
            }
            CleanupOutcome { transferred, error: result.err().map(|error| if transferred { format!("{error}; retained in the durable ephemeral cleanup queue for retry") } else { format!("{error}; inactivity or capture eligibility is unproven, runtime and durable active ownership retained") }) }
        }
        Err(error) => CleanupOutcome { transferred: false, error: Some(format!("{error}; runtime ownership retained because durable transfer failed")) },
    }
}

fn recover_pending(record: &Record, required: bool) -> Result<(), String> {
    if !required { return Ok(()); }
    let session = record.location.session();
    let host = match &record.location { Location::Local { .. } => None, Location::Remote { host, .. } => Some(host) };
    crate::git_diffs::recover_ephemeral_git_diffs_at_host(&session.path(), &record.session_id, host)
        .map_err(|error| format!("Ephemeral comparison recovery retained its transcript and global snapshots: {error}"))
}

fn queue(session: &EphemeralSession) -> Result<(PathBuf, Record, File), String> {
    let root = root_at(&home_dir()?);
    let lock = lock(&root)?;
    let path = record_path(&root, session);
    let record = read(&path)?;
    Ok((path, record, lock))
}

fn retry() -> Result<(), String> {
    let root = root_at(&home_dir()?);
    let _lock = lock(&root)?;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        retry_record(&path)?;
    }
    Ok(())
}

fn retry_record(path: &Path) -> Result<(), String> {
    let mut record = match read(path) { Ok(record) => record, Err(error) => { eprintln!("Ephemeral cleanup record retained: {error}"); return Ok(()); } };
    if !record.queued { return Ok(()); }
    if let Err(error) = attempt(path, &record) {
        if record.last_error.as_deref() != Some(&error) { eprintln!("Ephemeral cleanup retry retained {}: {error}", record.location.session().path()); }
        record.last_error = Some(error);
        save(path, &record)?;
    }
    Ok(())
}

pub(super) fn start_retries() {
    static START: Once = Once::new();
    START.call_once(|| {
        let result = thread::Builder::new().name("ephemeral-cleanup".into()).spawn(|| loop {
            if let Err(error) = retry() { eprintln!("Ephemeral cleanup retry is pending: {error}"); }
            thread::sleep(Duration::from_secs(60));
        });
        if let Err(error) = result { eprintln!("Could not start durable ephemeral cleanup retries: {error}"); }
    });
}
