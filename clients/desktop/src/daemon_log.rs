use crate::daemon_endpoint;
use std::{io::{self, BufRead, BufReader, Read}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, thread, time::Duration};

const CAPTURED: &str = "PIOP_DAEMON_LOG_CAPTURED";

fn detach(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(io::Error::last_os_error()); } Ok(()) }); }
    }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x00000008 | 0x00000200); }
}

pub(crate) fn spawn(mut command: Command) -> Result<Child, String> {
    detach(&mut command);
    command.spawn().map_err(|error| format!("Could not start daemon: {error}"))
}

fn start_consumer(executable: &Path, directory: &Path) -> Result<ChildStdin, String> {
    let mut command = Command::new(executable);
    command.arg("--daemon-log-sink").arg(directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Could not start daemon logging: {error}"))?;
    if let Err(error) = wait_sink_ready(&mut child) {
        let _ = child.kill(); let _ = child.wait();
        return Err(error);
    }
    let writer = child.stdin.take().ok_or("Daemon log input is unavailable")?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(writer)
}

fn wait_sink_ready(child: &mut Child) -> Result<(), String> {
    let stdout = child.stdout.take().ok_or("Daemon log readiness is unavailable")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).take(1024).read_line(&mut line).map(|_| line).map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let response = receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| "Daemon logging did not initialize within five seconds")??;
    if response.trim() != "ready" { return Err(format!("Daemon logging failed to initialize: {}", response.trim())); }
    Ok(())
}

pub(crate) fn configure(command: &mut Command, executable: &Path) -> Result<PathBuf, String> {
    let directory = daemon_endpoint::directory()?;
    let writer = start_consumer(executable, &directory)?;
    command.stderr(Stdio::from(writer)).env(CAPTURED, "1");
    Ok(directory.join("daemon.log"))
}
