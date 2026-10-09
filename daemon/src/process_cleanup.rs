use std::{process::Child, thread, time::{Duration, Instant}};

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
