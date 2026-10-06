use super::*;

pub(crate) fn dispatch(app: AppHandle, operation: &str, mut args: Value) -> Result<Value, String> {
    if !args.is_object() { return Err("Plugin arguments must be an object".into()); }
    if args.to_string().len() > 5 * 1024 * 1024 { return Err("Plugin request is too large".into()); }
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let broker = app.state::<BrokerRuntime>();
    let daemon = daemon::connect(&app, &runtime, &broker, &settings, "local")?;
    args["type"] = json!(operation);
    let result = daemon.request(args)?;
    if operation == "restart_daemon" { let _ = app.emit("pi://plugins-changed", json!({"hostId":"local"})); }
    Ok(result)
}
