use super::protocol::Result;
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

struct ResponseFile(PathBuf);

impl ResponseFile {
    fn new(home: &Path, storage: &str) -> Result<Self> {
        let directory = home.join(storage).join("tmp");
        crate::ensure_private_dir(&directory)?;
        let file = Self(directory.join(format!("agent-definitions-{}.json", uuid::Uuid::new_v4())));
        crate::settings_storage::atomic_write_private(&file.0, b"")?;
        Ok(file)
    }
}

impl Drop for ResponseFile {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

pub(super) async fn load(home: &Path, storage: &str, settings: &Value, initial: bool) -> Result<Value> {
    let path = home.join(storage).join("piop-define-agents/config.json");
    let response = ResponseFile::new(home, storage)?;
    let mut child = Command::new("node")
        .args(["--input-type=module", "-", &settings.to_string()])
        .env("HOME", home)
        .env("PIOP_STORAGE_DIRECTORY", storage)
        .env("PIOP_AGENT_CONFIG_PATH", &path)
        .env("PIOP_AGENT_RESPONSE_PATH", &response.0)
        .env("PIOP_GENERATED_EXTENSION_ROOT", crate::extensions::generated_extension_root()?)
        .env("PIOP_PI_EXECUTABLE", crate::environment::pi_executable())
        .env("PIOP_AGENT_INITIAL_LOAD", if initial { "1" } else { "0" })
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true).spawn().map_err(|error| format!("Could not load agent definitions: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Agent loader input unavailable")?;
    let output = tokio::time::timeout(Duration::from_secs(30), async move {
        stdin.write_all(include_bytes!("../../../../resources/agent-definitions.bundle.mjs")).await.map_err(|error| error.to_string())?;
        drop(stdin);
        child.wait_with_output().await.map_err(|error| error.to_string())
    }).await.map_err(|_| "Loading agent definitions timed out")??;
    if !output.status.success() {
        return Err(format!("Could not load agent definitions: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    read_definitions(&response.0)
}

fn read_definitions(path: &Path) -> Result<Value> {
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read agent definitions: {error}"))?;
    let definitions: Value = serde_json::from_slice(&bytes).map_err(|error| format!("Invalid agent definitions: {error}"))?;
    if !definitions["config"]["agents"].is_array() || !definitions["prompts"].is_object() {
        return Err("Invalid agent definitions".into());
    }
    Ok(definitions)
}
