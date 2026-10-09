use std::{fs::{self, File, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex};
use uuid::Uuid;

#[path = "broker_output_records.rs"]
mod records;

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
        let id = Uuid::new_v4();
        records::reserve(&parent, id)?;
        let root = parent.join(id.to_string());
        create_directory(&root).map_err(|error| error.to_string())?;
        let mut owner = private_file(&root.join("owner.lock"), true).map_err(|error| error.to_string())?;
        owner.lock_shared().map_err(|error| error.to_string())?;
        writeln!(owner, "{{\"version\":2,\"processId\":{}}}", std::process::id()).and_then(|()| owner.sync_all()).map_err(|error| error.to_string())?;
        inherit_owner(command, &owner);
        let output = Self { stdout: root.join("stdout"), stderr: root.join("stderr"), root, owner: Mutex::new(Some(owner)) };
        output.capture(command)?;
        Ok(output)
    }

    fn capture(&self, command: &mut Command) -> Result<(), String> {
        let stdout = private_file(&self.stdout, true).map_err(|error| error.to_string())?;
        let stderr = private_file(&self.stderr, true).map_err(|error| error.to_string())?;
        stdout.lock_shared().map_err(|error| error.to_string())?;
        stderr.lock_shared().map_err(|error| error.to_string())?;
        command.stdin(Stdio::piped()).stdout(stdout).stderr(stderr);
        Ok(())
    }

    pub(super) fn remove(&self) {
        self.owner.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Err(error) = collect_owned(&self.root, true).map_err(|error| error.to_string()).and_then(|()| records::forget_missing(&self.root)) {
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
    let Some(_owner) = claim_file(&path.join("owner.lock"))? else { return Ok(()); };
    let Some(_outputs) = claim_outputs(&files)? else { return Ok(()); };
    #[cfg(not(unix))]
    if !_worker_stopped { return Ok(()); }
    remove_output(path, files)
}

fn claim_file(path: &Path) -> io::Result<Option<File>> {
    let owner = private_file(path, false)?;
    match owner.try_lock() {
        Ok(()) => Ok(Some(owner)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

fn claim_outputs(paths: &[PathBuf]) -> io::Result<Option<Vec<File>>> {
    let mut files = Vec::new();
    for path in paths {
        if path.file_name().is_some_and(|name| name == "owner.lock") { continue; }
        let Some(file) = claim_file(path)? else { return Ok(None); };
        files.push(file);
    }
    Ok(Some(files))
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
}

fn recover_managed() -> Result<(), String> {
    let root = directory()?;
    let gate = creation_gate(&root)?;
    gate.lock().map_err(|error| error.to_string())?;
    for path in records::paths(&root)? {
        if let Err(error) = collect_owned(&path, false).map_err(|error| error.to_string()).and_then(|()| records::forget_missing(&path)) {
            eprintln!("Broker output retained at {}: {error}", path.display());
        }
    }
    Ok(())
}
