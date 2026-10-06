use super::{protocol::Result, provider_sdk::{Events, Sdk}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::RwLock;
use uuid::Uuid;

mod markdown;

pub(crate) use markdown::with_note_deletion;

const BUNDLED: &[&str] = &["chatgpt", "markdown"];
const CHATGPT_SOURCE: &str = concat!(
    include_str!("../../resources/chatgpt-stream.mjs"), "\n",
    include_str!("../../resources/chatgpt-service.mjs"),
    "\nconst bundledPlugin = { call: handleChatGpt, idle: chatGptIdle, checkpoint: chatGptTicketSnapshot, restore: chatGptRestore };"
);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    enabled: Vec<String>,
    previous: Vec<String>,
}

struct Runtime {
    enabled: Vec<String>,
    chatgpt: Option<Sdk>,
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

struct PluginEvents;
impl Events for PluginEvents {
    fn event(&self, _packet: Value) {}
}

impl Runtime {
    async fn load(executable: &str, enabled: Vec<String>) -> Result<Self> {
        validate(&enabled)?;
        if enabled.iter().any(|id| id == "markdown") { markdown::initialize()?; }
        let chatgpt = if enabled.iter().any(|id| id == "chatgpt") {
            Some(start_chatgpt(executable).await?)
        } else { None };
        Ok(Self { enabled, chatgpt })
    }

    async fn drain(&self) -> Result<()> {
        let Some(sdk) = &self.chatgpt else { return Ok(()); };
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if sdk.request(json!({"method":"plugin_idle"})).await? == true { return Ok(()); }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }).await.map_err(|_| "ChatGPT is still responding. The previous plugins remain active; restart again when it finishes.".to_owned())?
    }

    async fn shutdown(&self) {
        if let Some(sdk) = &self.chatgpt { sdk.shutdown().await; }
    }

    async fn call(&self, packet: &Value) -> Result<Value> {
        let id = packet["pluginId"].as_str().ok_or("Missing plugin ID")?;
        if !self.enabled.iter().any(|enabled| enabled == id) { return Err(format!("The {id} plugin is disabled on this daemon")); }
        match id {
            "markdown" => {
                let request = packet["request"].clone();
                tokio::task::spawn_blocking(move || markdown::dispatch(request)).await.map_err(|error| error.to_string())?
            },
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

async fn start_chatgpt(executable: &str) -> Result<Sdk> {
    let sdk = Sdk::plugin(executable.into(), Arc::new(PluginEvents), CHATGPT_SOURCE);
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
    match std::fs::read(configuration_path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Could not read plugin configuration: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Configuration { enabled: BUNDLED.iter().map(|id| (*id).into()).collect(), previous: Vec::new() }),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) async fn validate_configuration(executable: &str, enabled: Vec<String>) -> Result<()> {
    let runtime = Runtime::load(executable, enabled).await?;
    runtime.shutdown().await;
    Ok(())
}

pub(super) struct PluginService {
    executable: String,
    state: RwLock<Option<State>>,
}

impl PluginService {
    pub fn new(executable: String) -> Self { Self { executable, state: RwLock::new(None) } }

    async fn initialize(&self) {
        if self.state.read().await.is_some() { return; }
        let mut state = self.state.write().await;
        if state.is_some() { return; }
        let (config, mut error) = match configuration() {
            Ok(config) => (config, None),
            Err(error) => (Configuration { enabled: Vec::new(), previous: Vec::new() }, Some(error)),
        };
        let runtime = match Runtime::load(&self.executable, config.enabled).await {
            Ok(runtime) => runtime,
            Err(reason) => {
                error = Some(format!("Could not load the plugin setup: {reason}. Restored the previous setup."));
                match Runtime::load(&self.executable, config.previous).await {
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
        self.initialize().await;
        if packet["type"] == "prepare_daemon_restart" { return self.prepare_restart(&packet).await; }
        let state = self.state.read().await;
        let state = state.as_ref().ok_or("Plugins are unavailable")?;
        if packet["type"] == "plugin_status" { return Ok(state.status()); }
        state.runtime.call(&packet).await
    }

    async fn idle(&self) -> Result<Value> {
        let state = self.state.read().await;
        match state.as_ref().and_then(|state| state.runtime.chatgpt.as_ref()) {
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
        current.runtime.drain().await?;
        let tickets = match &current.runtime.chatgpt {
            Some(sdk) => sdk.request(json!({"method":"plugin_checkpoint"})).await?,
            None => json!([]),
        };
        Ok(json!({"enabled":enabled,"previous":current.runtime.enabled,"tickets":tickets}))
    }

    pub async fn shutdown(&self) {
        if let Some(state) = self.state.write().await.take() { state.runtime.shutdown().await; }
    }
}
