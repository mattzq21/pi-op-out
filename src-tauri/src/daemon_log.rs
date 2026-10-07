use std::{fs::{self, File, OpenOptions}, io::{self, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, thread, time::Duration};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BACKUP_COUNT: usize = 4;
const READY: u8 = 1;

fn private_file(path: &Path, append: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false).append(append);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(path)?;
    crate::set_private_file_permissions(path).map_err(io::Error::other)?;
    Ok(file)
}

fn lock(directory: &Path) -> io::Result<File> {
    let file = private_file(&directory.join("daemon-log.lock"), false)?;
    file.lock()?;
    Ok(file)
}

fn archive_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("daemon.log.{index}"))
}

fn remove_oldest(directory: &Path) -> io::Result<()> {
    match fs::remove_file(archive_path(directory, BACKUP_COUNT)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn rotate(directory: &Path) -> io::Result<()> {
    remove_oldest(directory)?;
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
    let mut source = private_file(&path, true)?;
    if source.metadata()?.len() <= MAX_FILE_BYTES { return Ok(()); }
    source.seek(SeekFrom::End(-(MAX_FILE_BYTES as i64)))?;
    let temporary = directory.join("daemon.log.trim");
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

fn append(directory: &Path, pending: &mut &[u8]) -> io::Result<()> {
    let _lock = lock(directory)?;
    while !pending.is_empty() {
        let mut file = private_file(&directory.join("daemon.log"), true)?;
        let length = file.metadata()?.len();
        if length >= MAX_FILE_BYTES { drop(file); rotate(directory)?; continue; }
        let count = pending.len().min((MAX_FILE_BYTES - length) as usize);
        match file.write(&pending[..count]) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "Could not write daemon diagnostics")),
            Ok(written) => *pending = &pending[written..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
            Err(error) => return Err(error),
        }
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
        if let Err(error) = append(directory, &mut pending) {
            let mut fallback = io::stderr().lock();
            writeln!(fallback, "Could not save daemon diagnostics: {error}")?;
            fallback.write_all(pending)?;
            io::copy(&mut input, &mut fallback)?;
            return Ok(());
        }
    }
}

pub(crate) fn run() -> Result<(), String> {
    let directory = crate::daemon_endpoint::directory()?;
    crate::ensure_private_dir(&directory)?;
    {
        let _lock = lock(&directory).map_err(|error| error.to_string())?;
        trim_legacy_log(&directory).map_err(|error| error.to_string())?;
    }
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
        let result = output.read_exact(&mut ready).map(|()| ready[0]).map_err(|error| error.to_string());
        let _ = send.send(result);
    });
    match receive.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(READY)) => Ok(()),
        _ => Err("Daemon log writer did not become ready".into()),
    }
}

pub(crate) fn spawn(mut command: Command) -> Result<Child, String> {
    let mut logging = Command::new(writer_executable()?);
    logging.arg("--daemon-log-writer").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    detach(&mut logging);
    let mut writer = logging.spawn().map_err(|error| format!("Could not start daemon log writer: {error}"))?;
    if let Err(error) = wait_ready(&mut writer) {
        let _ = writer.kill();
        let _ = writer.wait();
        return Err(error);
    }
    let input = writer.stdin.take().ok_or("Daemon log writer has no input pipe")?;
    command.stderr(input);
    detach(&mut command);
    let result = command.spawn().map_err(|error| format!("Could not start {}: {error}", command.get_program().to_string_lossy()));
    drop(command);
    thread::spawn(move || { let _ = writer.wait(); });
    result
}
