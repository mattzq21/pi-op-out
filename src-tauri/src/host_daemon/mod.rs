mod branching;
mod catalogs;
mod controller;
mod ownership;
mod payload;
mod protocol;
mod provider_sdk;
mod providers;
mod queue;
mod services;
mod session;
mod voice;
mod worker;

use futures_util::FutureExt;
use serde_json::{json, Value};
use std::io::BufRead;

pub(crate) fn run() -> Result<(), String> {
    let executable = std::env::args()
        .nth(2)
        .unwrap_or_else(|| crate::pi_executable().to_string_lossy().into_owned());
    let storage = std::env::var("PIOP_STORAGE_DIRECTORY").unwrap_or_else(|_| crate::STORAGE_DIRECTORY.into());
    let home = crate::home_dir()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let host = controller::Host::new(home, &storage, services::HostServices::new(executable), Box::new(std::io::stdout())).await?;
        let (input, mut packets) = tokio::sync::mpsc::unbounded_channel();
        // A dedicated reader avoids an uncancellable Tokio stdin read keeping
        // the runtime alive after SIGTERM while its parent still holds the pipe.
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break; };
                if let Ok(packet) = serde_json::from_str::<Value>(&line) { if input.send(packet).is_err() { break; } }
            }
        });
        let mut tasks = tokio::task::JoinSet::new();
        let termination = termination(); tokio::pin!(termination);
        loop {
            tokio::select! {
                _ = &mut termination => break,
                Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                    if let Err(error) = result { host.output(json!({"type":"diagnostic","line":format!("Host command failed: {error}")})); }
                }
                packet = packets.recv() => {
                    let Some(packet) = packet else { break; };
                    if packet["type"] == "shutdown" { break; }
                    let current = host.clone();
                    let mut request = Box::pin(async move {
                        let id = packet.get("id").cloned();
                        let result = current.handle(packet).await;
                        let mut response = match result { Ok(data) => json!({"type":"response","data":data}), Err(error) => json!({"type":"response","error":error}) };
                        if let Some(id) = id { response["id"] = id; }
                        current.output(response);
                    });
                    // Start each handler in wire order before allowing later
                    // requests to run, preserving attach/detach and queue order.
                    if request.as_mut().now_or_never().is_none() { tasks.spawn(request); }
                }
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        host.shutdown().await;
        Ok(())
    })
}

async fn termination() {
    #[cfg(unix)]
    if let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}
