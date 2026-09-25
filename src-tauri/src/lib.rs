#[cfg(any(not(feature = "desktop"), test))]
#[path = "host_daemon/mod.rs"]
mod host_supervisor;

#[cfg(any(not(feature = "desktop"), test))]
include!("backend.rs");

#[cfg(all(feature = "desktop", not(test)))]
include!("desktop.rs");
