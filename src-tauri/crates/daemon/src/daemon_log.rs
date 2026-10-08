use crate::daemon_endpoint;
use std::{fs::{self, File, OpenOptions}, io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, thread, time::Duration};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BACKUP_COUNT: usize = 4;
const READY: u8 = 1;
const CAPTURED: &str = "PIOP_DAEMON_LOG_CAPTURED";

fn private_file(path: &Path, append: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false).append(append);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(path)?;
    crate::set_private_file_permissions(path).map_err(io::Error::other)?;
    Ok(file)
}

fn lock(directory: &Path) -> io::Result<(File, File)> {
    let file = private_file(&directory.join("daemon-log.lock"), false)?;
    file.lock()?;
    let compatible = private_file(&directory.join("daemon.log.lock"), false)?;
    compatible.lock()?;
    Ok((file, compatible))
}

fn archive_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("daemon.log.{index}"))
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn rotate(directory: &Path) -> io::Result<()> {
    remove_if_present(&archive_path(directory, BACKUP_COUNT))?;
    for index in (1..BACKUP_COUNT).rev() {
        match fs::rename(archive_path(directory, index), archive_path(directory, index + 1)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {},
        }
    }
    fs::rename(directory.join("daemon.log"), archive_path(directory, 1))
}

fn trim_legacy_log(directory: &Path) -> io::Result<()> {
    let path = directory.join("daemon.log");
    let temporary = directory.join("daemon.log.trim");
    remove_if_present(&temporary)?;
    let mut source = private_file(&path, true)?;
    if source.metadata()?.len() <= MAX_FILE_BYTES { return Ok(()); }
    source.seek(SeekFrom::End(-(MAX_FILE_BYTES as i64)))?;
    let result = (|| {
        let mut target = private_file(&temporary, false)?;
        target.set_len(0)?;
        io::copy(&mut source.take(MAX_FILE_BYTES), &mut target)?;
        target.sync_all()?;
        drop(target);
        fs::rename(&temporary, &path)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

fn write_chunk(file: &mut File, pending: &mut &[u8], count: usize) -> io::Result<()> {
    match file.write(&pending[..count]) {
        Ok(0) => Err(io::Error::new(io::ErrorKind::WriteZero, "Could not write daemon diagnostics")),
        Ok(written) => { *pending = &pending[written..]; Ok(()) },
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(()),
        Err(error) => Err(error),
    }
}

fn append(directory: &Path, pending: &mut &[u8]) -> io::Result<()> {
    let _lock = lock(directory)?;
    while !pending.is_empty() {
        let mut file = private_file(&directory.join("daemon.log"), true)?;
        let length = file.metadata()?.len();
        if length >= MAX_FILE_BYTES { drop(file); rotate(directory)?; continue; }
        let count = pending.len().min((MAX_FILE_BYTES - length) as usize);
        write_chunk(&mut file, pending, count)?;
    }
    Ok(())
}

fn collect(directory: &Path) -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = match input.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 { return Ok(()); }
        let mut pending = &buffer[..count];
        while append(directory, &mut pending).is_err() {
            thread::sleep(Duration::from_secs(1));
        }
    }
}

fn initialize_directory() -> Result<PathBuf, String> {
    let directory = crate::daemon_endpoint::directory()?;
    initialize_at(&directory)?;
    Ok(directory)
}

fn initialize_at(directory: &Path) -> Result<(), String> {
    crate::ensure_private_dir(directory)?;
    {
        let _lock = lock(directory).map_err(|error| error.to_string())?;
        trim_legacy_log(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn run() -> Result<(), String> {
    let directory = match initialize_directory() {
        Ok(directory) => directory,
        Err(error) => {
            let _ = io::stdout().write_all(error.as_bytes()).and_then(|()| io::stdout().flush());
            return Err(error);
        }
    };
    io::stdout().write_all(&[READY]).and_then(|()| io::stdout().flush()).map_err(|error| error.to_string())?;
    collect(&directory).map_err(|error| error.to_string())
}

fn detach(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(io::Error::last_os_error()); } Ok(()) }); }
    }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x00000008 | 0x00000200); }
}

fn writer_executable() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    { Ok(PathBuf::from("/proc/self/exe")) }
    #[cfg(not(target_os = "linux"))]
    { std::env::current_exe().map_err(|error| error.to_string()) }
}

fn wait_ready(writer: &mut Child) -> Result<(), String> {
    let mut output = writer.stdout.take().ok_or("Daemon log writer has no readiness pipe")?;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut ready = [0];
        let result = output.read_exact(&mut ready).map_err(|error| error.to_string()).and_then(|()| {
            if ready[0] == READY { return Ok(()); }
            let mut error = vec![ready[0]];
            output.take(8192).read_to_end(&mut error).map_err(|error| error.to_string())?;
            Err(String::from_utf8_lossy(&error).into_owned())
        });
        let _ = send.send(result);
    });
    match receive.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result.map_err(|error| format!("Could not initialize daemon log writer: {error}")),
        Err(error) => Err(format!("Daemon log writer did not become ready: {error}")),
    }
}

pub(crate) fn spawn(mut command: Command) -> Result<Child, String> {
    if command.get_envs().any(|(key, value)| key == CAPTURED && value.is_some()) {
        detach(&mut command);
        return command.spawn().map_err(|error| format!("Could not start daemon: {error}"));
    }
    let mut logging = Command::new(writer_executable()?);
    logging.arg("--daemon-log-writer").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach(&mut logging);
    let mut writer = logging.spawn().map_err(|error| format!("Could not start daemon log writer: {error}"))?;
    if let Err(error) = wait_ready(&mut writer) {
        let _ = writer.kill();
        let _ = writer.wait();
        return Err(error);
    }
    let input = writer.stdin.take().ok_or("Daemon log writer has no input pipe")?;
    command.stderr(input).env(CAPTURED, "1");
    detach(&mut command);
    let result = command.spawn().map_err(|error| format!("Could not start {}: {error}", command.get_program().to_string_lossy()));
    drop(command);
    thread::spawn(move || { let _ = writer.wait(); });
    result
}

fn start_consumer(executable: &Path, directory: &Path) -> Result<ChildStdin, String> {
    initialize_at(directory)?;
    let mut command = Command::new(executable);
    command.arg("--daemon-log-sink").arg(directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    detach(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Could not start daemon logging: {error}"))?;
    if let Err(error) = wait_sink_ready(&mut child) {
        let _ = child.kill(); let _ = child.wait();
        let message = format!("Could not start daemon logging: {error}\n");
        let _ = append(directory, &mut message.as_bytes());
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

pub(crate) fn run_sink() -> Result<(), String> {
    let directory = PathBuf::from(std::env::args_os().nth(2).ok_or("Daemon log directory is missing")?);
    initialize_at(&directory)?;
    println!("ready");
    std::io::stdout().flush().map_err(|error| error.to_string())?;
    collect(&directory).map_err(|error| error.to_string())
}

pub(crate) fn initialize() -> Result<(), String> {
    if !matches!(std::env::args().nth(1).as_deref(), Some("--serve" | "--exit-on-disconnect" | "--restart-candidate" | "--restart-coordinator" | "--validate-plugins")) { return Ok(()); }
    if std::env::var_os(CAPTURED).is_some() { return Ok(()); }
    let directory = daemon_endpoint::directory()?;
    let writer = start_consumer(&running_executable()?, &directory)?;
    redirect_stderr(&writer)
}

pub(crate) fn running_executable() -> Result<PathBuf, String> { writer_executable() }

#[cfg(unix)]
fn redirect_stderr(writer: &ChildStdin) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::dup2(writer.as_raw_fd(), libc::STDERR_FILENO) } < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
}

#[cfg(windows)]
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
