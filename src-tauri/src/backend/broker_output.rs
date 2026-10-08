use std::{fs::{self, File, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex};
use uuid::Uuid;

pub(super) struct MessageOutput {
    root: PathBuf,
    pub(super) stdout: PathBuf,
    pub(super) stderr: PathBuf,
    owner: Mutex<Option<File>>,
}

fn directory() -> Result<PathBuf, String> {
    Ok(crate::environment::home_dir()?.join(crate::STORAGE_DIRECTORY).join("broker-output"))
}

fn private_file(path: &Path, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { return Err(io::Error::other("Broker ownership must be a regular file")); }
    Ok(file)
}

fn creation_gate(root: &Path) -> Result<File, String> {
    crate::ensure_private_dir(root)?;
    private_file(&root.join("ownership.lock"), true).map_err(|error| error.to_string())
}

fn create_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(path)
}

impl MessageOutput {
    pub(super) fn prepare(command: &mut Command) -> Result<Self, String> {
        let parent = directory()?;
        let gate = creation_gate(&parent)?;
        gate.lock_shared().map_err(|error| error.to_string())?;
        let root = parent.join(Uuid::new_v4().to_string());
        create_directory(&root).map_err(|error| error.to_string())?;
        let mut owner = private_file(&root.join("owner.lock"), true).map_err(|error| error.to_string())?;
        owner.lock_shared().map_err(|error| error.to_string())?;
        writeln!(owner, "{{\"version\":1,\"processId\":{}}}", std::process::id()).and_then(|()| owner.sync_all()).map_err(|error| error.to_string())?;
        inherit_owner(command, &owner);
        let output = Self { stdout: root.join("stdout"), stderr: root.join("stderr"), root, owner: Mutex::new(Some(owner)) };
        output.capture(command)?;
        Ok(output)
    }

    fn capture(&self, command: &mut Command) -> Result<(), String> {
        let stdout = private_file(&self.stdout, true).map_err(|error| error.to_string())?;
        let stderr = private_file(&self.stderr, true).map_err(|error| error.to_string())?;
        command.stdin(Stdio::piped()).stdout(stdout).stderr(stderr);
        Ok(())
    }

    pub(super) fn remove(&self) {
        self.owner.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Err(error) = collect_owned(&self.root, true) {
            eprintln!("Could not remove agent output {}: {error}", self.root.display());
        }
    }
}

impl Drop for MessageOutput {
    fn drop(&mut self) { self.remove(); }
}

fn inherit_owner(command: &mut Command, owner: &File) {
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let descriptor = owner.as_raw_fd();
        unsafe { command.pre_exec(move || {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags < 0 || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        }); }
    }
    #[cfg(not(unix))]
    { let _ = (command, owner); }
}

fn owned_directory(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() { return Ok(false); }
    #[cfg(unix)]
    { use std::os::unix::fs::MetadataExt; if metadata.uid() != unsafe { libc::geteuid() } { return Ok(false); } }
    Ok(true)
}

fn output_file(entry: &fs::DirEntry, managed: bool) -> io::Result<bool> {
    let name = entry.file_name();
    let recognized = name == "stdout" || name == "stderr" || (managed && name == "owner.lock");
    Ok(recognized && entry.file_type()?.is_file())
}

fn output_files(path: &Path, managed: bool) -> io::Result<Option<Vec<PathBuf>>> {
    if !owned_directory(path)? { return Ok(None); }
    let mut files = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !output_file(&entry, managed)? { return Ok(None); }
        files.push(entry.path());
    }
    Ok(Some(files))
}

fn collect_owned(path: &Path, _worker_stopped: bool) -> io::Result<()> {
    let Some(files) = output_files(path, true)? else { return Ok(()); };
    if files.is_empty() { return remove_output(path, files); }
    let Some(_owner) = claim_owner(path)? else { return Ok(()); };
    #[cfg(target_os = "linux")]
    if crate::process_cleanup::directory_in_use(path, Some(&path.join("owner.lock")))? { return Ok(()); }
    #[cfg(not(target_os = "linux"))]
    if !_worker_stopped { return Ok(()); }
    remove_output(path, files)
}

fn claim_owner(path: &Path) -> io::Result<Option<File>> {
    let owner = private_file(&path.join("owner.lock"), false)?;
    match owner.try_lock() {
        Ok(()) => Ok(Some(owner)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

fn remove_output(path: &Path, mut files: Vec<PathBuf>) -> io::Result<()> {
    files.sort_by_key(|file| file.file_name().is_some_and(|name| name == "owner.lock"));
    for file in files {
        match fs::remove_file(file) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {},
        }
    }
    match fs::remove_dir(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

pub(super) fn recover() {
    if let Err(error) = recover_managed() { eprintln!("Could not recover broker output: {error}"); }
    if let Err(error) = recover_legacy() { eprintln!("Could not inspect old broker output: {error}"); }
}

fn recover_managed() -> Result<(), String> {
    let root = directory()?;
    let gate = creation_gate(&root)?;
    gate.lock().map_err(|error| error.to_string())?;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_str().is_none_or(|name| Uuid::parse_str(name).is_err()) { continue; }
        if let Err(error) = collect_owned(&entry.path(), false) { eprintln!("Broker output retained at {}: {error}", entry.path().display()); }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn recover_legacy() -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let Some(boot) = fs::read_to_string("/proc/stat")?.lines().find_map(|line| line.strip_prefix("btime ").and_then(|value| value.parse::<i64>().ok())) else { return Ok(()); };
    for entry in fs::read_dir(std::env::temp_dir())? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_prefix("pi-desktop-broker-")) else { continue; };
        if Uuid::parse_str(id).is_err() || entry.metadata()?.ctime() >= boot { continue; }
        collect_legacy(&entry.path(), boot)?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn recover_legacy() -> io::Result<()> { Ok(()) }

#[cfg(target_os = "linux")]
fn collect_legacy(path: &Path, boot: i64) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let Some(files) = output_files(path, false)? else { return Ok(()); };
    for file in &files { if fs::metadata(file)?.ctime() >= boot { return Ok(()); } }
    if crate::process_cleanup::directory_in_use(path, None)? { return Ok(()); }
    remove_output(path, files)
}
