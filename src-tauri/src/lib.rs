#[cfg(not(feature = "desktop"))]
mod host_daemon;

#[cfg(any(not(feature = "desktop"), test))]
include!("backend.rs");

#[cfg(all(feature = "desktop", not(test)))]
include!("desktop.rs");
