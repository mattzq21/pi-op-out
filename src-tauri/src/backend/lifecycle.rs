#[cfg(not(feature = "desktop"))]
async fn wait_for_desktop_exit() {
    if !DEVELOPMENT || !std::env::args().any(|argument| argument == "--parent-stdin") {
        return std::future::pending::<()>().await;
    }
    let (closed, receiver) = tokio::sync::oneshot::channel();
    thread::spawn(move || {
        use std::io::Read;
        let mut input = std::io::stdin().lock();
        let mut buffer = [0u8; 64];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {},
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = closed.send(());
    });
    let _ = receiver.await;
}

#[cfg(not(feature = "desktop"))]
pub fn run_daemon() -> Result<(), String> {
    if std::env::args().nth(1).as_deref() == Some("--stdio-client") { return daemon_stdio::run(); }
    let _instance = daemon_endpoint::claim()?;
    daemon_endpoint::identity()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let app = AppHandle::new();
        dictation::start(app.clone());
        start_session_broker(app.clone(), app.state::<BrokerRuntime>().inner().clone())?;
        mobile::start(app.clone())?;
        #[cfg(unix)]
        {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|error| error.to_string())?;
            tokio::select! {
                result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
                _ = terminate.recv() => {},
                _ = wait_for_desktop_exit() => {},
            }
        }
        #[cfg(not(unix))]
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string())?,
            _ = wait_for_desktop_exit() => {},
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
    let ids = runtime.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    for id in ids { let _ = detach_pi_with(&runtime, &id, discard_blank, !discard_blank); }
    let terminals = app.state::<TerminalRuntime>();
    let ids = terminals.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(&terminals, &ids);
}

fn shutdown_backend(app: &AppHandle) {
    #[cfg(not(feature = "desktop"))]
    peers::shutdown(app);
    app.state::<voice::VoiceRuntime>().shutdown();
    let broker = app.state::<BrokerRuntime>();
    broker.closing.store(true, Ordering::SeqCst);
    let jobs = broker.jobs.lock().map(|mut jobs| jobs.drain().map(|(_, child)| child).collect::<Vec<_>>()).unwrap_or_default();
    for child in jobs { if let Ok(mut child) = child.lock() { stop_message_worker(&mut child); } }
    let terminals = app.state::<TerminalRuntime>();
    let ids = terminals.processes.lock().map(|processes| processes.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    let _ = stop_terminals(&terminals, &ids);
    let runtime = app.state::<PiRuntime>();
    if let Ok(setups) = runtime.worktree_setups.lock() { for cancelled in setups.values() { cancelled.store(true, Ordering::SeqCst); } }
    if let Ok(daemons) = runtime.daemons.lock() { for daemon in daemons.values() { daemon.shutdown(); } }
    let ephemeral = runtime.ephemeral_sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()).unwrap_or_default();
    for session in ephemeral { remove_ephemeral_session(session); }
}
