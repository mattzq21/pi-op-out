mod attachment;
mod requests;
mod recovery;
mod retention;

use super::{
    ownership::{ownership_error, ConversationOwnership, Guard, Revocation},
    payload::{client_payload, saved_tool_payload},
    tool_payload::{ToolPayload, ToolPayloadCache},
    protocol::{expand_home, flag, kind, text, LaunchSpec, Result, SessionLaunch},
    session::{Session, SessionHost},
    services::HostServices,
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
    agent_definitions: Value,
    agent_revision: u64,
    requested_agent_revision: u64,
    drains: HashMap<String, oneshot::Sender<Result<()>>>,
    guards: HashMap<String, (Guard, String)>,
    captures: HashMap<String, HashSet<String>>,
    maintenance: HashSet<String>,
    release_gates: HashMap<String, Arc<AsyncMutex<()>>>,
    dialog_gates: HashMap<String, Arc<AsyncMutex<()>>>,
    session_gates: HashMap<String, Arc<AsyncMutex<()>>>,
    deliveries: HashMap<String, HashSet<String>>,
    cancelled_deliveries: HashSet<String>,
}

pub(super) struct Host {
    pub home: PathBuf,
    storage: String,
    configuration_gate: AsyncMutex<()>,
    state: Mutex<Registry>,
    ownership: OnceLock<Arc<ConversationOwnership>>,
    pub services: Arc<HostServices>,
    output: std::sync::mpsc::Sender<Value>,
    weak: Weak<Self>,
    tool_payloads: Arc<ToolPayloadCache>,
    tool_failures: super::tool_failures::Writer,
}

struct Callbacks(Weak<Host>);

impl SessionHost for Callbacks {
    fn queue_root(&self) -> Option<PathBuf> { self.0.upgrade().map(|host| host.home.join(&host.storage).join("queued-input")) }
    fn drain_capture<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.0.upgrade().ok_or("Host daemon disconnected")?.drain_capture(key).await
        })
    }
    fn record_tool_failure(&self, record: Value) {
        if let Some(host) = self.0.upgrade() {
            if let Err(error) = host.tool_failures.record(record) {
                host.output(json!({"type":"diagnostic","line":format!("Could not record tool failure: {error}")}));
            }
        }
    }
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
    pub fn storage_root(&self) -> PathBuf { self.home.join(&self.storage) }

    pub async fn new(
        home: PathBuf,
        storage: &str,
        services: Arc<HostServices>,
        output: std::sync::mpsc::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let settings = crate::settings::read_settings_at(&home.join(storage).join("settings.json"))?;
        let definitions = super::agents::load(&home, storage, &crate::extensions::runtime_settings(&settings), true).await?;
        let tool_failures = super::tool_failures::Writer::start(home.join(storage).join("tool-failures.sqlite"), output.clone())?;
        let host = Arc::new_cyclic(|weak| Self {
            home,
            storage: storage.into(),
            configuration_gate: AsyncMutex::new(()),
            state: Mutex::new(Registry { agent_definitions: definitions, ..Registry::default() }),
            ownership: OnceLock::new(),
            services,
            output,
            weak: weak.clone(),
            tool_payloads: Arc::new(ToolPayloadCache::default()),
            tool_failures,
        });
        let ownership = ConversationOwnership::new(&host.home, storage, Arc::new(Callbacks(Arc::downgrade(&host)))).await?;
        let _ = host.ownership.set(ownership);
        host.recover_queued_input();
        host.services.bind(Arc::downgrade(&host));
        host.services.initialize().await;
        host.watch_removals();
        host.watch_retention();
        Ok(host)
    }

    fn watch_removals(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let mut stopped = self.ownership().shutdown_signal();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    _ = interval.tick() => {
                        let Some(host) = weak.upgrade() else { break; };
                        let targets: HashMap<_, _> = host.registry().readonly.values()
                            .map(|view| (view.id.clone(), view.path.clone())).collect();
                        for (id, path) in targets {
                            if host.ownership().removed(&id).unwrap_or(false) {
                                host.output(json!({"type":"session_removed","sessionId":id,"sessionPath":path}));
                            }
                        }
                    }
                }
            }
        });
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
        let session = match Session::spawn(launch, pending.clone(), Arc::new(Callbacks(self.weak.clone())), &self.home, self.tool_payloads.clone()) {
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
        packet["ephemeral"] = json!(session.ephemeral);
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
                .release_client(&session.identity, &session.client_id(), || session.unused())
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
        for session in sessions { self.release_owned_session(id, intent, session).await?; }
        if intent == "transfer-local" { return Ok(()); }
        self.drain_captures(id).await
    }

    async fn release_owned_session(&self, id: &str, intent: &str, session: Arc<Session>) -> Result<()> {
        if transfer_blocked(intent, &session) {
            return Err("The agent is running on another daemon. Wait for it to finish before transferring ownership.".into());
        }
        if intent == "message" {
            session.retire().await?;
        }
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
        if intent == "transfer-local" { return Ok(()); }
        if released_session_needs_abort(intent, &session) {
            let _ = session.raw(json!({"type":"abort"})).await;
        }
        session.stop().await;
        if intent == "archive" {
            self.registry().pending.remove(&session.key());
        }
        self.registry().captures.entry(id.into()).or_default().insert(session.key());
        Ok(())
    }

    pub(super) async fn drain_capture(&self, key: &str) -> Result<()> {
        let request = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.registry().drains.insert(request.clone(), sender);
        self.output(json!({"type":"ownership_drain","id":request,"sessionKey":key}));
        let result = match tokio::time::timeout(Duration::from_secs(120), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Host daemon disconnected while saving project changes".into()),
            Err(_) => Err("Project capture drain timed out; source retained".into()),
        };
        self.registry().drains.remove(&request);
        result
    }

    async fn drain_captures(&self, id: &str) -> Result<()> {
        let keys = self.registry().captures.get(id).cloned().unwrap_or_default();
        for key in keys {
            self.flush_capture(&key).await?;
            if let Some(keys) = self.registry().captures.get_mut(id) {
                keys.remove(&key);
            }
        }
        self.registry().captures.remove(id);
        Ok(())
    }

    pub async fn flush_capture(&self, key: &str) -> Result<()> {
        let request = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.registry().drains.insert(request.clone(), sender);
        self.output(json!({"type":"ownership_drain","id":request,"sessionKey":key}));
        receiver.await.map_err(|_| "Host daemon disconnected while saving project changes")?
    }

    async fn configure(self: &Arc<Self>, configuration: &Value) -> Result<()> {
        if configuration["agentRevision"]
            .as_u64()
            .is_none_or(|revision| revision > 9_007_199_254_740_991)
            || !configuration["settings"].is_object()
            || !configuration["autoCompaction"].is_boolean()
            || !configuration["autoRetry"].is_boolean()
        {
            return Err("Invalid daemon configuration".into());
        }
        let _gate = self.configuration_gate.lock().await;
        let requested = configuration["agentRevision"].as_u64().unwrap_or(0);
        let changed = requested != self.registry().requested_agent_revision;
        let definitions = if changed { Some(super::agents::load(&self.home, &self.storage, &configuration["settings"], false).await?) } else { None };
        let sessions = {
            let mut registry = self.registry();
            if let Some(definitions) = definitions {
                registry.agent_definitions = definitions;
                registry.agent_revision += 1;
            }
            registry.requested_agent_revision = requested;
            let mut configuration = configuration.clone();
            configuration["agentRevision"] = json!(registry.agent_revision);
            registry.configuration = Some(configuration);
            registry.sessions.values().cloned().collect::<Vec<_>>()
        };
        for session in sessions {
            session.publish(json!({"type":"settings_pending","pending":session.settings_pending()}), None);
            self.reconcile(session);
        }
        Ok(())
    }

    async fn reload_agents(self: &Arc<Self>, runtime: &str, session_id: &str) -> Result<Value> {
        let _gate = self.configuration_gate.lock().await;
        let target = self.agent_reload_target(runtime, session_id)?;
        let settings = self.registry().configuration.as_ref().map(|value| value["settings"].clone()).ok_or("Daemon is not configured")?;
        let definitions = super::agents::load(&self.home, &self.storage, &settings, false).await?;
        if !Arc::ptr_eq(&target, &self.agent_reload_target(runtime, session_id)?) {
            return Err("The session changed while loading agent definitions. Reload from its current host.".into());
        }
        let (revision, sessions) = {
            let mut registry = self.registry();
            registry.agent_revision += 1;
            let revision = registry.agent_revision;
            registry.agent_definitions = definitions;
            if let Some(configuration) = registry.configuration.as_mut() {
                configuration["agentRevision"] = json!(revision);
            }
            (revision, registry.sessions.values().cloned().collect::<Vec<_>>())
        };
        for session in sessions {
            session.publish(json!({"type":"settings_pending","pending":true}), None);
            self.reconcile(session);
        }
        Ok(json!({"success":true,"sessionId":session_id,"agentRevision":revision}))
    }

    fn agent_reload_target(&self, runtime: &str, session_id: &str) -> Result<Arc<Session>> {
        let registry = self.registry();
        if registry.readonly.contains_key(runtime) { return Err(ownership_error()); }
        registry.subscriptions.get(runtime)
            .filter(|session| session.identity == session_id && !session.closed())
            .cloned().ok_or_else(|| "The session changed. Reload agent definitions from its current host.".into())
    }

    async fn detach_readonly(&self, runtime: &str) -> Result<Value> {
            let session = {
                let mut registry = self.registry();
                registry.readonly.remove(runtime);
                registry.attachments.remove(runtime);
                registry.subscriptions.remove(runtime)
            };
            if let Some(session) = session {
                session.detach_view(runtime);
                session.finish_detach(false, true).await;
                self.release_unused(&session).await?;
            }
            Ok(json!({"stopped":false}))
    }

    async fn readonly_command(&self, packet: &Value, target: ReadonlyView) -> Result<Value> {
        let runtime = text(packet, "runtimeId");
        if kind(packet) == "detach" { return self.detach_readonly(&runtime).await; }
        if kind(packet) == "presence" {
            if let Some(session) = self.find_session(&target.id) { session.presence(&runtime, packet["presence"].clone()); }
            return Ok(Value::Null);
        }
        let command = &packet["command"];
        if !matches!(
            kind(command),
            "get_snapshot" | "get_entries" | "get_state" | "get_session_revision" | "get_tool_payload" | "get_session_stats"
        ) {
            return Err(ownership_error());
        }
        if let Some(session) = self.find_session(&target.id).filter(|session| !session.transient()) {
            return session.execute(command.clone()).await;
        }
        if self.ownership().lookup_saved(&target.id, true)?.is_none() {
            if self.ownership().removed(&target.id)? {
                self.output(json!({"type":"session_removed","sessionId":target.id,"sessionPath":target.path}));
                return Err("This conversation has been deleted or archived".into());
            }
            return Err("Conversation storage is temporarily unavailable; try again".into());
        }
        self.read_saved_conversation(&target, command)
    }

    fn read_saved_conversation(&self, target: &ReadonlyView, command: &Value) -> Result<Value> {
        if kind(command) == "get_session_revision" {
            return self.ownership().revision(&target.id, target.path.as_deref());
        }
        if kind(command) == "get_tool_payload" {
            return self.read_saved_tool_payload(target, command);
        }
        let mut snapshot = self.ownership().snapshot(&target.id, target.path.as_deref())?;
        match kind(command) {
            "get_snapshot" => Ok(snapshot),
            "get_entries" => Ok(snapshot.get_mut("history").map(Value::take).unwrap_or(Value::Null)),
            "get_state" => Ok(snapshot.get_mut("state").map(Value::take).unwrap_or(Value::Null)),
            "get_session_stats" => Ok(json!({"contextUsage":snapshot["state"]["contextUsage"]})),
            _ => Err("Unsupported saved conversation command".into()),
        }
    }

    fn read_saved_tool_payload(&self, target: &ReadonlyView, command: &Value) -> Result<Value> {
        let scope = format!("saved:{}", target.id);
        let id = text(command, "toolCallId");
        let revision = self.ownership().revision(&target.id, target.path.as_deref())?;
        if let Some(payload) = self.tool_payloads.get(&scope, &text(&revision, "revision"), &id) {
            return payload.page(command);
        }
        let snapshot = self.ownership().snapshot(&target.id, target.path.as_deref())?;
        let entries = snapshot["history"]["entries"].as_array().map(Vec::as_slice).unwrap_or_default();
        let payload = Arc::new(ToolPayload::new(saved_tool_payload(entries, &id))?);
        let page = payload.page(command)?;
        self.tool_payloads.insert(&scope, &text(&snapshot, "revision"), &id, payload);
        Ok(page)
    }

    async fn session_command(self: &Arc<Self>, session: Arc<Session>, runtime: &str, command: Value) -> Result<Value> {
        if kind(&command) == "abort" { return queue_command(&session, command).await; }
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
        if matches!(kind(&command), "fork" | "fork_after" | "branch_checkpoint" | "clone" | "new_session" | "switch_session") {
            return super::branching::switch(self, &session, runtime, command).await;
        }
        if command["clientHtmlPreviewSize"].is_number() {
            session.raw(json!({"type":"html_preview_viewport","size":command["clientHtmlPreviewSize"]})).await?;
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
        let response=dialog.queued_response.or_else(||session.queue.question_response(&text(&dialog.event,"asyncQuestion"))).unwrap_or_else(||json!({"type":"answer_question","requestId":dialog.event["asyncQuestion"],"value":command["value"],"cancelled":flag(&command,"cancelled")}));
        session.change_dialog(&id, |dialog| dialog.answering = true);
        let result = async {
            let mut prepare = response.clone();
            prepare["action"] = json!("prepare");
            let prepared = session.raw(prepare).await?;
            if prepared["message"].as_str().is_some_and(|message| !message.is_empty()) && !dialog.answer_queued {
                session
                    .queue
                    .command(json!({"type":if session.working(){"steer"}else{"follow_up"},"message":prepared["message"],"questionResponse":response}))
                    .await?;
                session.change_dialog(&id, |dialog| {
                    dialog.answer_queued = true;
                    dialog.queued_response = Some(response.clone());
                });
            }
            let mut resolve = response;
            resolve["action"] = json!("resolve");
            resolve["queueId"] = prepared["queueId"].clone();
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
        if let Err(error) = self.tool_failures.shutdown().await {
            self.output(json!({"type":"diagnostic","line":error}));
        }
        self.ownership().shutdown();
        self.registry().guards.clear();
        self.registry().drains.clear();
    }
}

pub(super) async fn queue_command(session: &Session, mut command: Value) -> Result<Value> {
    if kind(&command) == "change_pending" {
        return session.queue.change_pending(&text(&command, "id"), command["action"].clone()).await;
    }
    let message = text(&command, "message");
    let review = matches!(message.split_whitespace().next(), Some("/review" | "/rs"));
    if kind(&command) == "prompt" && (!message.starts_with('/') || review) && !session.queue.held() {
        command["type"] = json!(if !review && command["streamingBehavior"] == "steer" {
            "steer"
        } else {
            "follow_up"
        });
    }
    session.queue.command(command).await
}

fn transfer_blocked(intent: &str, session: &Session) -> bool { intent == "transfer" && (session.working() || session.compacting()) }

fn released_session_needs_abort(intent: &str, session: &Session) -> bool { intent != "archive" && (session.working() || session.compacting()) }
