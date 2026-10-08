use crate::daemon_endpoint;
use std::{fs::{File, OpenOptions}, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc, thread, time::Duration};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const KEEP_BYTES: usize = MAX_BYTES / 2;
const CAPTURED: &str = "PIOP_DAEMON_LOG_CAPTURED";

fn open_private(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(path).map_err(|error| error.to_string())?;
    crate::set_private_file_permissions(path)?;
    Ok(file)
}

fn append(directory: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::ensure_private_dir(directory)?;
    let lock = open_private(&directory.join("daemon.log.lock"))?;
    lock.lock().map_err(|error| error.to_string())?;
    let mut log = open_private(&directory.join("daemon.log"))?;
    let bytes = &bytes[bytes.len().saturating_sub(MAX_BYTES)..];
    if log.metadata().map_err(|error| error.to_string())?.len().saturating_add(bytes.len() as u64) > MAX_BYTES as u64 {
        compact(&mut log, KEEP_BYTES.min(MAX_BYTES - bytes.len()))?;
    }
    log.seek(SeekFrom::End(0)).and_then(|_| log.write_all(bytes)).and_then(|_| log.sync_data()).map_err(|error| error.to_string())
}

fn compact(log: &mut File, keep: usize) -> Result<(), String> {
    let length = log.metadata().map_err(|error| error.to_string())?.len();
    let keep = length.min(keep as u64);
    log.seek(SeekFrom::End(-(keep as i64))).map_err(|error| error.to_string())?;
    let mut tail = vec![0u8; keep as usize];
    log.read_exact(&mut tail).map_err(|error| error.to_string())?;
    log.set_len(0).and_then(|_| log.seek(SeekFrom::Start(0))).and_then(|_| log.write_all(&tail)).map_err(|error| error.to_string())
}

fn detach(command: &mut Command) {
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); } Ok(()) }); } }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x00000008 | 0x00000200); }
}

fn start_consumer(executable: &Path, directory: &Path) -> Result<ChildStdin, String> {
    append(directory, &[])?;
    let mut command = Command::new(executable);
    command.arg("--daemon-log-sink").arg(directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Could not start daemon logging: {error}"))?;
    if let Err(error) = wait_ready(&mut child) {
        let _ = child.kill(); let _ = child.wait();
        let _ = append(directory, format!("Could not start daemon logging: {error}\n").as_bytes());
        return Err(error);
    }
    let writer = child.stdin.take().ok_or("Daemon log input is unavailable")?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(writer)
}

fn wait_ready(child: &mut Child) -> Result<(), String> {
    let stdout = child.stdout.take().ok_or("Daemon log readiness is unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(1);
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

#[cfg(not(feature = "desktop"))]
pub(crate) fn run_sink() -> Result<(), String> {
    let directory = PathBuf::from(std::env::args_os().nth(2).ok_or("Daemon log directory is missing")?);
    append(&directory, &[])?;
    println!("ready");
    std::io::stdout().flush().map_err(|error| error.to_string())?;
    consume(&directory)
}

#[cfg(not(feature = "desktop"))]
fn consume(directory: &Path) -> Result<(), String> {
    let mut input = std::io::stdin().lock();
    let mut buffer = [0u8; 65536];
    let mut pending = Vec::new();
    loop {
        let length = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 { break; }
        pending.extend_from_slice(&buffer[..length]);
        if append(directory, &pending).is_ok() { pending.clear(); }
        if pending.len() > KEEP_BYTES { pending.drain(..pending.len() - KEEP_BYTES); }
    }
    append(directory, &pending)
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn initialize() -> Result<(), String> {
    if !matches!(std::env::args().nth(1).as_deref(), Some("--serve" | "--exit-on-disconnect" | "--restart-candidate" | "--restart-coordinator" | "--validate-plugins")) { return Ok(()); }
    if std::env::var_os(CAPTURED).is_some() { return Ok(()); }
    let directory = daemon_endpoint::directory()?;
    let writer = start_consumer(&running_executable()?, &directory)?;
    redirect_stderr(&writer)
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn running_executable() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    { Ok(PathBuf::from("/proc/self/exe")) }
    #[cfg(not(target_os = "linux"))]
    { std::env::current_exe().map_err(|error| error.to_string()) }
}

#[cfg(all(not(feature = "desktop"), unix))]
fn redirect_stderr(writer: &ChildStdin) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::dup2(writer.as_raw_fd(), libc::STDERR_FILENO) } < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}

#[cfg(all(not(feature = "desktop"), windows))]
fn redirect_stderr(writer: &ChildStdin) -> Result<(), String> {
    use std::os::windows::io::{AsHandle, FromRawHandle, IntoRawHandle};
    #[link(name = "kernel32")]
    extern "system" { fn SetStdHandle(kind: u32, handle: *mut std::ffi::c_void) -> i32; }
    let handle = writer.as_handle().try_clone_to_owned().map_err(|error| error.to_string())?.into_raw_handle();
    let fd = unsafe { libc::open_osfhandle(handle as isize, libc::O_WRONLY | libc::O_BINARY) };
    if fd < 0 { unsafe { drop(std::os::windows::io::OwnedHandle::from_raw_handle(handle)); } return Err(std::io::Error::last_os_error().to_string()); }
    let result = unsafe { libc::dup2(fd, 2) };
    unsafe { libc::close(fd); }
    if result < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    if unsafe { SetStdHandle((-12i32) as u32, libc::get_osfhandle(2) as *mut std::ffi::c_void) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}
