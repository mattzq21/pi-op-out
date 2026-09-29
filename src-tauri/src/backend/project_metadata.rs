use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use serde_json::Value;
use crate::{ProjectKind, RemoteHost, SessionSummary, MAX_REMOTE_HOSTS};

const MAX_AGE: Duration = Duration::from_secs(15);
type Fingerprint = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

struct ProjectDetails {
    exists: bool,
    kind: Option<ProjectKind>,
    root: Option<String>,
    branch: Option<String>,
    appearance: Option<Value>,
    worktree: Option<String>,
    checked: Instant,
    fingerprint: Fingerprint,
}

impl ProjectDetails {
    fn new(session: &SessionSummary, local: bool) -> Self {
        Self { exists: session.cwd_exists, kind: session.project_kind, root: session.project_root.clone(),
            branch: session.branch.clone(), appearance: session.branch_appearance.clone(), worktree: session.worktree_root.clone(),
            checked: Instant::now(), fingerprint: if local { fingerprint(&session.cwd, session.project_root.as_deref()) } else { Vec::new() } }
    }

    fn fresh(&self, cwd: &str, local: bool) -> bool {
        self.checked.elapsed() < MAX_AGE && (!local || self.fingerprint == fingerprint(cwd, self.root.as_deref()))
    }

    fn apply(&self, session: &mut SessionSummary) {
        session.cwd_exists = self.exists;
        session.project_kind = self.kind;
        session.project_root = self.root.clone();
        session.branch = self.branch.clone();
        session.branch_appearance = self.appearance.clone();
        session.worktree_root = self.worktree.clone();
    }
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
        let mut cache = shared.lock().map_err(|_| "Project metadata cache lock was poisoned")?;
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
        for session in pending { cache.entries.insert(session.cwd.clone(), ProjectDetails::new(&session, host.is_none())); }
        for session in sessions {
            if let Some(details) = cache.entries.get(&session.cwd) { details.apply(session); }
        }
        Ok(())
    }
}

fn small_file(path: &Path) -> Option<String> {
    let mut value = String::new();
    fs::File::open(path).ok()?.take(4096).read_to_string(&mut value).ok()?;
    Some(value)
}

fn stamp(path: PathBuf) -> (PathBuf, Option<(SystemTime, u64)>) {
    let value = fs::metadata(&path).ok().and_then(|metadata| Some((metadata.modified().ok()?, metadata.len())));
    (path, value)
}

fn fingerprint(cwd: &str, root: Option<&str>) -> Fingerprint {
    let cwd = Path::new(cwd).canonicalize().unwrap_or_else(|_| PathBuf::from(cwd));
    let mut result = vec![stamp(cwd.clone())];
    for parent in cwd.ancestors() {
        let git = parent.join(".git");
        result.push(stamp(git.clone()));
        if git.is_dir() { git_fingerprint(&git, &mut result); break; }
        if let Some(pointer) = small_file(&git).and_then(|value| value.strip_prefix("gitdir: ").map(|path| path.trim().to_owned())) {
            git_fingerprint(&parent.join(pointer), &mut result); break;
        }
    }
    if let Some(root) = root { result.push(stamp(Path::new(root).join(".piop/branches.json"))); }
    result
}

fn git_fingerprint(git: &Path, result: &mut Fingerprint) {
    result.push(stamp(git.join("HEAD")));
    result.push(stamp(git.join("commondir")));
    let common = small_file(&git.join("commondir")).map(|path| git.join(path.trim())).unwrap_or_else(|| git.to_path_buf());
    result.push(stamp(common.join("worktrees")));
    result.push(stamp(common.join("config")));
}
