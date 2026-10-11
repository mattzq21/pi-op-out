use crate::daemon_endpoint;
use std::{io::{self, Read}, path::{Path, PathBuf}, process::{ChildStdin, Command, Stdio}, thread, time::Duration, os::{fd::{AsRawFd, FromRawFd, OwnedFd}, unix::{net::UnixStream, process::CommandExt}}};

const CAPTURED: &str = "PIOP_DAEMON_LOG_CAPTURED";

fn detach(command: &mut Command) {
    {
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(io::Error::last_os_error()); } Ok(()) }); }
    }
}

fn start_consumer(executable: &Path, directory: &Path) -> Result<(ChildStdin, UnixStream), String> {
    let (reader, output) = UnixStream::pair().map_err(|error| format!("Could not create daemon log status pipe: {error}"))?;
    let mut command = Command::new(executable);
    command.arg("--daemon-log-sink").arg(directory).stdin(Stdio::piped()).stdout(Stdio::from(OwnedFd::from(output))).stderr(Stdio::null());
    detach(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Could not start daemon logging: {error}"))?;
    let ready = wait_sink_ready(reader);
    if let Err(mut error) = ready {
        if let Err(failure) = child.kill() {
            if failure.kind() != io::ErrorKind::InvalidInput { error.push_str(&format!("; could not stop log process: {failure}")); }
        }
        if let Err(failure) = child.wait() { error.push_str(&format!("; could not wait for log process: {failure}")); }
        return Err(error);
    }
    let writer = child.stdin.take().ok_or("Daemon log input is unavailable")?;
    thread::spawn(move || {
        if let Err(error) = child.wait() { eprintln!("Could not wait for daemon log process: {error}"); }
    });
    Ok((writer, ready?))
}

fn wait_sink_ready(mut reader: UnixStream) -> Result<UnixStream, String> {
    reader.set_read_timeout(Some(Duration::from_secs(5))).map_err(|error| error.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut line = Vec::new();
    loop {
        let remaining = deadline.checked_duration_since(std::time::Instant::now()).ok_or("Daemon logging readiness timed out")?;
        reader.set_read_timeout(Some(remaining)).map_err(|error| error.to_string())?;
        let mut byte = [0];
        reader.read_exact(&mut byte).map_err(|error| format!("Could not read daemon logging readiness: {error}"))?;
        if byte[0] == b'\n' { break; }
        line.push(byte[0]);
        if line.len() >= 65536 { return Err("Daemon logging readiness response is too long".into()); }
    }
    let line = String::from_utf8_lossy(&line);
    if line != "ready" {
        let packet = serde_json::from_str::<serde_json::Value>(&line).ok();
        let cause = packet.as_ref().and_then(|value| value["error"].as_str()).unwrap_or(&line);
        return Err(format!("Daemon logging failed to initialize: {cause}"));
    }
    reader.set_read_timeout(None).map_err(|error| error.to_string())?;
    Ok(reader)
}

pub(crate) fn configure(command: &mut Command, executable: &Path) -> Result<PathBuf, String> {
    let directory = daemon_endpoint::directory()?;
    let (writer, reader) = start_consumer(executable, &directory)?;
    let fd = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
    if fd < 0 { return Err(format!("Could not pass daemon log status: {}", io::Error::last_os_error())); }
    let status = unsafe { OwnedFd::from_raw_fd(fd) };
    command.stderr(Stdio::from(writer)).env(CAPTURED, "1").env("PIOP_DAEMON_LOG_STATUS_FD", "3");
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(status.as_raw_fd(), 3) < 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        });
    }
    Ok(directory.join("daemon.log"))
}
