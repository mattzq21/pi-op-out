use super::*;

#[cfg(feature = "desktop")]
#[tauri::command(async)]
pub(crate) fn provider_auth(app: AppHandle, window: tauri::WebviewWindow, host_id: Option<String>, request: Value) -> Result<Value, String> {
    for_owner(app, window.label().into(), host_id, request)
}

pub(crate) fn for_owner(app: AppHandle, owner: String, host_id: Option<String>, request: Value) -> Result<Value, String> {
    if !matches!(request["action"].as_str(), Some("list" | "begin" | "poll" | "reply" | "cancel" | "logout")) { return Err("Unknown provider authentication operation".into()); }
    if request.to_string().len() > 256 * 1024 { return Err("Provider authentication request is too large".into()); }
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let broker = app.state::<BrokerRuntime>();
    let daemon = daemon::connect(&app, &runtime, &broker, &settings, host_id.as_deref().unwrap_or("local"))?;
    daemon.request(json!({"type":"provider_auth","owner":owner,"request":request}))
}

pub(crate) fn cancel_owner(runtime: &PiRuntime, owner: &str) {
    let daemons = runtime.daemons.lock().map(|daemons| daemons.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for daemon in daemons { let _ = daemon.request(json!({"type":"provider_auth_cancel_owner","owner":owner})); }
}
