use std::{collections::{HashMap, HashSet}, process::Command};
use crate::{SessionSummary, process_io::run_limited};

pub(crate) fn inspect_session_projects_with(sessions: &mut [SessionSummary], mut command: impl FnMut(&str, &[String]) -> Command) -> Result<(), String> {
    let mut directories = sessions.iter().map(|session| session.cwd.clone()).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    directories.sort();
    let script = r#"for path do
        if [ -d "$path" ]; then printf '1'; else printf '0'; fi
    done"#;
    let mut folders = HashMap::new();
    for batch in directories.chunks(16) {
        let output = run_limited(&mut command(script, batch), batch.len(), "Could not check session folders")?;
        if !output.status.success() { return Err(format!("Could not check session folders: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        if output.stdout.len() != batch.len() || output.stdout.iter().any(|flag| !matches!(flag, b'0' | b'1')) {
            return Err("Could not check every session folder".into());
        }
        for (path, flag) in batch.iter().zip(output.stdout) { folders.insert(path.as_str(), flag == b'1'); }
    }
    for session in sessions {
        if let Some(exists) = folders.get(session.cwd.as_str()) { session.cwd_exists = *exists; }
    }
    Ok(())
}
