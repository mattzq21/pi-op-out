#[cfg(not(feature = "desktop"))]
#[path = "host_daemon/mod.rs"]
mod host_supervisor;

#[cfg(not(feature = "desktop"))]
include!("backend.rs");

#[cfg(feature = "desktop")]
include!("desktop.rs");
