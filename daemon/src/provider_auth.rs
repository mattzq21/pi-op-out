use super::*;

pub(crate) fn for_owner(app: AppHandle, owner: String, host_id: Option<String>, request: Value) -> Result<Value, String> {
    if !matches!(request["action"].as_str(), Some("list" | "begin" | "poll" | "reply" | "cancel" | "logout" | "create" | "fast_capabilities" | "draft_catalog")) { return Err("Unknown provider authentication operation".into()); }
    if request.to_string().len() > 256 * 1024 { return Err("Provider authentication request is too large".into()); }
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let broker = app.state::<BrokerRuntime>();
    let daemon = daemon::connect(&app, &runtime, &broker, &settings, host_id.as_deref().unwrap_or("local"))?;
    if request["action"] == "draft_catalog" {
        let definitions = daemon.request(json!({"type":"agent_definitions"}))?;
        let catalog = daemon.request(json!({"type":"provider_auth","owner":owner,"request":request}))?;
        let commands: Value = serde_json::from_str(include_str!("../resources/agent-commands.json")).map_err(|error| error.to_string())?;
        return Ok(json!({"config":definitions["config"],"models":catalog["models"],"commands":commands}));
    }
    daemon.request(json!({"type":"provider_auth","owner":owner,"request":request}))
}

pub(crate) fn cancel_owner(runtime: &PiRuntime, owner: &str) {
    let daemons = runtime.connections.snapshot();
    for daemon in daemons { let _ = daemon.request(json!({"type":"provider_auth_cancel_owner","owner":owner})); }
}
