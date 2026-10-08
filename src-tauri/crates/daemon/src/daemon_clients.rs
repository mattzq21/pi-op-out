use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
struct Clients {
    count: usize,
    closing: bool,
    automatic: bool,
}

struct Lifetime {
    clients: Mutex<Clients>,
    stopped: Notify,
}

pub(crate) struct DaemonClients(Arc<Lifetime>);

impl Default for DaemonClients {
    fn default() -> Self {
        Self(Arc::new(Lifetime {
            clients: Mutex::new(Clients { automatic: std::env::args().any(|argument| argument == "--exit-on-disconnect") || std::env::var_os("PIOP_RESTART_AUTOMATIC").is_some(), ..Clients::default() }),
            stopped: Notify::new(),
        }))
    }
}

pub(crate) struct Client(Arc<Lifetime>);

impl DaemonClients {
    pub(crate) fn automatic(&self) -> bool {
        self.0.clients.lock().unwrap_or_else(|error| error.into_inner()).automatic
    }

    pub(crate) fn persist(&self) -> Result<(), String> {
        let mut clients = self.0.clients.lock().map_err(|error| error.to_string())?;
        if clients.closing { return Err("Piop daemon is shutting down".into()); }
        clients.automatic = false;
        Ok(())
    }

    pub(crate) fn stop(&self) {
        self.0.clients.lock().unwrap_or_else(|error| error.into_inner()).closing = true;
        self.0.stopped.notify_one();
    }

    pub(crate) fn connect(&self) -> Result<Client, String> {
        let mut clients = self.0.clients.lock().map_err(|error| error.to_string())?;
        if clients.closing { return Err("Piop daemon is shutting down".into()); }
        clients.count += 1;
        Ok(Client(self.0.clone()))
    }

    pub(crate) async fn wait_for_shutdown(&self, app: crate::platform::AppHandle) {
        tokio::select! {
            _ = self.0.stopped.notified() => {},
            _ = tokio::time::sleep(Duration::from_secs(30)) => {},
        }
        loop {
            if self.closing() { return; }
            if self.unattended() {
                let stopped = tokio::select! {
                    stopped = self.stop_if_idle(&app) => stopped,
                    _ = self.0.stopped.notified() => false,
                };
                if stopped { return; }
            }
            tokio::select! {
                _ = self.0.stopped.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
        }
    }

    async fn stop_if_idle(&self, app: &crate::platform::AppHandle) -> bool {
        let state = app.state::<crate::daemon_restart::Runtime>();
        let Ok(_guard) = state.gate.try_write() else { return false; };
        let checking = app.clone();
        let idle = tokio::task::spawn_blocking(move || crate::daemon_restart::ensure_local_idle(&checking))
            .await.is_ok_and(|result| result.is_ok());
        idle && self.close_if_unattended()
    }

    pub(crate) fn closing(&self) -> bool {
        self.0.clients.lock().unwrap_or_else(|error| error.into_inner()).closing
    }

    fn unattended(&self) -> bool {
        let clients = self.0.clients.lock().unwrap_or_else(|error| error.into_inner());
        clients.automatic && clients.count == 0
    }

    fn close_if_unattended(&self) -> bool {
        let mut clients = self.0.clients.lock().unwrap_or_else(|error| error.into_inner());
        if clients.automatic && clients.count == 0 { clients.closing = true; return true; }
        false
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let mut clients = self.0.clients.lock().unwrap_or_else(|error| error.into_inner());
        clients.count -= 1;
        if clients.automatic && clients.count == 0 {
            self.0.stopped.notify_one();
        }
    }
}
