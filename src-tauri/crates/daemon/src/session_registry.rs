use serde_json::{json, Value};
use std::{sync::OnceLock, time::{SystemTime, UNIX_EPOCH}};

fn run(mut request: Value) {
    let result = (|| -> Result<(), String> {
        request["root"] = json!(crate::environment::home_dir()?.join(crate::STORAGE_DIRECTORY));
        let output = crate::node_command().args(["-e", include_str!("../../../resources/session-registry.cjs"), &request.to_string()])
            .output().map_err(|error| error.to_string())?;
        if !output.status.success() || !output.stderr.is_empty() {
            eprintln!("Session registry: {}", String::from_utf8_lossy(&output.stderr));
        }
        Ok(())
    })();
    if let Err(error) = result { eprintln!("Session registry: {error}"); }
}

pub(crate) fn record(state: &Value, cwd: Option<&str>) {
    let (Some(id), Some(cwd)) = (state["sessionId"].as_str(), cwd) else { return; };
    let request = json!({"action":"record", "sessionId":id, "sessionPath":state["sessionFile"], "cwd":cwd,
        "checkedAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64});
    std::thread::spawn(move || run(request));
}

pub(crate) fn index_existing() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| { std::thread::spawn(|| run(json!({"action":"scan"}))); });
}
