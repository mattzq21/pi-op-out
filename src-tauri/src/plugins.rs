use super::*;

pub(crate) fn dispatch(app: AppHandle, operation: &str, mut args: Value) -> Result<Value, String> {
    if !args.is_object() { return Err("Plugin arguments must be an object".into()); }
    if args.to_string().len() > 5 * 1024 * 1024 { return Err("Plugin request is too large".into()); }
    if operation == "plugin_call" {
        let client = args["clientId"].as_str().filter(|id| !id.is_empty() && id.len() <= 200).ok_or("Missing plugin client identity")?.to_owned();
        if !args["request"].is_object() { return Err("Plugin request must be an object".into()); }
        args["request"]["clientId"] = json!(client);
    }
    let daemon = connection(&app)?;
    args["type"] = json!(operation);
    daemon.request(args)
}

pub(crate) fn connection(app: &AppHandle) -> Result<Arc<daemon::Daemon>, String> {
    let settings = load_app_settings(app.clone())?;
    daemon::connect(app, &app.state::<PiRuntime>(), &app.state::<BrokerRuntime>(), &settings, "local")
}
