#[cfg(not(feature = "desktop"))]
fn main() {
    if let Err(error) = piop_lib::run_daemon() {
        eprintln!("piop-daemon: {error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "desktop")]
fn main() {
    eprintln!("Build piop-daemon with --no-default-features --features daemon");
    std::process::exit(1);
}
