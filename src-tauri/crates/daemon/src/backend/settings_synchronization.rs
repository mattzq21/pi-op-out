use super::{atomic_write_private, ensure_private_dir, set_private_file_permissions, settings_path};
use crate::private_fs::{publish_private, Publication as SettingsPublication};
use crate::{AppSettings, PiRuntime, daemon, daemon_endpoint, platform::AppHandle, settings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::{self, File, OpenOptions}, path::{Path, PathBuf}, sync::{TryLockError, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

const MAX_REVISION: u64 = 9_007_199_254_740_991;
static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Publication {
    revision: u64,
    digest: String,
    agent_host_id: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub(crate) revision: u64,
    digest: String,
    pub(crate) agent_revisions: BTreeMap<String, u64>,
    publication: Option<Publication>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Progress {
    revision: u64,
    synchronized: bool,
    notified: bool,
    phase_revision: u64,
}

pub(crate) struct Save {
    path: PathBuf,
    progress_path: PathBuf,
    journal: Journal,
    publication: Publication,
}

fn digest(body: &[u8]) -> String { format!("{:x}", Sha256::digest(body)) }

fn current_digest(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(body) => Ok(digest(&body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(digest(&[])),
        Err(error) => Err(error.to_string()),
    }
}

fn journal_path(path: &Path) -> PathBuf { path.with_extension("synchronization.json") }

fn progress_path(path: &Path) -> Result<PathBuf, String> {
    let owner = digest(daemon_endpoint::directory()?.to_string_lossy().as_bytes());
    Ok(path.with_extension(format!("synchronization-{owner}.json")))
}

fn read_record<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice(&body).map_err(|error| format!("Could not read settings synchronization record {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_record(path: &Path, value: &impl Serialize) -> Result<(), String> {
    atomic_write_private(path, &serde_json::to_vec(value).map_err(|error| error.to_string())?)?;
    #[cfg(unix)]
    File::open(path.parent().ok_or("Synchronization record has no directory")?).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn storage_lock(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("Settings have no storage directory")?;
    ensure_private_dir(parent)?;
    let lock_path = path.with_extension("mutation.lock");
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&lock_path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&lock_path)?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

fn next_revision(revision: u64) -> Result<u64, String> {
    revision.checked_add(1).filter(|next| *next <= MAX_REVISION).ok_or_else(|| "Settings revision limit was reached".into())
}

impl Journal {
    fn publish(&mut self, publication: Publication) {
        self.revision = publication.revision;
        self.digest = publication.digest;
        if let Some(host) = publication.agent_host_id { self.agent_revisions.insert(host, self.revision); }
        self.publication = None;
    }

    fn reconcile(&mut self, path: &Path) -> Result<(), String> {
        let current = current_digest(path)?;
        if let Some(publication) = self.publication.take() {
            if current == publication.digest { self.publish(publication); }
            else if current != self.digest {
                self.publish(Publication { digest: current.clone(), ..publication });
            }
        }
        if current != self.digest {
            self.revision = next_revision(self.revision)?;
            self.digest = current;
        }
        write_record(&journal_path(path), self)
    }

    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let mut journal: Self = read_record(&journal_path(path))?;
        journal.validate()?;
        journal.reconcile(path)?;
        Ok(journal)
    }

    fn validate(&self) -> Result<(), String> {
        if self.revision > MAX_REVISION || self.agent_revisions.values().any(|revision| *revision > self.revision) { return Err("Invalid stored settings revision".into()); }
        if let Some(publication) = &self.publication {
            if publication.revision != next_revision(self.revision)? || publication.digest.len() != 64 { return Err("Invalid prepared settings publication".into()); }
        }
        Ok(())
    }

    pub(crate) fn restore_agents(&self, runtime: &PiRuntime, change: &mut Value, warnings: &mut Vec<String>) {
        for (host, revision) in &self.agent_revisions {
            settings::publish_saved_agent_revision(runtime, Some(host.clone()), *revision, change, warnings);
        }
    }
}

impl Save {
    pub(crate) fn prepare(path: PathBuf, body: &[u8], agent_host_id: Option<String>) -> Result<Self, String> {
        let mut journal = Journal::load(&path)?;
        let publication = Publication { revision: next_revision(journal.revision)?, digest: digest(body), agent_host_id };
        let progress_path = progress_path(&path)?;
        journal.publication = Some(publication.clone());
        write_record(&journal_path(&path), &journal)?;
        write_record(&progress_path, &Progress { revision: publication.revision, ..Progress::default() })?;
        Ok(Self { path, progress_path, journal, publication })
    }

    pub(crate) fn publish(&mut self, body: &[u8], warnings: &mut Vec<String>) -> Result<SettingsPublication, String> {
        let result = publish_private(&self.path, body)?;
        if let Some(error) = &result.error {
            warnings.push(format!("Settings were published, but disk durability is unconfirmed: {error}. Retry saving to confirm them."));
        }
        self.journal.publish(self.publication.clone());
        if let Err(error) = write_record(&journal_path(&self.path), &self.journal) {
            warnings.push(format!("Settings were saved; durable revision publication will retry automatically: {error}"));
        }
        Ok(result)
    }

    pub(crate) fn change(&self, settings: &AppSettings) -> Value {
        json!({"settings":settings,"committed":true,"revision":self.journal.revision,"committedRevision":self.publication.revision,"source":digest(self.progress_path.to_string_lossy().as_bytes())})
    }

    pub(crate) fn restore_agents(&self, runtime: &PiRuntime, change: &mut Value, warnings: &mut Vec<String>) {
        self.journal.restore_agents(runtime, change, warnings);
        if let Some(host) = &self.publication.agent_host_id {
            change["agentConfigChange"] = json!({"hostId":host,"revision":self.publication.revision});
        } else if let Some(change) = change.as_object_mut() { change.remove("agentConfigChange"); }
    }

    pub(crate) fn finish(&self, change: &mut Value, warnings: &mut Vec<String>) {
        let progress = Progress { revision: self.journal.revision, synchronized: warnings.is_empty(), notified: false, phase_revision: 1 };
        if let Err(error) = write_record(&self.progress_path, &progress) {
            warnings.push(format!("Settings were saved; synchronization acknowledgement will retry automatically: {error}"));
        }
        change["synchronizationPending"] = json!(!warnings.is_empty());
        change["phaseRevision"] = json!(progress.phase_revision);
    }
}

fn current_change(path: &Path, journal: &Journal) -> Result<Value, String> {
    let mut current = settings::read_settings_at(path)?;
    settings::merge_discovered_skills(&mut current);
    Ok(json!({"settings":current,"committed":true,"revision":journal.revision,"source":digest(progress_path(path)?.to_string_lossy().as_bytes())}))
}

pub(crate) fn snapshot(app: &AppHandle) -> Result<Value, String> {
    start(app.clone());
    let path = settings_path(app)?;
    let _storage = storage_lock(&path)?;
    let journal = Journal::load(&path)?;
    let progress: Progress = read_record(&progress_path(&path)?)?;
    let mut change = current_change(&path, &journal)?;
    let pending = progress.revision != journal.revision || !progress.synchronized;
    change["synchronizationPending"] = json!(pending);
    change["phaseRevision"] = json!(progress.phase_revision);
    change["warnings"] = json!([]);
    add_pending_warning(&mut change, pending, journal.revision);
    Ok(change)
}

fn notify(app: &AppHandle, journal: &Journal, change: &Value) -> Result<(), String> {
    app.emit("pi://settings-changed", change).map_err(|error| error.to_string())?;
    for (host, revision) in &journal.agent_revisions {
        let mut notification = change.clone();
        notification["agentConfigChange"] = json!({"hostId":host,"revision":revision});
        app.emit("pi://settings-changed", &notification).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn publish_current(app: &AppHandle, change: &mut Value) -> Result<(), String> {
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    let path = settings_path(app)?;
    let _storage = storage_lock(&path)?;
    let journal = Journal::load(&path)?;
    publish_locked(app, &path, &journal, change)
}

fn publish_locked(app: &AppHandle, path: &Path, journal: &Journal, change: &mut Value) -> Result<(), String> {
    let owner_path = progress_path(path)?;
    let mut progress: Progress = read_record(&owner_path)?;
    let current = current_change(path, journal)?;
    change["settings"] = current["settings"].clone();
    change["revision"] = json!(journal.revision);
    change["source"] = current["source"].clone();
    canonical_agent_change(journal, change);
    let pending = progress.revision != journal.revision || !progress.synchronized;
    progress.phase_revision = next_revision(progress.phase_revision)?;
    change["synchronizationPending"] = json!(pending);
    change["phaseRevision"] = json!(progress.phase_revision);
    add_pending_warning(change, pending, journal.revision);
    write_record(&owner_path, &progress)?;
    notify(app, journal, change)?;
    if progress.revision == journal.revision {
        progress.notified = true;
        write_record(&owner_path, &progress)?;
    }
    Ok(())
}

fn canonical_agent_change(journal: &Journal, change: &mut Value) {
    let current = change["agentConfigChange"]["hostId"].as_str().and_then(|host| journal.agent_revisions.get(host).map(|revision| json!({"hostId":host,"revision":revision})));
    if let Some(current) = current { change["agentConfigChange"] = current; }
}

fn add_pending_warning(change: &mut Value, pending: bool, revision: u64) {
    if !pending { return; }
    let warnings = change["warnings"].as_array().cloned().unwrap_or_default();
    if warnings.is_empty() {
        change["warnings"] = json!([format!("Settings were saved; synchronization of revision {revision} is pending and will retry automatically.")]);
    }
}

#[derive(Default)]
struct Applied {
    revision: Option<u64>,
    notified_revision: Option<u64>,
    dictation_model: Option<Option<String>>,
    dictation_changed: bool,
    warnings: Vec<String>,
    sweep: Option<Instant>,
}

fn apply_current(app: &AppHandle, runtime: &PiRuntime, journal: &Journal, settings: &AppSettings, change: &mut Value) -> Vec<String> {
    let mut warnings = Vec::new();
    journal.restore_agents(runtime, change, &mut warnings);
    if let Err(error) = daemon::invalidate_changed(app, runtime, settings) { warnings.push(format!("Saved settings invalidation is pending and will retry automatically: {error}")); }
    if warnings.is_empty() {
        if let Err(error) = daemon::update_settings(app, runtime, settings) { warnings.push(format!("Saved settings synchronization is pending and will retry automatically: {error}")); }
    }
    warnings
}

fn retry_locked(app: &AppHandle, runtime: &PiRuntime, path: &Path, applied: &mut Applied) -> Result<bool, String> {
    let journal = Journal::load(path)?;
    let owner_path = progress_path(path)?;
    let progress: Progress = read_record(&owner_path)?;
    if !needs_retry(&journal, &progress, applied) { return Ok(false); }
    let phase_revision = if progress.revision == journal.revision { progress.phase_revision } else { 0 };
    write_record(&owner_path, &Progress { revision: journal.revision, phase_revision, ..Progress::default() })?;
    let mut settings = settings::read_settings_at(path)?;
    settings::merge_discovered_skills(&mut settings);
    schedule_effects(&settings, applied);
    let mut change = current_change(path, &journal)?;
    let warnings = apply_current(app, runtime, &journal, &settings, &mut change);
    change["warnings"] = json!(warnings);
    change["synchronizationPending"] = json!(!warnings.is_empty());
    finish_retry(app, &journal, &owner_path, &mut change, &warnings, applied)?;
    Ok(true)
}

fn needs_retry(journal: &Journal, progress: &Progress, applied: &Applied) -> bool {
    let sweep = applied.sweep.is_none_or(|last| last.elapsed() >= Duration::from_secs(30));
    applied.revision != Some(journal.revision) || progress.revision != journal.revision || !progress.synchronized || !progress.notified || sweep
}

fn schedule_effects(settings: &AppSettings, applied: &mut Applied) {
    if applied.dictation_model.as_ref() != Some(&settings.dictation_model_path) {
        applied.dictation_changed = true;
        applied.dictation_model = Some(settings.dictation_model_path.clone());
    }
}

fn finish_retry(app: &AppHandle, journal: &Journal, owner_path: &Path, change: &mut Value, warnings: &[String], applied: &mut Applied) -> Result<(), String> {
    let changed = applied.notified_revision != Some(journal.revision) || applied.warnings != warnings;
    let mut progress: Progress = read_record(owner_path)?;
    progress.revision = journal.revision;
    progress.synchronized = warnings.is_empty();
    if changed {
        progress.phase_revision = next_revision(progress.phase_revision)?;
        progress.notified = false;
        write_record(owner_path, &progress)?;
        change["phaseRevision"] = json!(progress.phase_revision);
        notify(app, journal, change)?;
        applied.notified_revision = Some(journal.revision);
        report_phase_warnings(app, warnings);
    }
    let synchronized = warnings.is_empty();
    progress.notified = true;
    write_record(owner_path, &progress)?;
    if synchronized { applied.revision = Some(journal.revision); }
    applied.sweep = Some(Instant::now());
    applied.warnings = warnings.to_vec();
    Ok(())
}

fn report_phase_warnings(app: &AppHandle, warnings: &[String]) {
    if warnings.is_empty() { return; }
    let message = warnings.join("\n");
    eprintln!("{message}");
    let _ = app.emit("pi://daemon-error", json!({"hostId":"local","line":message}));
}

fn retry_current(app: &AppHandle, applied: &mut Applied) -> Result<bool, String> {
    let restart = app.state::<crate::daemon_restart::Runtime>();
    let Ok(_gate) = restart.gate.try_read() else { return Ok(false); };
    if crate::daemon_restart::blocking() { return Ok(false); }
    let runtime = app.state::<PiRuntime>();
    let _lifecycle = match runtime.lifecycle.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => return Ok(false),
        Err(TryLockError::Poisoned(_)) => return Err("Runtime lifecycle lock was poisoned; settings synchronization requires a daemon restart".into()),
    };
    let path = settings_path(app)?;
    let _storage = storage_lock(&path)?;
    retry_locked(app, &runtime, &path, applied)
}

pub(crate) fn start(app: AppHandle) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    handle.spawn(async move {
        let mut applied = Applied::default();
        let mut last_error = None;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let owner = app.clone();
            let result = tokio::task::spawn_blocking(move || {
                let result = retry_current(&owner, &mut applied);
                apply_effects(&owner, &mut applied, result.as_ref().is_ok_and(|refreshed| *refreshed));
                (applied, result)
            }).await;
            match result {
                Ok((state, result)) => { applied = state; report_retry_error(&app, &mut last_error, result.err()); }
                Err(error) => { applied = Applied::default(); report_retry_error(&app, &mut last_error, Some(error.to_string())); }
            }
        }
    });
}

fn apply_effects(app: &AppHandle, applied: &mut Applied, refreshed: bool) {
    if refreshed { crate::peers::invalidate(app); }
    if std::mem::take(&mut applied.dictation_changed) { crate::dictation::start(app.clone()); }
}

fn report_retry_error(app: &AppHandle, previous: &mut Option<String>, error: Option<String>) {
    if *previous == error { return; }
    if let Some(error) = &error {
        eprintln!("Saved settings synchronization will retry automatically: {error}");
        let _ = app.emit("pi://daemon-error", json!({"hostId":"local","line":format!("Saved settings synchronization will retry automatically: {error}")}));
    }
    *previous = error;
}
