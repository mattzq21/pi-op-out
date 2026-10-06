use crate::{daemon_clients::DaemonClients, daemon_endpoint, platform::AppHandle};
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
        || (daemon_endpoint::restart_active() && read_plan().is_ok_and(|plan| plan.owner == std::process::id()))
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
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let text = current.to_string_lossy();
    Ok(text.strip_suffix(" (deleted)").map(PathBuf::from).unwrap_or(current))
}

fn backup(id: &str) -> Result<PathBuf, String> {
    let target = path(&format!("restart-{id}{}", std::env::consts::EXE_SUFFIX))?;
    #[cfg(target_os = "linux")]
    let source = PathBuf::from("/proc/self/exe");
    #[cfg(not(target_os = "linux"))]
    let source = std::env::current_exe().map_err(|error| error.to_string())?;
    fs::copy(source, &target).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?; }
    Ok(target)
}

fn make_plan(app: &AppHandle, prepared: Value) -> Result<Plan, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let debug_bind = fs::read(path("debug-mobile.json")?).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|endpoint| endpoint["url"].as_str().map(|url| url.trim_start_matches("ws://").to_owned()));
    let endpoint = daemon_endpoint::read()?;
    Ok(Plan {
        fallback: backup(&id)?, id, owner: std::process::id(), executable: executable()?,
        enabled: serde_json::from_value(prepared["enabled"].clone()).map_err(|error| error.to_string())?,
        previous: serde_json::from_value(prepared["previous"].clone()).map_err(|error| error.to_string())?,
        tickets: prepared["tickets"].clone(),
        bind: restart_bind(&endpoint.url),
        debug_bind, automatic: app.state::<DaemonClients>().automatic(),
    })
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
    if daemon_endpoint::restart_active() { return Err("A daemon restart is already in progress".into()); }
    if !app.state::<crate::TerminalRuntime>().working_directories("local")?.is_empty() { return Err("Close running terminals before restarting the daemon".into()); }
    let daemon = crate::plugins::connection(&app)?;
    if PREPARING.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("A daemon restart is already being prepared".into()); }
    let _preparation = Preparation;
    args["type"] = json!("prepare_daemon_restart");
    let prepared = daemon.request(args)?;
    let plan = make_plan(&app, prepared)?;
    prepare_handoff(&plan)
}

fn prepare_handoff(plan: &Plan) -> Result<Value, String> {
    write("restart-plan.json", plan)?;
    publish(plan, "preparing", None, None)?;
    let result = arm(plan);
    if let Err(error) = &result {
        let _ = publish(plan, "failed", Some(error), None);
        let _ = fs::remove_file(&plan.fallback);
    }
    result.map(|()| json!({"restartId":plan.id}))
}

fn arm(plan: &Plan) -> Result<(), String> {
    let mut coordinator = launch(plan, &plan.fallback, "--restart-coordinator")?;
    let result = wait_armed(plan, &mut coordinator);
    if result.is_err() { let _ = coordinator.kill(); }
    thread::spawn(move || { let _ = coordinator.wait(); });
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
    let log_path = path("daemon.log")?;
    let log = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|error| error.to_string())?;
    crate::set_private_file_permissions(&log_path)?;
    let mut command = Command::new(executable);
    command.args([mode, &plan.id]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(log)
        .env("PIOP_DAEMON_EXECUTABLE", &plan.executable).env("PIOP_MOBILE_BIND", &plan.bind);
    if let Some(bind) = &plan.debug_bind { command.env("PIOP_DEBUG_MOBILE_BIND", bind); }
    if plan.automatic { command.env("PIOP_RESTART_AUTOMATIC", "1"); } else { command.env_remove("PIOP_RESTART_AUTOMATIC"); }
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); } Ok(()) }); } }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x00000008 | 0x00000200); }
    command.spawn().map_err(|error| format!("Could not start {}: {error}", executable.display()))
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
    if status(&plan.id).is_ok_and(|value| value["phase"] == "complete") { let _ = fs::remove_file(&plan.fallback); }
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
