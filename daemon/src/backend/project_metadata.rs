use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use crate::{RemoteHost, SessionSummary, MAX_REMOTE_HOSTS};

const MAX_AGE: Duration = Duration::from_secs(15);

struct ProjectDetails {
    exists: bool,
    checked: Instant,
}

impl ProjectDetails {
    fn new(session: &SessionSummary) -> Self {
        Self { exists: session.cwd_exists, checked: Instant::now() }
    }

    fn fresh(&self, cwd: &str, local: bool) -> bool {
        self.checked.elapsed() < MAX_AGE && (!local || self.exists == Path::new(cwd).is_dir())
    }

    fn apply(&self, session: &mut SessionSummary) { session.cwd_exists = self.exists; }
}

#[derive(Default)]
struct HostProjects {
    target: String,
    entries: HashMap<String, ProjectDetails>,
}

#[derive(Default)]
pub(super) struct ProjectMetadataCache {
    hosts: Mutex<HashMap<String, Arc<Mutex<HostProjects>>>>,
}

pub(super) struct Invalidation(Arc<Mutex<HostProjects>>);

impl Drop for Invalidation {
    fn drop(&mut self) { self.0.lock().unwrap_or_else(|error| error.into_inner()).entries.clear(); }
}

impl ProjectMetadataCache {
    fn host(&self, id: &str) -> Arc<Mutex<HostProjects>> {
        let mut hosts = self.hosts.lock().unwrap_or_else(|error| error.into_inner());
        if !hosts.contains_key(id) && hosts.len() > MAX_REMOTE_HOSTS {
            if let Some(key) = hosts.keys().next().cloned() { hosts.remove(&key); }
        }
        hosts.entry(id.into()).or_default().clone()
    }

    pub fn invalidate_after(&self, host_id: &str) -> Invalidation { Invalidation(self.host(host_id)) }

    pub fn inspect(&self, sessions: &mut [SessionSummary], host: Option<&RemoteHost>, inspect: impl FnOnce(&mut [SessionSummary]) -> Result<(), String>) -> Result<(), String> {
        let shared = self.host(host.map(|host| host.id.as_str()).unwrap_or("local"));
        let mut cache = shared.lock().map_err(|_| "Folder cache lock was poisoned")?;
        let target = host.map(|host| host.target.as_str()).unwrap_or("");
        if cache.target != target { cache.entries.clear(); cache.target = target.into(); }
        let mut seen = HashSet::new();
        let mut pending = Vec::new();
        for session in sessions.iter() {
            if seen.insert(session.cwd.clone()) && !cache.entries.get(&session.cwd).is_some_and(|entry| entry.fresh(&session.cwd, host.is_none())) {
                pending.push(session.clone());
            }
        }
        inspect(&mut pending)?;
        cache.entries.retain(|cwd, _| seen.contains(cwd));
        for session in pending { cache.entries.insert(session.cwd.clone(), ProjectDetails::new(&session)); }
        for session in sessions {
            if let Some(details) = cache.entries.get(&session.cwd) { details.apply(session); }
        }
        Ok(())
    }
}
