use super::protocol::Result;
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

pub(super) async fn load(home: &Path, storage: &str, settings: &Value, initial: bool) -> Result<Value> {
    let path = home.join(storage).join("piop-define-agents/config.json");
    let response = uuid::Uuid::new_v4().to_string();
    let mut child = Command::new("node")
        .args(["--input-type=module", "-", &settings.to_string()])
        .env("HOME", home)
        .env("PIOP_STORAGE_DIRECTORY", storage)
        .env("PI_CODING_AGENT_DIR", home.join(storage))
        .env("PIOP_AGENT_CONFIG_PATH", &path)
        .env("PIOP_AGENT_RESPONSE_ID", &response)
        .env("PIOP_GENERATED_EXTENSION_ROOT", crate::extensions::generated_extension_root()?)
        .env("PIOP_PI_EXECUTABLE", crate::environment::pi_executable())
        .env("PIOP_AGENT_INITIAL_LOAD", if initial { "1" } else { "0" })
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true).spawn().map_err(|error| format!("Could not load agent definitions: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Agent loader input unavailable")?;
    let output = tokio::time::timeout(Duration::from_secs(30), async move {
        stdin.write_all(include_bytes!("../../resources/agent-definitions.bundle.mjs")).await.map_err(|error| error.to_string())?;
        drop(stdin);
        child.wait_with_output().await.map_err(|error| error.to_string())
    }).await.map_err(|_| "Loading agent definitions timed out")??;
    if !output.status.success() {
        return Err(format!("Could not load agent definitions: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    read_definitions(&output.stdout, &response)
}

fn read_definitions(output: &[u8], response: &str) -> Result<Value> {
    let prefix = format!("{response}:");
    let bytes = output.split(|byte| *byte == b'\n').rev().find_map(|line| line.strip_prefix(prefix.as_bytes())).ok_or("Agent definitions response is missing")?;
    let definitions: Value = serde_json::from_slice(bytes).map_err(|error| format!("Invalid agent definitions: {error}"))?;
    if !definitions["config"]["agents"].is_array() || !definitions["prompts"].is_object() {
        return Err("Invalid agent definitions".into());
    }
    Ok(definitions)
}
