use std::path::PathBuf;

pub(super) fn home_dir() -> Result<PathBuf, String> {
    #[cfg(feature = "test-home")]
    if let Some(path) = std::env::var_os("PIOP_TEST_HOME") { return Ok(PathBuf::from(path)); }
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

pub(super) fn pi_executable() -> PathBuf { pi_executable_in(home_dir().ok()) }

pub(super) fn pi_executable_in(home: Option<PathBuf>) -> PathBuf {
    if let Some(home) = home {
        for candidate in [home.join(".local/bin/pi"), home.join(".npm-global/bin/pi"), home.join(".bun/bin/pi")] { if candidate.is_file() { return candidate; } }
    }
    pi_on_path().unwrap_or_else(|| PathBuf::from("pi"))
}

fn pi_on_path() -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|directory| directory.join("pi")).find(|candidate| candidate.is_file())
}

pub(super) fn codex_executable() -> PathBuf {
    if let Ok(home) = home_dir() {
        for candidate in [home.join(".local/bin/codex"), home.join(".npm-global/bin/codex"), home.join(".bun/bin/codex")] { if candidate.is_file() { return candidate; } }
    }
    PathBuf::from("codex")
}

