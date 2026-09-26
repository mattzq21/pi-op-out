#[cfg(not(feature = "desktop"))]
fn main() {
    if std::env::args().nth(1).is_some_and(|argument| argument == "--help" || argument == "-h") {
        println!("Usage: piopd [--exit-on-disconnect | --stdio-client]\n\nRun the Piop daemon until stopped with Ctrl+C.\n  --exit-on-disconnect  Exit after the last client disconnects\n  --stdio-client        Connect a peer over standard input/output");
        return;
    }
    piop_lib::run_session_worker();
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
