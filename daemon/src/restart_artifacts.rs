use crate::daemon_endpoint;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{OnceLock, atomic::{AtomicBool, Ordering}}, thread, time::Duration};

#[derive(Deserialize, Serialize)]
struct Record {
    id: String,
    digest: Option<String>,
}

pub(crate) struct Backup {
    pub(crate) path: PathBuf,
    id: String,
    lease: Option<File>,
    _references: Vec<File>,
    handed_off: bool,
}

fn directory() -> Result<PathBuf, String> {
    let directory = daemon_endpoint::directory()?;
    crate::ensure_private_dir(&directory)?;
    fs::canonicalize(directory).map_err(|error| error.to_string())
}

fn identity(id: &str) -> Result<String, String> {
    let canonical = uuid::Uuid::parse_str(id).map_err(|_| "Invalid restart artifact identity")?.to_string();
    if canonical != id { return Err("Invalid restart artifact identity".into()); }
    Ok(canonical)
}

fn name(id: &str) -> String { format!("restart-{id}{}", std::env::consts::EXE_SUFFIX) }

fn open_lock(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(path).map_err(|error| error.to_string())?;
    crate::set_private_file_permissions(path)?;
    Ok(file)
}

fn gate(directory: &Path) -> Result<File, String> {
    let file = open_lock(&directory.join("restart-artifacts.lock"))?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

pub(crate) fn publication_lock() -> Result<File, String> { gate(&directory()?) }

fn lease_at(directory: &Path, id: &str) -> Result<File, String> {
    identity(id)?;
    let file = open_lock(&directory.join(format!("restart-{id}.lock")))?;
    file.lock_shared().map_err(|error| error.to_string())?;
    Ok(file)
}

fn record_path(directory: &Path, id: &str) -> PathBuf { directory.join(format!("restart-{id}.artifact.json")) }

fn save_record(directory: &Path, record: &Record) -> Result<(), String> {
    crate::restart_storage::save_backup(directory, &record.id, record)
}

fn hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let length = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 { break; }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

impl Backup {
    pub(crate) fn create(id: &str, executable: &Path) -> Result<Self, String> {
        identity(id)?;
        let directory = directory()?;
        let references = reference_lease(executable)?.into_iter().collect();
        let (target, lease) = reserve(&directory, id)?;
        let backup = Self { path: target, id: id.into(), lease: Some(lease), _references: references, handed_off: false };
        backup.copy(&directory)?;
        Ok(backup)
    }

    fn copy(&self, directory: &Path) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        let source = PathBuf::from("/proc/self/exe");
        #[cfg(not(target_os = "linux"))]
        let source = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut source = File::open(source).map_err(|error| error.to_string())?;
        let mut target = OpenOptions::new().write(true).truncate(true).open(&self.path).map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut target).and_then(|_| target.flush()).and_then(|_| target.sync_all()).map_err(|error| error.to_string())?;
        save_record(directory, &Record { id: self.id.clone(), digest: Some(hash(&self.path)?) })
    }

    pub(crate) fn hand_off(mut self) { self.handed_off = true; }
}

fn reserve(directory: &Path, id: &str) -> Result<(PathBuf, File), String> {
    let _gate = gate(directory)?;
    let lease = lease_at(directory, id)?;
    let target = directory.join(name(id));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o700); }
    options.open(&target).map_err(|error| error.to_string())?;
    if let Err(error) = save_record(directory, &Record { id: id.into(), digest: None }) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    Ok((target, lease))
}

impl Drop for Backup {
    fn drop(&mut self) {
        self.lease.take();
        if self.handed_off { return; }
        if let Err(error) = cleanup_failed(&self.id) { eprintln!("Restart preparation cleanup remains pending for {}: {error}", self.path.display()); }
    }
}

fn read_value(path: &Path) -> Result<Option<Value>, String> { crate::restart_storage::read(path) }

fn active_phase(status: Option<&Value>) -> bool {
    status.is_none_or(|status| !matches!(status["phase"].as_str(), Some("failed" | "complete" | "rolled_back")))
}

fn try_exclusive(directory: &Path, id: &str) -> Result<Option<File>, String> {
    let lease = open_lock(&directory.join(format!("restart-{id}.lock")))?;
    match lease.try_lock() {
        Ok(()) => Ok(Some(lease)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

pub(crate) fn active_plan() -> Result<bool, String> {
    let directory = directory()?;
    let _gate = gate(&directory)?;
    let Some(plan) = read_value(&directory.join("restart-plan.json"))? else { return Ok(false); };
    active_plan_at(&directory, &plan)
}

fn active_plan_at(directory: &Path, plan: &Value) -> Result<bool, String> {
    let id = identity(plan["id"].as_str().ok_or("Invalid restart plan identity")?)?;
    if !plan_phase_active(directory, &id)? { return Ok(false); }
    if try_exclusive(directory, &id)?.is_none() { return Ok(true); }
    if record_matches(&directory.join(name(&id)), &id)? == Some(true) { return Ok(false); }
    Ok(owner_alive(plan))
}

fn plan_phase_active(directory: &Path, id: &str) -> Result<bool, String> {
    let status = read_value(&directory.join("restart-status.json"))?;
    Ok(active_phase(status.as_ref().filter(|status| status["restartId"] == id)))
}

fn owner_alive(plan: &Value) -> bool {
    let Some(pid) = plan["owner"].as_u64().and_then(|pid| i32::try_from(pid).ok()).filter(|pid| *pid > 0) else { return true; };
    #[cfg(unix)]
    { unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) } }
    #[cfg(not(unix))]
    { let _ = pid; true }
}

fn backup_id(path: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?.strip_suffix(" (deleted)").unwrap_or(path.file_name()?.to_str()?);
    let id = file.strip_prefix("restart-")?.strip_suffix(std::env::consts::EXE_SUFFIX)?;
    identity(id).ok()
}

fn current_leases(directory: &Path) -> Result<Vec<File>, String> {
    let _gate = gate(directory)?;
    let mut leases = Vec::new();
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    if let Some(lease) = reference_lease(&executable)? { leases.push(lease); }
    if let Some(plan) = operation_plan(directory)? { leases.extend(operation_leases(directory, &plan)?); }
    Ok(leases)
}

fn operation_leases(directory: &Path, plan: &Value) -> Result<Vec<File>, String> {
    let id = identity(plan["id"].as_str().ok_or("Invalid restart plan identity")?)?;
    let mut leases = vec![lease_at(directory, &id)?];
    leases.extend(plan_references(plan)?);
    Ok(leases)
}

fn operation_plan(directory: &Path) -> Result<Option<Value>, String> {
    if !matches!(std::env::args().nth(1).as_deref(), Some("--restart-coordinator" | "--validate-plugins" | "--restart-candidate")) { return Ok(None); }
    let id = identity(&std::env::args().nth(2).ok_or("Missing restart identity")?)?;
    let plan = read_value(&directory.join("restart-plan.json"))?.ok_or("Restart plan is missing")?;
    if plan["id"] != id { return Err("The restart plan has changed".into()); }
    Ok(Some(plan))
}

fn reference_lease(path: &Path) -> Result<Option<File>, String> {
    let Some(id) = backup_id(path) else { return Ok(None); };
    let directory = fs::canonicalize(path.parent().ok_or("Restart executable has no directory")?).map_err(|error| error.to_string())?;
    let profile = fs::canonicalize(crate::home_dir()?.join(crate::STORAGE_DIRECTORY)).map_err(|error| error.to_string())?;
    if !directory.starts_with(profile) { return Ok(None); }
    lease_at(&directory, &id).map(Some)
}

fn plan_references(plan: &Value) -> Result<Vec<File>, String> {
    let mut leases = Vec::new();
    for field in ["executable", "fallback"] {
        let path = Path::new(plan[field].as_str().ok_or("Invalid restart executable path")?);
        if let Some(lease) = reference_lease(path)? { leases.push(lease); }
    }
    Ok(leases)
}

pub(crate) fn initialize() -> Result<(), String> {
    static LEASES: OnceLock<Result<Vec<File>, String>> = OnceLock::new();
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !needs_lease()? { return Ok(()); }
    let result = LEASES.get_or_init(|| current_leases(&directory()?));
    if let Err(error) = result { return Err(error.clone()); }
    if !matches!(std::env::args().nth(1).as_deref(), Some("--serve" | "--exit-on-disconnect" | "--restart-candidate" | "--restart-coordinator")) { return Ok(()); }
    if STARTED.swap(true, Ordering::SeqCst) { return Ok(()); }
    thread::Builder::new().name("piop-restart-cleanup".into()).spawn(|| loop {
        if let Err(error) = reconcile() { eprintln!("Restart artifact cleanup remains pending: {error}"); }
        thread::sleep(Duration::from_secs(30));
    }).map_err(|error| error.to_string())?;
    Ok(())
}

fn needs_lease() -> Result<bool, String> {
    let mode = std::env::args().nth(1);
    if matches!(mode.as_deref(), Some("--serve" | "--exit-on-disconnect" | "--restart-candidate" | "--restart-coordinator" | "--validate-plugins")) { return Ok(true); }
    Ok(backup_id(&std::env::current_exe().map_err(|error| error.to_string())?).is_some())
}

fn cleanup_failed(id: &str) -> Result<(), String> {
    let directory = directory()?;
    let _gate = gate(&directory)?;
    let Some(_lease) = try_exclusive(&directory, id)? else { return Ok(()); };
    if !unused_executable(&directory.join(name(id)), true)? { return Ok(()); }
    remove_plan(&directory, id)?;
    remove_backup(&directory, id)
}

fn remove_plan(directory: &Path, id: &str) -> Result<(), String> {
    let plan_path = directory.join("restart-plan.json");
    if read_value(&plan_path)?.is_some_and(|plan| plan["id"] == id) { crate::restart_storage::remove(&plan_path)?; }
    let status_path = directory.join("restart-status.json");
    if read_value(&status_path)?.is_some_and(|status| status["restartId"] == id && active_phase(Some(&status))) {
        crate::restart_storage::remove(&status_path)?;
    }
    Ok(())
}

fn remove_backup(directory: &Path, id: &str) -> Result<(), String> {
    for path in [directory.join(name(id)), record_path(directory, id)] {
        match fs::remove_file(path) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.to_string()) }
    }
    crate::restart_storage::remove_backup(directory, id)
}

pub(crate) fn reconcile() -> Result<(), String> {
    let directory = directory()?;
    let _gate = gate(&directory)?;
    let plan = read_value(&directory.join("restart-plan.json"))?;
    let status = read_value(&directory.join("restart-status.json"))?;
    for id in crate::restart_storage::backups(&directory)? {
        identity(&id)?;
        reconcile_backup(&directory, &directory.join(name(&id)), &id, plan.as_ref(), status.as_ref())?;
    }
    Ok(())
}

fn reconcile_backup(directory: &Path, path: &Path, id: &str, plan: Option<&Value>, status: Option<&Value>) -> Result<(), String> {
    let Some(_lease) = try_exclusive(directory, id)? else { return Ok(()); };
    let Some(recorded) = removable_backup(path, id)? else { return Ok(()); };
    if plan_retains(directory, path, id, recorded, plan, status)? { return Ok(()); }
    remove_plan(directory, id)?;
    remove_backup(directory, id)
}

fn backup_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn removable_backup(path: &Path, id: &str) -> Result<Option<bool>, String> {
    let Some(metadata) = backup_metadata(path)? else { return Ok(Some(true)); };
    if !metadata.is_file() { return Ok(None); }
    let record = record_matches(path, id)?;
    if record == Some(false) { return Ok(None); }
    if !unused_executable(path, record.is_some())? { return Ok(None); }
    Ok(Some(record.is_some()))
}

fn plan_retains(directory: &Path, path: &Path, id: &str, recorded: bool, plan: Option<&Value>, status: Option<&Value>) -> Result<bool, String> {
    if legacy_plan_active(id, recorded, plan, status) { return Ok(true); }
    referenced_by_active_plan(directory, path, id, plan)
}

fn referenced_by_active_plan(directory: &Path, path: &Path, id: &str, plan: Option<&Value>) -> Result<bool, String> {
    let Some(plan) = plan.filter(|plan| plan["id"] != id) else { return Ok(false); };
    let referenced = ["executable", "fallback"].iter().any(|field| plan[field].as_str().is_some_and(|target| {
        Path::new(target) == path || fs::canonicalize(target).ok().as_deref() == Some(path)
    }));
    if !referenced { return Ok(false); }
    active_plan_at(directory, plan)
}

fn record_matches(path: &Path, id: &str) -> Result<Option<bool>, String> {
    let Some(record) = crate::restart_storage::read_backup(path.parent().ok_or("Restart artifact has no directory")?, id)? else { return Ok(None); };
    let record: Record = serde_json::from_value(record).map_err(|error| error.to_string())?;
    Ok(Some(record.id == id && record.digest.is_none_or(|expected| hash(path).ok().as_deref() == Some(expected.as_str()))))
}

fn legacy_plan_active(id: &str, recorded: bool, plan: Option<&Value>, status: Option<&Value>) -> bool {
    if recorded { return false; }
    plan.filter(|plan| plan["id"] == id).is_some_and(|plan| active_phase(status.filter(|status| status["restartId"] == id)) && owner_alive(plan))
}

#[cfg(target_os = "linux")]
fn unused_executable(path: &Path, _recorded: bool) -> Result<bool, String> {
    let artifact = match fs::metadata(path) {
        Ok(artifact) => artifact,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.to_string()),
    };
    no_process_references(path, &artifact)
}

#[cfg(target_os = "linux")]
fn no_process_references(path: &Path, artifact: &fs::Metadata) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    for process in fs::read_dir("/proc").map_err(|error| error.to_string())? {
        let process = process.map_err(|error| error.to_string())?;
        if !owned_process(&process, artifact.uid())? { continue; }
        if process_references(&process.path(), path, artifact)? { return Ok(false); }
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn owned_process(process: &fs::DirEntry, owner: u32) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    if process.file_name().to_str().is_none_or(|name| name.parse::<u32>().is_err()) { return Ok(false); }
    match process.metadata() {
        Ok(metadata) => Ok(metadata.uid() == owner),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn process_references(process: &Path, artifact_path: &Path, artifact: &fs::Metadata) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    match fs::metadata(process.join("exe")) {
        Ok(executable) if executable.dev() == artifact.dev() && executable.ino() == artifact.ino() => return Ok(true),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    process_arguments_reference(process, artifact_path)
}

#[cfg(target_os = "linux")]
fn process_arguments_reference(process: &Path, artifact_path: &Path) -> Result<bool, String> {
    match fs::read(process.join("cmdline")) {
        Ok(arguments) => Ok(backup_id(artifact_path).is_some_and(|id| arguments.split(|byte| *byte == 0).any(|argument| argument == id.as_bytes()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
fn unused_executable(_path: &Path, recorded: bool) -> Result<bool, String> { Ok(recorded) }
