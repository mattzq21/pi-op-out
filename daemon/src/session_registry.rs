use serde_json::{json, Value};
use std::{collections::HashSet, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};

pub(crate) fn source() -> String {
    include_str!("../resources/session-registry.bundle.mjs").to_owned()
}

pub(crate) fn with_database(script: &str) -> String {
    let allocation = if script.contains("require('./worktree-allocation.cjs')") {
        format!("const worktreeAllocation = (() => {{ const module = {{exports:{{}}}}; {} return module.exports; }})();\n",
            include_str!("../resources/worktree-allocation.cjs").replace("require('./session-database.cjs')", "sessionDatabase"))
    } else { String::new() };
    let comparisons = if script.contains("require('./snapshot-comparison-records.cjs')") {
        format!("const snapshotComparisonRecords = (() => {{ const module = {{exports:{{}}}}; {} return module.exports; }})();\n",
            include_str!("../resources/snapshot-comparison-records.cjs").replace("require('./session-database.cjs')", "sessionDatabase"))
    } else { String::new() };
    let metadata = if script.contains("require('./snapshot-metadata.cjs')") {
        format!("const snapshotMetadata = (() => {{ const module = {{exports:{{}}}}; {} return module.exports; }})();\n",
            include_str!("../resources/snapshot-metadata.cjs").replace("require('./session-database.cjs')", "sessionDatabase"))
    } else { String::new() };
    format!("const sessionDatabase = (() => {{ const module = {{exports:{{}}}}; {} return module.exports; }})();\n{allocation}{comparisons}{metadata}{}",
        include_str!("../resources/session-database.cjs"),
        script.replace("require('./session-database.cjs')", "sessionDatabase").replace("require('./worktree-allocation.cjs')", "worktreeAllocation").replace("require('./snapshot-comparison-records.cjs')", "snapshotComparisonRecords").replace("require('./snapshot-metadata.cjs')", "snapshotMetadata"))
}

fn run(mut request: Value) {
    let result = (|| -> Result<(), String> {
        request["root"] = json!(crate::environment::home_dir()?.join(crate::STORAGE_DIRECTORY));
        let output = crate::node_command().args(["-e", &source(), &request.to_string()])
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

pub(crate) fn open(root: &Path) -> Result<rusqlite::Connection, String> {
    static READY: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let mut ready = READY.get_or_init(Mutex::default).lock().map_err(|_| "Session database lock was poisoned")?;
    if !ready.contains(root) {
        let request = json!({"root":root,"action":"initialize"});
        let output = crate::node_command().args(["-e", &source(), &request.to_string()])
            .output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        ready.insert(root.to_path_buf());
    }
    drop(ready);
    let connection = rusqlite::Connection::open(root.join("sessions.sqlite")).map_err(|error| error.to_string())?;
    connection.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;").map_err(|error| error.to_string())?;
    Ok(connection)
}
