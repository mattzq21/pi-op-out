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
            clients: Mutex::new(Clients { automatic: std::env::args().any(|argument| argument == "--exit-on-disconnect"), ..Clients::default() }),
            stopped: Notify::new(),
        }))
    }
}

pub(crate) struct Client(Arc<Lifetime>);

impl DaemonClients {
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

    pub(crate) async fn wait_for_shutdown(&self) {
        tokio::select! {
            _ = self.0.stopped.notified() => return,
            _ = tokio::time::sleep(Duration::from_secs(30)) => {},
        }
        {
            let mut clients = self.0.clients.lock().unwrap_or_else(|error| error.into_inner());
            if clients.automatic && clients.count == 0 { clients.closing = true; return; }
        }
        self.0.stopped.notified().await;
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let mut clients = self.0.clients.lock().unwrap_or_else(|error| error.into_inner());
        clients.count -= 1;
        if clients.automatic && clients.count == 0 {
            clients.closing = true;
            self.0.stopped.notify_one();
        }
    }
}
