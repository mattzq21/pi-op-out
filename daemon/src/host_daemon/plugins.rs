use super::{protocol::Result, provider_sdk::{Events, Sdk}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, OnceLock, Weak}, time::Duration};
use tokio::sync::RwLock;
use uuid::Uuid;

mod markdown;
mod markdown_leases;

pub(crate) use markdown::preserve_leases_for_restart;

const BUNDLED: &[&str] = &["chatgpt", "markdown", "diff"];
const CHATGPT_SOURCE: &str = concat!(
    include_str!("../../resources/chatgpt-stream.mjs"), "\n",
    include_str!("../../resources/chatgpt-storage.mjs"), "\n",
    include_str!("../../resources/chatgpt-service.mjs"),
    "\nconst bundledPlugin = { call: handleChatGpt, idle: chatGptIdle, checkpoint: chatGptTicketSnapshot, restore: chatGptRestore };"
);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    enabled: Vec<String>,
    previous: Vec<String>,
}

#[derive(Clone)]
struct Runtime {
    enabled: Vec<String>,
    chatgpt: Option<Arc<Sdk>>,
}

struct State {
    runtime: Runtime,
    revision: String,
    error: Option<String>,
}

impl State {
    fn status(&self) -> Value {
        json!({"enabled":self.runtime.enabled,"revision":self.revision,"error":self.error})
    }
}

struct PluginEvents(Arc<OnceLock<Weak<super::controller::Host>>>);
impl Events for PluginEvents {
    fn event(&self, packet: Value) {
        if packet["event"] != "chatgpt_changed" { return; }
        if let Some(host) = self.0.get().and_then(Weak::upgrade) {
            host.output(json!({"type":"chatgpt_changed","providerId":packet["providerId"],"scope":packet["scope"]}));
        }
    }
}

impl Runtime {
    async fn load(executable: &str, enabled: Vec<String>, events: Arc<dyn Events>) -> Result<Self> {
        validate(&enabled)?;
        let mut chatgpt: Option<Arc<Sdk>> = None;
        for id in &enabled {
            match id.as_str() {
                "markdown" => {
                    if let Err(error) = markdown::initialize() {
                        if let Some(sdk) = &chatgpt { sdk.shutdown().await; }
                        return Err(error);
                    }
                },
                "chatgpt" => chatgpt = Some(Arc::new(start_chatgpt(executable, events.clone()).await?)),
                "diff" => {},
                _ => unreachable!(),
            }
        }
        Ok(Self { enabled, chatgpt })
    }

    async fn drain(&self, disabling: bool) -> Result<bool> {
        let Some(sdk) = &self.chatgpt else { return Ok(true); };
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let idle = tokio::time::timeout(Duration::from_secs(5), sdk.request(json!({"method":"plugin_idle"}))).await
                    .map_err(|_| "ChatGPT worker did not respond to the restart readiness check".to_owned())
                    .and_then(|result| result)
                    .and_then(|value| value.as_bool().ok_or_else(|| "ChatGPT worker returned an invalid readiness response".to_owned()));
                match idle {
                    Ok(true) => return Ok(true),
                    Ok(false) => {},
                    Err(error) if disabling => { eprintln!("Disabling unavailable ChatGPT worker: {error}"); return Ok(false); },
                    Err(error) => return Err(error),
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }).await.map_err(|_| "ChatGPT is still responding. The previous plugins remain active; restart again when it finishes.".to_owned())?
    }

    async fn shutdown(&self) {
        if let Some(sdk) = &self.chatgpt { sdk.shutdown().await; }
    }

    async fn call(&self, packet: &Value) -> Result<Value> {
        let id = packet["pluginId"].as_str().ok_or("Missing plugin ID")?;
        let enabled = self.enabled.iter().any(|enabled| enabled == id);
        match id {
            "markdown" => {
                let request = packet["request"].clone();
                tokio::task::spawn_blocking(move || markdown::dispatch(request, enabled)).await.map_err(|error| error.to_string())?
            },
            _ if !enabled => Err(format!("The {id} plugin is disabled on this daemon")),
            "chatgpt" => self.chatgpt.as_ref().ok_or("ChatGPT plugin is unavailable")?.request(json!({"method":"plugin_call","request":packet["request"]})).await,
            _ => Err(format!("Unknown plugin: {id}")),
        }
    }

    async fn restore(&self, tickets: Value) -> Result<()> {
        if let Some(sdk) = &self.chatgpt {
            sdk.request(json!({"method":"plugin_restore","tickets":tickets})).await?;
        }
        Ok(())
    }

    async fn restore_startup(&self) -> Result<()> {
        if let Some(tickets) = crate::daemon_restart::startup_tickets() { self.restore(tickets).await?; }
        Ok(())
    }
}

async fn start_chatgpt(executable: &str, events: Arc<dyn Events>) -> Result<Sdk> {
    let sdk = Sdk::plugin(executable.into(), events, CHATGPT_SOURCE);
    let initialization = tokio::time::timeout(Duration::from_secs(20), sdk.request(json!({"method":"initialize"}))).await;
    let error = match initialization {
        Ok(Ok(value)) if value["authPath"].is_string() => None,
        Ok(Ok(_)) => Some("ChatGPT plugin returned an invalid startup response".into()),
        Ok(Err(error)) => Some(error),
        Err(_) => Some("ChatGPT plugin startup timed out".into()),
    };
    if let Some(error) = error { sdk.shutdown().await; return Err(error); }
    Ok(sdk)
}

fn validate(enabled: &[String]) -> Result<()> {
    let mut unique = std::collections::HashSet::new();
    for id in enabled {
        if !BUNDLED.contains(&id.as_str()) { return Err(format!("Unknown bundled plugin: {id}")); }
        if !unique.insert(id) { return Err(format!("Duplicate plugin: {id}")); }
    }
    Ok(())
}

fn configuration_path() -> Result<PathBuf> { Ok(crate::daemon_endpoint::directory()?.join("plugins.json")) }

fn configuration() -> Result<Configuration> {
    match crate::restart_storage::read(&configuration_path()?)? {
        Some(value) => serde_json::from_value(value).map_err(|error| format!("Could not read plugin configuration: {error}")),
        None => Ok(Configuration { enabled: BUNDLED.iter().map(|id| (*id).into()).collect(), previous: Vec::new() }),
    }
}

pub(crate) async fn validate_configuration(executable: &str, enabled: Vec<String>) -> Result<()> {
    let runtime = Runtime::load(executable, enabled, Arc::new(PluginEvents(Arc::default()))).await?;
    runtime.shutdown().await;
    Ok(())
}

pub(super) struct PluginService {
    executable: String,
    state: RwLock<Option<State>>,
    host: Arc<OnceLock<Weak<super::controller::Host>>>,
}

impl PluginService {
    pub fn new(executable: String) -> Self { Self { executable, state: RwLock::new(None), host: Arc::default() } }

    pub fn bind(&self, host: Weak<super::controller::Host>) { let _ = self.host.set(host); }

    pub async fn initialize(&self) {
        if self.state.read().await.is_some() { return; }
        let mut state = self.state.write().await;
        if state.is_some() { return; }
        let (config, mut error) = match configuration() {
            Ok(config) => (config, None),
            Err(error) => (Configuration { enabled: Vec::new(), previous: Vec::new() }, Some(error)),
        };
        let events: Arc<dyn Events> = Arc::new(PluginEvents(self.host.clone()));
        let runtime = match Runtime::load(&self.executable, config.enabled, events.clone()).await {
            Ok(runtime) => runtime,
            Err(reason) => {
                error = Some(format!("Could not load the plugin setup: {reason}. Restored the previous setup."));
                match Runtime::load(&self.executable, config.previous, events).await {
                    Ok(runtime) => runtime,
                    Err(reason) => {
                        error = Some(format!("Plugins could not start: {reason}. Plugins are disabled; your conversations remain available."));
                        Runtime { enabled: Vec::new(), chatgpt: None }
                    }
                }
            }
        };
        if let Err(reason) = runtime.restore_startup().await { error = Some(reason); }
        *state = Some(State { runtime, revision: Uuid::new_v4().to_string(), error });
    }

    pub async fn handle(&self, packet: Value) -> Result<Value> {
        if packet["type"] == "plugin_idle" { return self.idle().await; }
        if packet["type"] == "prepare_daemon_restart" { return self.prepare_restart(&packet).await; }
        let runtime = {
            let state = self.state.read().await;
            let state = state.as_ref().ok_or("Plugins are unavailable")?;
            if packet["type"] == "plugin_status" { return Ok(state.status()); }
            state.runtime.clone()
        };
        runtime.call(&packet).await
    }

    async fn idle(&self) -> Result<Value> {
        let sdk = self.state.read().await.as_ref().and_then(|state| state.runtime.chatgpt.clone());
        match sdk {
            Some(sdk) => sdk.request(json!({"method":"plugin_idle"})).await,
            None => Ok(json!(true)),
        }
    }

    async fn prepare_restart(&self, packet: &Value) -> Result<Value> {
        let enabled: Vec<String> = serde_json::from_value(packet["enabled"].clone()).map_err(|error| error.to_string())?;
        validate(&enabled)?;
        let state = self.state.write().await;
        let current = state.as_ref().ok_or("Plugins are unavailable")?;
        if packet["revision"].as_str() != Some(&current.revision) { return Err("Plugin setup changed in another client. Reload the plugin setup before restarting.".into()); }
        let tickets = checkpoint(&current.runtime, !enabled.iter().any(|id| id == "chatgpt")).await?;
        Ok(json!({"enabled":enabled,"previous":current.runtime.enabled,"tickets":tickets}))
    }

    pub async fn shutdown(&self) {
        if let Some(state) = self.state.write().await.take() { state.runtime.shutdown().await; }
    }
}

async fn checkpoint(runtime: &Runtime, disabling: bool) -> Result<Value> {
    if !runtime.drain(disabling).await? { return Ok(json!([])); }
    match &runtime.chatgpt {
        Some(sdk) => {
            let snapshot = tokio::time::timeout(Duration::from_secs(5), sdk.request(json!({"method":"plugin_checkpoint"}))).await
                .map_err(|_| "ChatGPT checkpoint timed out".to_owned()).and_then(|result| result);
            match snapshot {
                Err(error) if disabling => { eprintln!("Disabling ChatGPT without an in-memory checkpoint: {error}"); Ok(json!([])) },
                result => result,
            }
        },
        None => Ok(json!([])),
    }
}
