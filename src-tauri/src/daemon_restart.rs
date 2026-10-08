use crate::{daemon_clients::DaemonClients, daemon_endpoint, platform::AppHandle, restart_artifacts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

static PREPARING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct Preparation;
impl Drop for Preparation {
    fn drop(&mut self) { PREPARING.store(false, std::sync::atomic::Ordering::SeqCst); }
}

#[derive(Default)]
pub(crate) struct Runtime {
    pub gate: tokio::sync::RwLock<()>,
}

pub(crate) fn blocking() -> bool {
    PREPARING.load(std::sync::atomic::Ordering::SeqCst)
        || (restart_artifacts::active_plan().unwrap_or(true) && read_plan().is_ok_and(|plan| plan.owner == std::process::id()))
}

#[derive(Serialize, Deserialize)]
struct Plan {
    id: String,
    owner: u32,
    executable: PathBuf,
    fallback: PathBuf,
    enabled: Vec<String>,
    previous: Vec<String>,
    tickets: Value,
    bind: String,
    debug_bind: Option<String>,
    automatic: bool,
}

fn path(name: &str) -> Result<PathBuf, String> { Ok(daemon_endpoint::directory()?.join(name)) }

fn write(name: &str, value: &impl Serialize) -> Result<(), String> {
    let _publication = restart_artifacts::publication_lock()?;
    crate::atomic_write_private(&path(name)?, &serde_json::to_vec(value).map_err(|error| error.to_string())?)
}

fn read_plan() -> Result<Plan, String> {
    serde_json::from_slice(&fs::read(path("restart-plan.json")?).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

pub(crate) fn status(id: &str) -> Result<Value, String> {
    let status: Value = serde_json::from_slice(&fs::read(path("restart-status.json")?).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    if status["restartId"] != id { return Err("This restart has been superseded by another restart".into()); }
    Ok(status)
}

fn publish(plan: &Plan, phase: &str, error: Option<&str>, pid: Option<u32>) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    write("restart-status.json", &json!({"restartId":plan.id,"phase":phase,"error":error,"processId":pid,"expiresAt":now + 180}))
}

fn executable() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PIOP_DAEMON_EXECUTABLE") { return Ok(path.into()); }
    current_executable()
}

fn current_executable() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let text = current.to_string_lossy();
    Ok(text.strip_suffix(" (deleted)").map(PathBuf::from).unwrap_or(current))
}

fn replacement_executable() -> Result<PathBuf, String> {
    let executable = fs::canonicalize(executable()?).map_err(|error| format!("Updated daemon is unavailable: {error}"))?;
    let metadata = fs::metadata(&executable).map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err(format!("Updated daemon is missing: {}", executable.display())); }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; if metadata.permissions().mode() & 0o111 == 0 { return Err("Updated daemon is not executable".into()); } }
    Ok(executable)
}

fn make_plan(app: &AppHandle, prepared: Value) -> Result<(Plan, restart_artifacts::Backup), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let debug_bind = debug_restart_bind()?;
    let endpoint = daemon_endpoint::read()?;
    let executable = replacement_executable()?;
    let enabled = serde_json::from_value(prepared["enabled"].clone()).map_err(|error| error.to_string())?;
    let previous = serde_json::from_value(prepared["previous"].clone()).map_err(|error| error.to_string())?;
    if !prepared["tickets"].is_array() { return Err("Invalid restart checkpoint tickets".into()); }
    let bind = restart_bind(&endpoint.url);
    validate_restart_bind(&bind)?;
    let backup = restart_artifacts::Backup::create(&id, &executable)?;
    let plan = Plan { fallback: backup.path.clone(), id, owner: std::process::id(), executable, enabled, previous,
        tickets: prepared["tickets"].clone(), bind, debug_bind, automatic: app.state::<DaemonClients>().automatic() };
    Ok((plan, backup))
}

fn validate_restart_bind(bind: &str) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    let mut addresses = bind.to_socket_addrs().map_err(|error| format!("Invalid restart bind address: {error}"))?;
    addresses.next().map(|_| ()).ok_or_else(|| "Restart bind address has no addresses".into())
}

fn debug_restart_bind() -> Result<Option<String>, String> {
    let bind = fs::read(path("debug-mobile.json")?).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|endpoint| endpoint["url"].as_str().map(|url| url.trim_start_matches("ws://").to_owned()));
    if let Some(bind) = &bind { validate_restart_bind(bind)?; }
    Ok(bind)
}

fn restart_bind(url: &str) -> String {
    let address = url.trim_start_matches("ws://");
    let Ok(bind) = std::env::var("PIOP_MOBILE_BIND") else { return address.into(); };
    match (bind.strip_suffix(":0"), address.rsplit_once(':')) {
        (Some(host), Some((_, port))) => format!("{host}:{port}"),
        _ => bind,
    }
}

pub(crate) fn prepare(app: AppHandle, mut args: Value) -> Result<Value, String> {
    if !args.is_object() { return Err("Restart arguments must be an object".into()); }
    reconcile_restart()?;
    let terminals = app.state::<crate::TerminalRuntime>().running_count()?;
    if terminals > 0 && args["closeTerminals"].as_bool() != Some(true) {
        return Ok(json!({"confirmationRequired":"terminals","terminalCount":terminals}));
    }
    let daemon = crate::plugins::connection(&app)?;
    if PREPARING.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("A daemon restart is already being prepared".into()); }
    let _preparation = Preparation;
    ensure_restart_safe(&app)?;
    args["type"] = json!("prepare_daemon_restart");
    prepare_plugin_handoff(&app, &daemon, args)
}

fn reconcile_restart() -> Result<(), String> {
    if let Err(error) = restart_artifacts::reconcile() { eprintln!("Restart artifact cleanup remains pending: {error}"); }
    if restart_artifacts::active_plan()? { return Err("A daemon restart is already in progress".into()); }
    Ok(())
}

fn prepare_plugin_handoff(app: &AppHandle, daemon: &crate::daemon::Daemon, args: Value) -> Result<Value, String> {
    let prepared = daemon.request(args)?;
    let preserving_notes = ["enabled", "previous"].iter().all(|key| prepared[key].as_array().is_some_and(|ids| ids.iter().any(|id| id == "markdown")));
    let leases = if preserving_notes { Some(crate::host_supervisor::preserve_leases_for_restart()?) } else { None };
    let (plan, backup) = make_plan(app, prepared)?;
    let result = prepare_handoff(&plan)?;
    backup.hand_off();
    if let Some(leases) = leases { leases.commit(); }
    Ok(result)
}

fn ensure_restart_safe(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::BrokerRuntime>().ensure_idle()?;
    crate::peers::ensure_restart_safe(app)
}

pub(crate) fn ensure_local_idle(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::BrokerRuntime>().ensure_idle()?;
    if !app.state::<crate::TerminalRuntime>().working_directories("local")?.is_empty() { return Err("Close running terminals before restarting the daemon".into()); }
    if crate::plugins::connection(app)?.request(json!({"type":"check_daemon_idle"}))? != true {
        return Err("Wait for active plugins to finish before restarting the daemon".into());
    }
    Ok(())
}

fn prepare_handoff(plan: &Plan) -> Result<Value, String> {
    let result = write("restart-plan.json", plan).and_then(|()| publish(plan, "preparing", None, None)).and_then(|()| arm(plan));
    if let Err(error) = &result {
        if read_plan().is_ok_and(|current| current.id == plan.id) {
            let _ = publish(plan, "failed", Some(error), None);
        }
    }
    result.map(|()| json!({"restartId":plan.id}))
}

fn arm(plan: &Plan) -> Result<(), String> {
    let mut coordinator = launch(plan, &plan.fallback, "--restart-coordinator")?;
    let result = wait_armed(plan, &mut coordinator);
    if result.is_err() { let _ = coordinator.kill(); let _ = coordinator.wait(); }
    else { thread::spawn(move || { let _ = coordinator.wait(); }); }
    result
}

fn wait_armed(plan: &Plan, coordinator: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline {
        let value = status(&plan.id)?;
        if value["phase"] == "armed" { return Ok(()); }
        if value["phase"] == "failed" { return Err(value["error"].as_str().unwrap_or("Restart validation failed").into()); }
        if coordinator.try_wait().map_err(|error| error.to_string())?.is_some() { return Err("Restart coordinator stopped before validation completed".into()); }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Restart validation timed out; the previous daemon is still running".into())
}

pub(crate) fn commit(app: AppHandle, id: &str) {
    let Ok(plan) = read_plan() else { return; };
    if plan.id != id || plan.owner != std::process::id() { return; }
    if !status(id).is_ok_and(|value| value["phase"] == "armed") { return; }
    if publish(&plan, "restarting", None, None).is_err() { return; }
    let _ = app.emit("pi://daemon-restarting", json!({"hostId":"local","restartId":id}));
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        app.state::<DaemonClients>().stop();
    });
}

fn launch(plan: &Plan, executable: &std::path::Path, mode: &str) -> Result<Child, String> {
    let mut command = Command::new(executable);
    command.args([mode, &plan.id]).stdin(Stdio::null()).stdout(Stdio::null())
        .env("PIOP_DAEMON_EXECUTABLE", &plan.executable).env("PIOP_MOBILE_BIND", &plan.bind);
    let logger = if mode == "--restart-candidate" { executable.to_path_buf() } else { crate::daemon_log::running_executable()? };
    crate::daemon_log::configure(&mut command, &logger)?;
    if let Some(bind) = &plan.debug_bind { command.env("PIOP_DEBUG_MOBILE_BIND", bind); }
    if plan.automatic { command.env("PIOP_RESTART_AUTOMATIC", "1"); } else { command.env_remove("PIOP_RESTART_AUTOMATIC"); }
    crate::daemon_log::spawn(command)
}

fn validate(plan: &Plan) -> Result<(), String> {
    let mut child = launch(plan, &plan.executable, "--validate-plugins")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() { Ok(()) } else { Err("Updated daemon could not load the plugins; the previous daemon is still running. See daemon.log for details.".into()) };
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill(); let _ = child.wait();
    Err("Updated plugin validation timed out; the previous daemon is still running".into())
}

fn wait_for_handoff(plan: &Plan) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        let value = status(&plan.id)?;
        if value["phase"] == "failed" { return Err("Restart was cancelled before shutdown".into()); }
        if value["phase"] == "restarting" && daemon_endpoint::claim().is_ok() { return Ok(()); }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Daemon restart handoff timed out".into())
}

fn start_candidate(plan: &Plan, fallback: bool) -> Result<u32, String> {
    let enabled = if fallback { &plan.previous } else { &plan.enabled };
    write("plugins.json", &json!({"enabled":enabled,"previous":plan.previous}))?;
    let _ = fs::remove_file(path("restart-ready.json")?);
    let mut child = launch(plan, if fallback { &plan.fallback } else { &plan.executable }, "--restart-candidate")?;
    let result = wait_ready(plan, &mut child);
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    result
}

fn wait_ready(plan: &Plan, child: &mut Child) -> Result<u32, String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() { return Err("The replacement daemon stopped during startup".into()); }
        let ready = fs::read(path("restart-ready.json")?).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if ready.is_some_and(|ready| ready["restartId"] == plan.id && ready["processId"] == child.id()) { return Ok(child.id()); }
        thread::sleep(Duration::from_millis(100));
    }
    Err("The replacement daemon did not become ready".into())
}

fn coordinate(plan: &Plan) -> Result<(), String> {
    validate(plan)?;
    publish(plan, "armed", None, None)?;
    wait_for_handoff(plan)?;
    match start_candidate(plan, false) {
        Ok(pid) => publish(plan, "complete", None, Some(pid)),
        Err(error) => match start_candidate(plan, true) {
            Ok(pid) => publish(plan, "rolled_back", Some(&format!("{error}. Restored the previous daemon and plugins.")), Some(pid)),
            Err(rollback) => Err(format!("{error}. The previous daemon also failed to start: {rollback}. See daemon.log for details.")),
        },
    }
}

pub(crate) fn special_mode() -> Option<Result<(), String>> {
    let mode = std::env::args().nth(1)?;
    if !matches!(mode.as_str(), "--restart-coordinator" | "--validate-plugins") { return None; }
    Some(run_special(&mode))
}

fn run_special(mode: &str) -> Result<(), String> {
    let plan = read_plan()?;
    if std::env::args().nth(2).as_deref() != Some(&plan.id) { return Err("Invalid daemon restart identifier".into()); }
    if mode == "--validate-plugins" {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
        return runtime.block_on(crate::host_supervisor::validate_configuration(&crate::pi_executable().to_string_lossy(), plan.enabled));
    }
    let result = coordinate(&plan);
    if let Err(error) = &result { let _ = publish(&plan, "failed", Some(error), None); }
    if let Err(error) = restart_artifacts::reconcile() { eprintln!("Restart artifact cleanup remains pending: {error}"); }
    result
}

pub(crate) fn startup_tickets() -> Option<Value> {
    if std::env::args().nth(1).as_deref() != Some("--restart-candidate") { return None; }
    read_plan().ok().filter(|plan| std::env::args().nth(2).as_deref() == Some(&plan.id)).map(|plan| plan.tickets)
}

pub(crate) fn initialize_candidate(app: AppHandle) -> Result<(), String> {
    if std::env::args().nth(1).as_deref() != Some("--restart-candidate") { return Ok(()); }
    let plan = read_plan()?;
    if std::env::args().nth(2).as_deref() != Some(&plan.id) { return Err("Invalid daemon restart identifier".into()); }
    let result = crate::plugins::dispatch(app, "plugin_status", json!({}))?;
    if let Some(error) = result["error"].as_str() { return Err(error.into()); }
    Ok(())
}

pub(crate) fn ready() -> Result<(), String> {
    if std::env::args().nth(1).as_deref() != Some("--restart-candidate") { return Ok(()); }
    let plan = read_plan()?;
    write("restart-ready.json", &json!({"restartId":plan.id,"processId":std::process::id()}))
}
