use std::{process::Child, thread, time::{Duration, Instant}};

#[cfg(target_os = "linux")]
pub(crate) fn directory_in_use(directory: &std::path::Path, ignored: Option<&std::path::Path>) -> std::io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        if !owned_process(&entry)? { continue; }
        if process_uses_directory(&entry.path(), directory, ignored)? { return Ok(true); }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn owned_process(entry: &std::fs::DirEntry) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    if entry.file_name().to_str().is_none_or(|name| name.parse::<u32>().is_err()) { return Ok(false); }
    match entry.metadata() {
        Ok(metadata) => Ok(metadata.uid() == unsafe { libc::geteuid() }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn process_uses_directory(process: &std::path::Path, directory: &std::path::Path, ignored: Option<&std::path::Path>) -> std::io::Result<bool> {
    if link_uses_directory(&process.join("cwd"), directory, ignored)? { return Ok(true); }
    let Some(handles) = process_handles(process)? else { return Ok(false); };
    for handle in handles {
        let handle = handle?;
        if link_uses_directory(&handle.path(), directory, ignored)? { return Ok(true); }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn process_handles(process: &std::path::Path) -> std::io::Result<Option<std::fs::ReadDir>> {
    match std::fs::read_dir(process.join("fd")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        result => result.map(Some),
    }
}

#[cfg(target_os = "linux")]
fn link_uses_directory(link: &std::path::Path, directory: &std::path::Path, ignored: Option<&std::path::Path>) -> std::io::Result<bool> {
    match std::fs::read_link(link) {
        Ok(path) => Ok(path.starts_with(directory) && ignored != Some(path.as_path())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn stop_message_worker(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) { return; }
    #[cfg(target_os = "linux")]
    let descendants = descendant_handles(child.id());
    #[cfg(unix)]
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM); }
    #[cfg(not(unix))]
    { let _ = child.kill(); }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) { break; }
        thread::sleep(Duration::from_millis(25));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        for process in descendants {
            unsafe { libc::syscall(libc::SYS_pidfd_send_signal, process.as_raw_fd(), libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0); }
        }
    }
    if !matches!(child.try_wait(), Ok(Some(_))) { let _ = child.kill(); }
    let _ = child.wait();
}

#[cfg(target_os = "linux")]
fn descendant_handles(parent: u32) -> Vec<std::os::fd::OwnedFd> {
    use std::{collections::{HashMap, HashSet}, fs, os::fd::{FromRawFd, OwnedFd}};
    let mut processes = HashMap::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue; };
            let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else { continue; };
            let Some((_, fields)) = stat.rsplit_once(')') else { continue; };
            let fields: Vec<_> = fields.split_whitespace().collect();
            if let (Some(ppid), Some(started)) = (fields.get(1).and_then(|value| value.parse::<u32>().ok()), fields.get(19)) {
                processes.insert(pid, (ppid, (*started).to_owned()));
            }
        }
    }
    let mut descendants = HashSet::from([parent]);
    loop {
        let previous = descendants.len();
        for (pid, (ppid, _)) in &processes { if descendants.contains(ppid) { descendants.insert(*pid); } }
        if descendants.len() == previous { break; }
    }
    descendants.remove(&parent);
    descendants.into_iter().filter_map(|pid| {
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 { return None; }
        let handle = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let started = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?;
        (processes.get(&pid)?.1 == started).then_some(handle)
    }).collect()
}
