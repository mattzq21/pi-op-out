use crate::platform::AppHandle;
use crate::{BrokerRuntime, PiRuntime, TerminalRuntime, daemon_clients, daemon_endpoint, daemon_stdio, dictation, mobile, peers, provider_auth};
use crate::{pi_runtime, terminals, worktree_setup};
use crate::broker::start_session_broker;

#[cfg(not(feature = "desktop"))]
pub fn run_daemon() -> Result<(), String> {
    if std::env::args().nth(1).as_deref() == Some("--daemon-log-writer") { return crate::daemon_log::run(); }
    if let Some(result) = crate::daemon_restart::special_mode() { return result; }
    if let Some(action @ ("start" | "stop")) = std::env::args().nth(1).as_deref() { return daemon_stdio::control(action); }
    if std::env::args().nth(1).as_deref() == Some("--stdio-client") { return daemon_stdio::run(); }
    let _instance = daemon_endpoint::claim()?;
    daemon_endpoint::identity()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| error.to_string())?;
    runtime.block_on(run_backend())
}

#[cfg(not(feature = "desktop"))]
async fn run_backend() -> Result<(), String> {
        let app = AppHandle::new();
        dictation::start(app.clone());
        start_session_broker(app.clone(), app.state::<BrokerRuntime>().inner().clone())?;
        start_local_agent_daemon(&app).await?;
        mobile::start(app.clone())?;
        crate::daemon_restart::ready()?;
        wait_for_shutdown(&app).await?;
        tokio::task::spawn_blocking(move || shutdown_backend(&app)).await.map_err(|error| error.to_string())?;
        Ok(())
}

#[cfg(not(feature = "desktop"))]
async fn start_local_agent_daemon(app: &AppHandle) -> Result<(), String> {
        let startup = app.clone();
        tokio::task::spawn_blocking(move || {
            let settings = crate::settings::load_app_settings(startup.clone())?;
            crate::extensions::prepare_defined_agents_extension()?;
            crate::daemon::connect(&startup, &startup.state::<PiRuntime>(), &startup.state::<BrokerRuntime>(), &settings, "local")?;
            crate::daemon_restart::initialize_candidate(startup)
        }).await.map_err(|error| error.to_string())??;
    Ok(())
}

#[cfg(not(feature = "desktop"))]
async fn wait_for_shutdown(app: &AppHandle) -> Result<(), String> {
        let clients = app.state::<daemon_clients::DaemonClients>();
        #[cfg(unix)]
        {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|error| error.to_string())?;
            tokio::select! {
                result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
                _ = terminate.recv() => {},
                _ = clients.wait_for_shutdown(app.clone()) => {},
            }
        }
        #[cfg(not(unix))]
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
            _ = clients.wait_for_shutdown(app.clone()) => {},
        }
    Ok(())
}

pub(super) fn detach_owner(app: &AppHandle, owner: &str, discard_blank: bool) {
    peers::detach_owner(app, owner);
    let runtime = app.state::<PiRuntime>();
    provider_auth::cancel_owner(&runtime, owner);
    worktree_setup::detach_worktree_setups(&runtime, owner);
    pi_runtime::detach_owner(&runtime, owner, discard_blank);
    terminals::detach_owner(&app.state::<TerminalRuntime>(), owner);
}

fn shutdown_backend(app: &AppHandle) {
    peers::shutdown(app);
    app.state::<BrokerRuntime>().shutdown();
    terminals::shutdown(&app.state::<TerminalRuntime>());
    let runtime = app.state::<PiRuntime>();
    worktree_setup::shutdown(&runtime);
    pi_runtime::shutdown(&runtime);
}
