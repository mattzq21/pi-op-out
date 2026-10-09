use std::{fs, io::Read, path::{Path, PathBuf}, process::{Command, ExitStatus, Stdio}, thread};
use crate::STORAGE_DIRECTORY;

pub(crate) fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

pub(crate) fn desktop_sessions_dir(home: &Path) -> PathBuf { home.join(STORAGE_DIRECTORY).join("sessions") }

pub(crate) fn ensure_desktop_sessions_dir(home: &Path) -> Result<PathBuf, String> {
    let root = desktop_sessions_dir(home);
    fs::create_dir_all(&root).map_err(|error| format!("Could not create piop session directory: {error}"))?;
    Ok(root)
}

pub(crate) struct LimitedOutput { pub(crate) status: ExitStatus, pub(crate) stdout: Vec<u8>, pub(crate) stderr: Vec<u8> }

pub(crate) fn run_limited(command: &mut Command, max_stdout: usize, context: &str) -> Result<LimitedOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("{context}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{context}: stdout was unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{context}: stderr was unavailable"))?;
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr; let mut retained = Vec::new(); let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => { let remaining = (64 * 1024usize).saturating_sub(retained.len()); retained.extend_from_slice(&buffer[..count.min(remaining)]); }
            }
        }
        retained
    });
    let mut bytes = Vec::new(); stdout.take((max_stdout + 1) as u64).read_to_end(&mut bytes).map_err(|error| format!("{context}: {error}"))?;
    let oversized = bytes.len() > max_stdout;
    if oversized { let _ = child.kill(); }
    let status = child.wait().map_err(|error| format!("{context}: {error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if oversized { return Err(format!("{context}: output exceeded {} MiB", max_stdout / 1024 / 1024)); }
    Ok(LimitedOutput { status, stdout: bytes, stderr })
}

