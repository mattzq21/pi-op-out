#[cfg(not(feature = "desktop"))]
fn main() {
    piop_lib::run_session_worker();
    match std::env::args().nth(1).as_deref() {
        None | Some("--help" | "-h") => {
            println!("Usage: piopd <start|stop>\n\n  start  Run the daemon in the background until stopped\n  stop   Shut down the running daemon gracefully");
            return;
        }
        Some("start" | "stop" | "--serve" | "--exit-on-disconnect" | "--stdio-client") => {},
        Some(argument) => { eprintln!("piopd: Unknown command {argument}. Use piopd --help."); std::process::exit(1); }
    }
    if let Err(error) = piop_lib::run_daemon() {
        eprintln!("piopd: {error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "desktop")]
fn main() {
    eprintln!("Build piopd with --no-default-features --features daemon");
    std::process::exit(1);
}
