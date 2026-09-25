mod attachment;
mod requests;

use super::{
    ownership::{ownership_error, ConversationOwnership, Guard, Revocation},
    payload::{client_payload, saved_tool_payload, tool_payload_page},
    protocol::{array, expand_home, flag, kind, text, LaunchSpec, Result, SessionLaunch},
    session::{Session, SessionHost},
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

pub(super) trait Services: Send + Sync {
    fn bind(&self, host: Weak<Host>);
    fn handle(&self, packet: Value) -> BoxFuture<'_, Result<Value>>;
    fn refresh_providers(&self) -> BoxFuture<'_, Result<u64>>;
    fn detach_voice<'a>(&'a self, runtime: &'a str) -> BoxFuture<'a, ()>;
    fn release_voice<'a>(&'a self, identity: &'a str) -> BoxFuture<'a, ()>;
    fn agent_event(&self, identity: &str, event: &Value);
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

#[derive(Clone)]
pub(super) struct ReadonlyView {
    pub id: String,
    pub path: Option<String>,
}

#[derive(Default)]
pub(super) struct Registry {
    pub sessions: HashMap<String, Arc<Session>>,
    pub subscriptions: HashMap<String, Arc<Session>>,
    pub attachments: HashMap<String, Arc<Value>>,
    pub readonly: HashMap<String, ReadonlyView>,
    pending: HashMap<String, Vec<Value>>,
    configuration: Option<Value>,
    drains: HashMap<String, oneshot::Sender<Result<()>>>,
    guards: HashMap<String, (Guard, String)>,
    captures: HashMap<String, HashSet<String>>,
    maintenance: HashSet<String>,
    release_gates: HashMap<String, Arc<AsyncMutex<()>>>,
    dialog_gates: HashMap<String, Arc<AsyncMutex<()>>>,
    session_gates: HashMap<String, Arc<AsyncMutex<()>>>,
}

pub(super) struct Host {
    pub home: PathBuf,
    state: Mutex<Registry>,
    ownership: OnceLock<Arc<ConversationOwnership>>,
    pub services: Arc<dyn Services>,
    output: std::sync::mpsc::Sender<Value>,
    weak: Weak<Self>,
}

struct Callbacks(Weak<Host>);

impl SessionHost for Callbacks {
    fn output(&self, packet: Value) {
        if let Some(host) = self.0.upgrade() {
            host.output(packet);
        }
    }
    fn configuration(&self) -> Option<Value> {
        self.0.upgrade().and_then(|host| host.registry().configuration.clone())
    }
    fn readonly_views(&self, identity: &str) -> Vec<String> {
        self.0
            .upgrade()
            .map(|host| {
                host.registry()
                    .readonly
                    .iter()
                    .filter(|(_, view)| view.id == identity)
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn readonly(&self, runtime: &str) -> bool {
        self.0.upgrade().is_some_and(|host| host.registry().readonly.contains_key(runtime))
    }
    fn rekey(&self, old: &str, new: &str, epoch: &str) {
        if let Some(host) = self.0.upgrade() {
            let mut registry = host.registry();
            if registry.sessions.get(old).is_some_and(|session| session.epoch() == epoch) {
                if let Some(session) = registry.sessions.remove(old) {
                    registry.sessions.insert(new.into(), session);
                }
            }
        }
    }
    fn finished(&self, key: &str, epoch: &str, pending: Vec<Value>, transient: bool) {
        if let Some(host) = self.0.upgrade() {
            let mut registry = host.registry();
            if !transient && registry.sessions.get(key).is_some_and(|session| session.epoch() == epoch) {
                registry.sessions.remove(key);
            }
            if !pending.is_empty() {
                registry.pending.insert(key.into(), pending);
            }
            registry.subscriptions.retain(|_, session| session.epoch() != epoch);
        }
    }
    fn maintenance(&self, key: &str) {
        if let Some(host) = self.0.upgrade() {
            host.maintain(key);
        }
    }
    fn agent_event(&self, identity: &str, event: &Value) {
        if let Some(host) = self.0.upgrade() {
            host.services.agent_event(identity, event);
        }
    }
    fn refresh_providers(&self) -> BoxFuture<'_, Result<u64>> {
        Box::pin(async move {
            self.0
                .upgrade()
                .ok_or("Host daemon disconnected")?
                .services
                .refresh_providers()
                .await
        })
    }
}

impl Revocation for Callbacks {
    fn revoke<'a>(&'a self, id: &'a str, intent: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.0
                .upgrade()
                .ok_or("Host daemon disconnected")?
                .release_conversation(id, intent)
                .await
        })
    }
}

impl Host {
    pub async fn new(
        home: PathBuf,
        storage: &str,
        services: Arc<dyn Services>,
        output: std::sync::mpsc::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let host = Arc::new_cyclic(|weak| Self {
            home,
            state: Mutex::new(Registry::default()),
            ownership: OnceLock::new(),
            services,
            output,
            weak: weak.clone(),
        });
        let ownership = ConversationOwnership::new(&host.home, storage, Arc::new(Callbacks(Arc::downgrade(&host)))).await?;
        let _ = host.ownership.set(ownership);
        host.services.bind(Arc::downgrade(&host));
        Ok(host)
    }

    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    pub fn ownership(&self) -> &ConversationOwnership {
        self.ownership.get().expect("Ownership initialized before host dispatch")
    }
    pub fn output(&self, packet: Value) {
        let _ = self.output.send(client_payload(packet));
    }

    pub fn find_session(&self, identity: &str) -> Option<Arc<Session>> {
        self.registry()
            .sessions
            .values()
            .find(|session| session.identity == identity && !session.closed())
            .cloned()
    }

    pub fn current(&self, runtime: &str, session: &Session) -> bool {
        self.registry()
            .subscriptions
            .get(runtime)
            .is_some_and(|current| current.epoch() == session.epoch())
    }

    pub fn spawn_session(&self, launch: SessionLaunch) -> Result<Arc<Session>> {
        let key = launch.key.clone();
        let pending = self.registry().pending.remove(&key).unwrap_or_default();
        let session = match Session::spawn(launch, pending.clone(), Arc::new(Callbacks(self.weak.clone())), &self.home) {
            Ok(session) => session,
            Err(error) => {
                if !pending.is_empty() {
                    self.registry().pending.insert(key, pending);
                }
                return Err(error);
            }
        };
        self.registry().sessions.insert(key, session.clone());
        if session.closed() {
            self.forget_worker(&session);
        }
        Ok(session)
    }

    pub fn remember(&self, runtime: &str, session: &Session) {
        let saved = session.saved_state();
        let spec = if session.ephemeral {
            session.spec.clone()
        } else {
            session
                .spec
                .session("--session-id", saved["sessionId"].as_str().unwrap_or(&session.identity))
        };
        let mut registry = self.registry();
        let mut packet = registry
            .attachments
            .get(runtime)
            .map(|value| (**value).clone())
            .unwrap_or(json!({}));
        packet["spec"] = json!(spec);
        packet["sessionKey"] = json!(session.identity);
        packet["cwd"] = json!(session.cwd);
        registry.attachments.insert(runtime.into(), Arc::new(packet));
    }

    pub fn attach_view(&self, runtime: &str, session: Arc<Session>, presence: Value) {
        self.registry().subscriptions.insert(runtime.into(), session.clone());
        session.attach(runtime, presence);
    }

    pub fn forget_worker(&self, session: &Session) {
        let key = session.key();
        let mut registry = self.registry();
        if registry
            .sessions
            .get(&key)
            .is_some_and(|current| current.epoch() == session.epoch())
        {
            registry.sessions.remove(&key);
        }
    }

    fn maintain(self: &Arc<Self>, key: &str) {
        let session = {
            let mut registry = self.registry();
            let Some(session) = registry.sessions.get(key).cloned() else {
                return;
            };
            if !registry.maintenance.insert(session.epoch().into()) {
                return;
            }
            session
        };
        let host = self.clone();
        tokio::spawn(async move {
            session.reconcile(false).await;
            if let Err(error) = host.release_unused(&session).await {
                host.output(
                    json!({"type":"diagnostic","line":format!("Could not release unused ownership for {}: {error}",session.key())}),
                );
            }
            host.registry().maintenance.remove(session.epoch());
        });
    }

    pub async fn release_unused(&self, session: &Session) -> Result<()> {
        if !session.ephemeral && session.unused() {
            self.ownership()
                .release_client(&session.identity, &session.client_id, || session.unused())
                .await?;
        }
        Ok(())
    }

    pub fn reconcile(self: &Arc<Self>, session: Arc<Session>) {
        let host = self.clone();
        tokio::spawn(async move {
            session.reconcile(true).await;
            let _ = host.release_unused(&session).await;
        });
    }

    async fn release_conversation(&self, id: &str, intent: &str) -> Result<()> {
        let gate = self
            .registry()
            .release_gates
            .entry(id.into())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _release = gate.lock().await;
        let sessions: Vec<_> = self
            .registry()
            .sessions
            .values()
            .filter(|session| session.identity == id)
            .cloned()
            .collect();
        for session in sessions {
            if matches!(intent, "message" | "archive") {
                session.retire().await?;
            }
            self.services.release_voice(&session.identity).await;
            let saved = session.saved_state();
            for (runtime, _) in session.views() {
                self.registry().readonly.insert(
                    runtime,
                    ReadonlyView {
                        id: id.into(),
                        path: saved["sessionFile"].as_str().map(str::to_owned),
                    },
                );
            }
            session.publish(json!({"type":"ownership_lost"}), None);
            if session.working() || session.compacting() {
                let _ = session.raw(json!({"type":"abort"})).await;
            }
            session.stop().await;
            self.registry().captures.entry(id.into()).or_default().insert(session.key());
        }
        self.drain_captures(id).await
    }

    async fn drain_captures(&self, id: &str) -> Result<()> {
        let keys = self.registry().captures.get(id).cloned().unwrap_or_default();
        for key in keys {
            let request = Uuid::new_v4().to_string();
            let (sender, receiver) = oneshot::channel();
            self.registry().drains.insert(request.clone(), sender);
            self.output(json!({"type":"ownership_drain","id":request,"sessionKey":key}));
            receiver
                .await
                .map_err(|_| "Host daemon disconnected while saving project changes")??;
            if let Some(keys) = self.registry().captures.get_mut(id) {
                keys.remove(&key);
            }
        }
        self.registry().captures.remove(id);
        Ok(())
    }

    fn configure(self: &Arc<Self>, configuration: &Value) -> Result<()> {
        if configuration["agentRevision"]
            .as_u64()
            .is_none_or(|revision| revision > 9_007_199_254_740_991)
            || !configuration["settings"].is_object()
            || !configuration["autoCompaction"].is_boolean()
            || !configuration["autoRetry"].is_boolean()
        {
            return Err("Invalid daemon configuration".into());
        }
        let sessions = {
            let mut registry = self.registry();
            registry.configuration = Some(configuration.clone());
            registry.sessions.values().cloned().collect::<Vec<_>>()
        };
        for session in sessions {
            session.publish(json!({"type":"settings_pending","pending":session.settings_pending()}), None);
            self.reconcile(session);
        }
        Ok(())
    }

    async fn readonly_command(&self, packet: &Value, target: ReadonlyView) -> Result<Value> {
        let runtime = text(packet, "runtimeId");
        if kind(packet) == "detach" {
            let mut registry = self.registry();
            registry.readonly.remove(&runtime);
            registry.attachments.remove(&runtime);
            return Ok(json!({"stopped":false}));
        }
        if kind(packet) == "presence" {
            return Ok(Value::Null);
        }
        let command = &packet["command"];
        if !matches!(
            kind(command),
            "get_snapshot" | "get_entries" | "get_state" | "get_session_revision" | "get_tool_payload"
        ) {
            return Err(ownership_error());
        }
        if let Some(session) = self.find_session(&target.id).filter(|session| !session.transient()) {
            return session.execute(command.clone()).await;
        }
        self.read_saved_conversation(&target, command)
    }

    fn read_saved_conversation(&self, target: &ReadonlyView, command: &Value) -> Result<Value> {
        if kind(command) == "get_session_revision" {
            return self.ownership().revision(&target.id, target.path.as_deref());
        }
        let snapshot = self.ownership().snapshot(&target.id, target.path.as_deref())?;
        match kind(command) {
            "get_snapshot" => Ok(snapshot),
            "get_entries" => Ok(snapshot["history"].clone()),
            "get_state" => Ok(snapshot["state"].clone()),
            _ => tool_payload_page(
                saved_tool_payload(&array(&snapshot["history"], "entries"), &text(command, "toolCallId")),
                command,
            ),
        }
    }

    async fn session_command(self: &Arc<Self>, session: Arc<Session>, runtime: &str, command: Value) -> Result<Value> {
        if kind(&command) == "extension_ui_response" {
            return self.answer_dialog(&session, runtime, command).await;
        }
        if !kind(&command).starts_with("get_") || kind(&command) == "get_snapshot" {
            session.reconcile(false).await;
        }
        if !kind(&command).starts_with("get_") {
            if let Some(error) = session.configuration_error() {
                return Err(error);
            }
        }
        if matches!(kind(&command), "fork" | "fork_after" | "clone" | "new_session" | "switch_session") {
            return super::branching::switch(self, &session, runtime, command).await;
        }
        queue_command(&session, command).await
    }

    async fn answer_dialog(&self, session: &Session, runtime: &str, command: Value) -> Result<Value> {
        let id = text(&command, "id");
        let key = format!("{}:{id}", session.epoch());
        let gate = self
            .registry()
            .dialog_gates
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _answer = gate.lock().await;
        let dialog = session
            .dialog(&id)
            .filter(|dialog| dialog.owner.as_deref() == Some(runtime))
            .ok_or("This question is no longer owned by this view. Reopen the conversation to refresh it.")?;
        if !dialog.event["asyncQuestion"].is_string() {
            session.resolve_dialog(&id);
            session.send(&command).await?;
            return Ok(Value::Null);
        }
        let response=dialog.queued_response.unwrap_or_else(||json!({"type":"answer_question","requestId":dialog.event["asyncQuestion"],"value":command["value"],"cancelled":flag(&command,"cancelled")}));
        session.change_dialog(&id, |dialog| dialog.answering = true);
        let result = async {
            let mut prepare = response.clone();
            prepare["action"] = json!("prepare");
            let prepared = session.raw(prepare).await?;
            if prepared["message"].as_str().is_some_and(|message| !message.is_empty()) && !dialog.answer_queued {
                session
                    .queue
                    .command(json!({"type":if session.working(){"steer"}else{"follow_up"},"message":prepared["message"]}))
                    .await?;
                session.change_dialog(&id, |dialog| {
                    dialog.answer_queued = true;
                    dialog.queued_response = Some(response.clone());
                });
            }
            let mut resolve = response;
            resolve["action"] = json!("resolve");
            session.raw(resolve).await?;
            Ok(Value::Null)
        }
        .await;
        session.change_dialog(&id, |dialog| dialog.answering = false);
        result
    }

    pub async fn shutdown(&self) {
        self.services.shutdown().await;
        let sessions: Vec<_> = self.registry().sessions.values().cloned().collect();
        futures_util::future::join_all(sessions.iter().map(|session| session.stop())).await;
        self.ownership().shutdown();
        self.registry().guards.clear();
        self.registry().drains.clear();
    }
}

pub(super) async fn queue_command(session: &Session, mut command: Value) -> Result<Value> {
    if kind(&command) == "change_pending" {
        return session.queue.change_pending(&text(&command, "id"), command["action"].clone()).await;
    }
    if kind(&command) == "prompt" && !text(&command, "message").starts_with('/') && !session.queue.held() {
        command["type"] = json!(if command["streamingBehavior"] == "steer" {
            "steer"
        } else {
            "follow_up"
        });
    }
    session.queue.command(command).await
}
