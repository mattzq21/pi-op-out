#[cfg(not(feature = "desktop"))]
#[path = "host_daemon/mod.rs"]
mod host_supervisor;

#[cfg(not(feature = "desktop"))]
mod restart_artifacts;

mod daemon_log;

#[cfg(not(feature = "desktop"))]
pub fn initialize_daemon_process() -> Result<(), String> { restart_artifacts::initialize()?; daemon_log::initialize() }

#[cfg(not(feature = "desktop"))]
pub fn run_daemon_log_sink() -> Option<Result<(), String>> {
    if std::env::args().nth(1).as_deref() != Some("--daemon-log-sink") { return None; }
    Some(daemon_log::run_sink())
}

#[cfg(not(feature = "desktop"))]
include!("backend.rs");

#[cfg(feature = "desktop")]
include!("desktop.rs");
