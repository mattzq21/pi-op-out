#[path = "host_daemon/mod.rs"]
mod host_supervisor;
mod restart_artifacts;
mod daemon_log;

pub fn initialize_daemon_process() -> Result<(), String> { restart_artifacts::initialize()?; daemon_log::initialize() }

pub fn run_daemon_log_sink() -> Option<Result<(), String>> {
    if std::env::args().nth(1).as_deref() != Some("--daemon-log-sink") { return None; }
    Some(daemon_log::run_sink())
}

#[path = "git-ops/mod.rs"]
mod git_ops;

include!("backend.rs");
