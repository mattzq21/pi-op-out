#[path = "backend/environment.rs"]
mod environment;
#[path = "backend/keybindings.rs"]
mod keybindings;
#[path = "backend/private_fs.rs"]
mod private_fs;
#[path = "backend/provider_codex.rs"]
mod provider_codex;
#[path = "backend/provider_opencode.rs"]
mod provider_opencode;
#[path = "backend/settings_types.rs"]
mod settings_types;
#[path = "backend/skill_discovery.rs"]
mod skill_discovery;
use crate::settings_types::RemoteHost;
use crate::settings_types::AppSettings;
use crate::settings_types::WorktreeSetupScript;
use crate::settings_types::MAX_REMOTE_HOSTS;
#[cfg(not(feature = "desktop"))]
mod mobile;
#[cfg(not(feature = "desktop"))]
mod mobile_commands;
mod daemon_clients;
#[cfg(not(feature = "desktop"))]
mod peers;
#[cfg(not(feature = "desktop"))]
mod daemon_stdio;
mod platform;
mod daemon_endpoint;
#[cfg(feature = "desktop")]
mod desktop_daemon;
mod provider_auth;
mod conversation_ownership;
mod session_groups;
use terminals::terminal_lookup;
#[cfg(not(feature = "desktop"))]
mod daemon;
mod dictation;
mod project_files;
#[cfg(not(feature = "desktop"))]
use session_groups::load_session_groups;
use session_groups::change_session_groups;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
    time::{Duration, Instant},
};
use crate::platform::AppHandle;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;
#[cfg(test)]
use std::time::SystemTime;
#[cfg(test)]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
#[cfg(test)]
use std::process::ExitStatus;

const STORAGE_DIRECTORY: &str = if cfg!(debug_assertions) { ".piop-dev" } else { ".piop" };
const DEVELOPMENT: bool = cfg!(debug_assertions);
#[cfg(feature = "desktop")]
const APP_TITLE: &str = if DEVELOPMENT { "Piop Dev" } else { "piop" };

fn node_command() -> Command {
    let mut command = Command::new("node");
    command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY);
    command
}

struct BlankSessionCleanup { path: Option<String>, id: Option<String>, host: Option<RemoteHost>, submitted: bool }

fn cleanup_blank_session(target: BlankSessionCleanup) {
    if target.submitted { return; }
    let root = if target.host.is_none() { home_dir().ok().map(|home| home.join(STORAGE_DIRECTORY).join("sessions")) } else { None };
    cleanup_blank_session_at(target, root.as_deref());
}

fn cleanup_blank_session_at(target: BlankSessionCleanup, root: Option<&Path>) {
    if target.submitted { return; }
    let script = include_str!("../resources/cleanup-blank-session.cjs");
    let arguments = json!({"path":target.path,"id":target.id,"root":root}).to_string();
    let result = if let Some(host) = target.host {
        ssh(&host).arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments)))).output()
    } else { node_command().arg("-e").arg(script).arg(arguments).output() };
    match result {
        Ok(output) if output.status.success() => {},
        Ok(output) => eprintln!("Could not clean up blank session: {}", String::from_utf8_lossy(&output.stderr)),
        Err(error) => eprintln!("Could not clean up blank session: {error}"),
    }
}

#[cfg(test)]
use pi_launch::EphemeralSession;

#[derive(Clone)]
struct CachedSession { fingerprint: String, summary: SessionSummary }

#[derive(Default)]
struct SessionIndexRuntime {
    local: Mutex<HashMap<PathBuf, CachedSession>>,
    remote: Mutex<HashMap<String, HashMap<String, CachedSession>>>,
}

const MAX_TERMINALS: usize = 8;
const BROKER_WORKERS: usize = 8;
const BROKER_QUEUE_DEPTH: usize = 32;
const BROKER_HEADER_BYTES: usize = 16 * 1024;
const BROKER_BODY_BYTES: usize = 1024 * 1024;
const MAX_GIT_CHANGED_PATHS: usize = 4096;
const MAX_GIT_PATH_LIST_BYTES: usize = 1024 * 1024;
const MAX_GIT_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GIT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_DIFFS_BYTES: usize = 16 * 1024 * 1024;
const MAX_AGENT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SESSION_INDEX_BATCH_BYTES: usize = 64 * 1024 * 1024;
const WORKTREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5 * 60);


use pi_runtime::PiRuntime;

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String>, worktree: Option<String>, presence_id: Option<String>, working: bool, messageable: bool }

fn claims_dir() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("session-claims");
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn claim_session_id(id: &str) -> Result<fs::File, String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid session identity")?.to_string();
    let dir = claims_dir()?;
    let name = format!("id-{}.lock", hash_claim_key(id.as_bytes()));
    let file = dir.join(&name);
    let mut options = OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let handle = options.open(&file).map_err(|error| format!("Could not open a session claim: {error}"))?;
    handle.try_lock().map_err(|error| match error {
        fs::TryLockError::WouldBlock => "This conversation is open in another window or daemon".to_string(),
        fs::TryLockError::Error(error) => format!("Could not lock the session claim: {error}"),
    })?;
    Ok(handle)
}

pub fn run_session_worker() {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("--piop-session-worker")) { return; }
    let error = exec_session_worker().unwrap_err();
    eprintln!("piop session: {error}");
    std::process::exit(1);
}

#[cfg(unix)]
fn worker_session_identity(path: &str) -> Result<String, String> {
    let mut line = String::new();
    BufReader::new(fs::File::open(path).map_err(|error| error.to_string())?).take(64 * 1024).read_line(&mut line).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())?["id"].as_str().ok_or("Missing session identity").map(str::to_owned).map_err(str::to_owned)
}

#[cfg(unix)]
fn exec_session_worker() -> Result<(), String> {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    let mut arguments = std::env::args_os().skip(2);
    let program = arguments.next().ok_or("Missing Pi executable")?;
    let mut arguments: Vec<_> = arguments.collect();
    let value = |flag: &str| arguments.iter().rposition(|arg| arg == flag).and_then(|index| arguments.get(index + 1)).map(|arg| arg.to_string_lossy().into_owned());
    let id = if let Some(path) = value("--session") {
        worker_session_identity(&path)?
    } else if let Some(id) = value("--session-id") { id } else {
        let id = Uuid::new_v4().to_string();
        arguments.extend(["--session-id".into(), id.clone().into()]);
        id
    };
    let claim = claim_session_id(&id)?;
    let fd = claim.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Err(Command::new(program).args(arguments).exec().to_string())
}

#[cfg(not(unix))]
fn exec_session_worker() -> Result<(), String> { Err("Session worker locking requires a Unix host".into()) }

fn hash_claim_key(bytes: &[u8]) -> String {
    use sha2::Digest;
    use std::fmt::Write;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().take(20).fold(String::new(), |mut out, byte| { let _ = write!(out, "{byte:02x}"); out })
}

mod process_cleanup;
use process_cleanup::stop_message_worker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectKind { NoRepo, Main, Worktree }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_parent_id: Option<String>,
    group_id: Option<String>,
    path: String,
    name: String,
    project: String,
    cwd: String,
    cwd_exists: bool,
    project_kind: Option<ProjectKind>,
    project_root: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    branch_appearance: Option<Value>,
    #[serde(default)]
    worktree_root: Option<String>,
    #[serde(skip)]
    modified_at: u64,
    preview: String,
    message_count: usize,
    last_message_at: u64,
    api_cost: f64,
    host_id: String,
    host_name: String,
}





#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryChat {
    cwd: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageCategory {
    id: String,
    byte_size: u64,
    item_count: usize,
    #[serde(default)]
    estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchivedConversation {
    id: String,
    path: String,
    name: String,
    cwd: String,
    modified_at: u64,
    byte_size: u64,
    deletable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    delete_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_path: Option<String>,
    #[serde(default)]
    restorable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageInventory {
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStorage {
    host_id: String,
    host_name: String,
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageReport { hosts: Vec<HostStorage> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffToolPathMapping { tool_call_id: String, path: String, absolute_path: String, canonical_path: String }

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum GitDiffSnapshot {
    Legacy(String),
    Located {
        patch: String,
        #[serde(rename = "repositoryRoot")]
        repository_root: String,
        #[serde(default, rename = "toolPaths", skip_serializing_if = "Vec::is_empty")]
        tool_paths: Vec<DiffToolPathMapping>,
    },
}

type GitDiffSnapshots = HashMap<String, GitDiffSnapshot>;



#[cfg(test)]
mod tests;

#[path = "backend/settings_storage.rs"]
mod settings_storage;
#[path = "backend/extensions.rs"]
mod extensions;
#[path = "backend/settings.rs"]
mod settings;
#[path = "backend/worktree_setup.rs"]
mod worktree_setup;
#[path = "backend/snapshot_capture.rs"]
mod snapshot_capture;
#[path = "backend/worktrees.rs"]
mod worktrees;
#[path = "backend/project_branches.rs"]
mod project_branches;
#[path = "backend/archive_worktrees.rs"]
mod archive_worktrees;
#[path = "backend/git_diffs.rs"]
mod git_diffs;
#[path = "backend/pi_launch.rs"]
mod pi_launch;
#[path = "backend/pi_runtime.rs"]
mod pi_runtime;
#[path = "backend/session_index.rs"]
mod session_index;
#[path = "backend/archives.rs"]
mod archives;
#[path = "backend/broker.rs"]
mod broker;
#[path = "backend/lifecycle.rs"]
mod lifecycle;

pub use lifecycle::run_daemon;
use lifecycle::{detach_owner};
use pi_runtime::{StartPiOptions, detach_pi_with, open_project_directory, pi_command, pi_presence, start_pi_for_owner, stop_pi};
use terminals::{StartTerminalOptions, close_terminal, resize_terminal, start_terminal_for_owner, write_terminal};
#[cfg(test)]
use pi_runtime::{detach_pi, open_project_directory_with, update_runtime_snapshot};
#[cfg(all(test, feature = "desktop"))]
use pi_runtime::{open_external_url_with, read_dropped_file};
#[cfg(test)]
use terminals::{TerminalLaunch, decode_terminal_bytes, resize_terminal_pty, start_terminal_with, stop_terminals, stream_terminal_output, write_terminal_input, write_terminal_queue};
use archives::{archive_session, archived_session_file, delete_archived_session, delete_session, desktop_session_file, failed_storage, inspect_storage, relocate_session, restore_archived_worktree, storage_report};
#[cfg(test)]
use archives::{archive_local_session, archive_remote_session, collect_storage_report, delete_session_files, local_archived_session_file_at, local_desktop_session_file_at, parse_storage_inventory, query_storage_inventory, relocate_local_session, relocate_remote_session, remote_session_file, run_session_deletion};
use git_diffs::{capture_git_tree, discard_git_tree, discard_git_tree_at_host, load_git_diff, load_git_diff_between_at_host, load_git_diffs, load_git_diffs_at_host, save_git_diffs, save_git_diffs_at_host};
#[cfg(test)]
use git_diffs::{discard_remote_git_tree, load_git_diff_at_host, load_local_git_diffs, load_remote_git_diff_between, load_remote_git_diff_with, query_remote_git_diffs, query_remote_git_tree, remote_save_git_diffs_script, remote_session_sidecar_script, save_local_git_diffs, valid_remote_snapshot, write_remote_git_diffs};
use worktrees::{create_git_worktree, create_project_worktree, git_branch, git_project_kind, git_worktree_roots, is_git_repository, remove_git_worktree, sessions_on_host};
#[cfg(test)]
use worktrees::{canonical_worktree_roots, copy_untracked_file, create_local_git_worktree, create_project_worktree_at, git_branch_at, git_relative_path, inspect_git_project_kind, inspect_worktree_removal, local_branch_exists, local_worktree_is_registered, parse_worktree_output, remove_created_worktree, remove_worktree_target, validate_worktree_unused, worktree_branch_name, worktree_suffix, write_worktree_patch};
use worktree_setup::{cancel_worktree_setup, ensure_desktop_sessions_dir, run_limited, run_worktree_setup, shell_quote, verify_setup_owner};
#[cfg(test)]
use worktree_setup::{GitSnapshotToken, LimitedOutput, WorktreeScriptPhase, execute_worktree_setup, register_worktree_setup, run_setup_process, run_worktree_scripts, signal_worktree_setup_cancellation};
use pi_launch::{ remote_host, remote_login_command, session_identity, ssh, ssh_base};
#[cfg(test)]
use pi_launch::{ create_local_ephemeral_fork, create_remote_ephemeral_fork, prepare_ephemeral_path, read_remote_session_header, remote_directory_path, remote_pi_path, remove_ephemeral_session, stage_extension_script, validate_remote_host};
#[cfg(test)]
use broker::{agent_is_active, broker_response, read_broker_line, resolve_agent, worktree_agents};
use session_index::{collect_host_sessions, create_temporary_chat, home_directory, list_directories, list_local_sessions, list_sessions, remove_temporary_chat, validate_project_directory};
#[cfg(test)]
use session_index::{create_local_temporary_chat, create_remote_temporary_chat, inspect_session_projects_with, list_local_directories, parse_remote_directories, parse_remote_session_metadata, query_remote_directories, query_remote_session_metadata, read_session_summaries, read_session_summaries_with, remote_directory_listing_script, remove_local_temporary_chat, remove_remote_temporary_chat, temporary_chat_id, update_remote_session_index, validate_local_project_directory, validate_remote_project_directory};
use crate::provider_codex::codex_usage;
#[cfg(test)]
use crate::keybindings::default_keybindings;
use crate::environment::home_dir;
use crate::provider_opencode::opencode_go_usage;
use crate::environment::pi_executable;
#[cfg(test)]
use crate::provider_codex::codex_response;
#[cfg(test)]
use crate::provider_codex::codex_usage_values;
#[cfg(test)]
use crate::environment::pi_executable_in;
#[cfg(test)]
use crate::provider_codex::query_codex_usage;
use settings::{load_app_settings, save_app_settings};
#[cfg(test)]
use settings::{codex_disables_implicit_invocation, default_settings, discover_skills_in, expand_skill_path, frontmatter_value, merge_discovered_skills_at, read_settings_at, save_settings_with, skill_path_is_within, validate_settings_for_save};
use extensions::{runtime_settings};
#[cfg(test)]
use extensions::{generated_extension_root, prepare_btw_extension, prepare_codex_web_search_extension, prepare_context_window_cap_extension, prepare_defined_agents_extension, prepare_diff_watch_extension, prepare_mcp_bridge, prepare_openai_cache_fork_extension, prepare_runtime_settings, prepare_session_broker, prepare_trace_reader};
use settings_storage::{atomic_write_private, ensure_private_dir, set_private_file_permissions};
#[cfg(test)]
use settings_storage::{canonical_shortcut, migrate_keybindings, settings_path_at, validate_keybindings};
use project_branches::{project_branches};
#[cfg(test)]
use snapshot_capture::{capture_local_git_tree, git_root_and_objects, local_git_diff_between, local_git_diff_with, local_git_input_is_bounded, local_git_tree_with, parse_local_snapshot, parse_local_snapshot_with, validate_snapshot_location};

use broker::{BrokerRuntime, BusyAgent, broker_environment};
#[cfg(test)]
use broker::claim_agent;

#[path = "backend/terminals.rs"]
mod terminals;
use terminals::TerminalRuntime;
#[cfg(test)]
use terminals::TerminalProcess;
