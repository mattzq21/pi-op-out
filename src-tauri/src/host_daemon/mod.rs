mod agents;
mod branching;
mod catalogs;
mod controller;
mod ownership;
mod payload;
mod protocol;
mod provider_sdk;
mod providers;
mod plugins;
mod queue;
mod services;
mod session;
mod tool_payload;
mod tool_failures;
mod worker;

pub(crate) use plugins::{validate_configuration, with_note_deletion};

use futures_util::FutureExt;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::mpsc, thread};

pub(crate) struct Supervisor {
    pub input: tokio::sync::mpsc::UnboundedSender<Value>,
    pub worker: thread::JoinHandle<()>,
}

pub(crate) fn start(home: PathBuf, storage: String, executable: String, output: mpsc::Sender<Value>) -> Result<Supervisor, String> {
    let (input, packets) = tokio::sync::mpsc::unbounded_channel();
    let (ready, initialized) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("piop-host-supervisor".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            runtime.block_on(async move {
                match controller::Host::new(home, &storage, services::HostServices::new(executable), output).await {
                    Ok(host) => {
                        if ready.send(Ok(())).is_ok() {
                            serve(host, packets).await;
                        } else {
                            host.shutdown().await;
                        }
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
            });
        })
        .map_err(|error| error.to_string())?;
    match initialized
        .recv()
        .map_err(|_| "Host supervisor stopped during startup".to_owned())
        .and_then(|result| result)
    {
        Ok(()) => Ok(Supervisor { input, worker }),
        Err(error) => {
            let _ = worker.join();
            Err(error)
        }
    }
}

async fn serve(host: std::sync::Arc<controller::Host>, mut packets: tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
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
                if request.as_mut().now_or_never().is_none() { tasks.spawn(request); }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    host.shutdown().await;
}
