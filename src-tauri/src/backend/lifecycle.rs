#[cfg(not(feature = "desktop"))]
pub fn run_daemon() -> Result<(), String> {
    if let Some(action @ ("start" | "stop")) = std::env::args().nth(1).as_deref() { return daemon_stdio::control(action); }
    if std::env::args().nth(1).as_deref() == Some("--stdio-client") { return daemon_stdio::run(); }
    let _instance = daemon_endpoint::claim()?;
    daemon_endpoint::identity()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let app = AppHandle::new();
        dictation::start(app.clone());
        start_session_broker(app.clone(), app.state::<BrokerRuntime>().inner().clone())?;
        mobile::start(app.clone())?;
        let clients = app.state::<daemon_clients::DaemonClients>();
        #[cfg(unix)]
        {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|error| error.to_string())?;
            tokio::select! {
                result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
                _ = terminate.recv() => {},
                _ = clients.wait_for_shutdown() => {},
            }
        }
        #[cfg(not(unix))]
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
            _ = clients.wait_for_shutdown() => {},
        }
        tokio::task::spawn_blocking(move || shutdown_backend(&app)).await.map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn detach_owner(app: &AppHandle, owner: &str, discard_blank: bool) {
    #[cfg(not(feature = "desktop"))]
    peers::detach_owner(app, owner);
    let runtime = app.state::<PiRuntime>();
    provider_auth::cancel_owner(&runtime, owner);
    detach_worktree_setups(&runtime, owner);
    let ids = runtime.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    for id in ids { let _ = detach_pi_with(&runtime, &id, discard_blank, !discard_blank); }
    let terminals = app.state::<TerminalRuntime>();
    let ids = terminals.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(&terminals, &ids);
    terminal_lookup::detach(&terminals, owner);
}

fn shutdown_backend(app: &AppHandle) {
    #[cfg(not(feature = "desktop"))]
    peers::shutdown(app);
    let broker = app.state::<BrokerRuntime>();
    broker.closing.store(true, Ordering::SeqCst);
    let jobs = broker.jobs.lock().map(|mut jobs| jobs.drain().map(|(_, child)| child).collect::<Vec<_>>()).unwrap_or_default();
    for child in jobs { if let Ok(mut child) = child.lock() { stop_message_worker(&mut child); } }
    let terminals = app.state::<TerminalRuntime>();
    let ids = terminals.processes.lock().map(|processes| processes.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(&terminals, &ids);
    let runtime = app.state::<PiRuntime>();
    if let Ok(setups) = runtime.worktree_setups.lock() { for cancelled in setups.values() { cancelled.store(true, Ordering::SeqCst); } }
    let daemons = runtime.daemons.lock().map(|daemons| daemons.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for daemon in &daemons { daemon.shutdown(); }
    for daemon in daemons { daemon.wait_shutdown(); let _ = daemon.drain_captures(None); }
    let ephemeral = runtime.ephemeral_sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()).unwrap_or_default();
    for session in ephemeral { remove_ephemeral_session(session); }
    let previous = runtime.ephemeral_previous.lock().map(|mut sessions| sessions.drain().flat_map(|(_, sessions)| sessions).collect::<Vec<_>>()).unwrap_or_default();
    for session in previous { remove_ephemeral_session(session); }
}
