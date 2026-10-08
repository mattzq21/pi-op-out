use std::{fs::{File, OpenOptions}, io, path::{Path, PathBuf}};
#[cfg(unix)]
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};

#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
#[cfg(windows)]
const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;

pub(super) fn open_directory(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    if !file.metadata()?.is_dir() { return Err(io::Error::other("Saved file parent is not a directory")); }
    Ok(file)
}

pub(super) fn directory_path(directory: &File, parent: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    { let _ = parent; PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())) }
    #[cfg(not(target_os = "linux"))]
    { let _ = directory; parent.to_path_buf() }
}

pub(super) fn open_regular(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { return Err(io::Error::other("Select a regular text file")); }
    Ok(file)
}

pub(super) fn candidate_path(recovery: &Path) -> PathBuf {
    #[cfg(windows)]
    { let mut path = recovery.as_os_str().to_os_string(); path.push("-draft"); PathBuf::from(path) }
    #[cfg(not(windows))]
    { recovery.to_path_buf() }
}

pub(super) fn create_candidate(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)
}

pub(super) fn prepare_directory(directory: &File) -> io::Result<()> {
    #[cfg(unix)]
    { directory.sync_all() }
    #[cfg(windows)]
    { let _ = directory; Ok(()) }
}

#[cfg(unix)]
pub(super) fn exchange(directory: &File, target: &Path, candidate: &Path, _recovery: &Path) -> io::Result<()> {
    let target = std::ffi::CString::new(target.file_name().unwrap_or_default().as_encoded_bytes())?;
    let candidate = std::ffi::CString::new(candidate.file_name().unwrap_or_default().as_encoded_bytes())?;
    let fd = directory.as_raw_fd();
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::renameat2(fd, candidate.as_ptr(), fd, target.as_ptr(), libc::RENAME_EXCHANGE) };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renameatx_np(fd, candidate.as_ptr(), fd, target.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(windows)]
pub(super) fn exchange(_directory: &File, target: &Path, candidate: &Path, recovery: &Path) -> io::Result<()> {
    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "ReplaceFileW"]
        fn replace_file(target: *const u16, replacement: *const u16, backup: *const u16, flags: u32, exclude: *mut std::ffi::c_void, reserved: *mut std::ffi::c_void) -> i32;
    }
    let target: Vec<u16> = target.as_os_str().encode_wide().chain([0]).collect();
    let candidate: Vec<u16> = candidate.as_os_str().encode_wide().chain([0]).collect();
    let recovery: Vec<u16> = recovery.as_os_str().encode_wide().chain([0]).collect();
    let result = unsafe { replace_file(target.as_ptr(), candidate.as_ptr(), recovery.as_ptr(), 0, std::ptr::null_mut(), std::ptr::null_mut()) };
    if result != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

pub(super) fn definitely_unchanged(error: &io::Error) -> bool {
    #[cfg(unix)]
    { error.raw_os_error().is_some_and(|code| [libc::ENOSYS, libc::EINVAL, libc::EOPNOTSUPP, libc::ENOTSUP].contains(&code)) }
    #[cfg(windows)]
    { error.raw_os_error().is_some_and(|code| code != ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) }
}
