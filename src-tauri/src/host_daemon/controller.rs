use super::{
    ownership::{ownership_error, ConversationOwnership, Guard, Revocation},
    payload::{client_payload, saved_tool_payload, tool_payload_page},
    protocol::{array, expand_home, flag, kind, text, LaunchSpec, Result},
    session::{Session, SessionHost},
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
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
}

pub(super) struct Host {
    pub home: PathBuf,
    state: Mutex<Registry>,
    ownership: OnceLock<Arc<ConversationOwnership>>,
    pub services: Arc<dyn Services>,
    output: Mutex<Box<dyn Write + Send>>,
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
    pub async fn new(home: PathBuf, storage: &str, services: Arc<dyn Services>, output: Box<dyn Write + Send>) -> Result<Arc<Self>> {
        let host = Arc::new_cyclic(|weak| Self {
            home,
            state: Mutex::new(Registry::default()),
            ownership: OnceLock::new(),
            services,
            output: Mutex::new(output),
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
        let packet = client_payload(packet);
        let mut output = self.output.lock().unwrap_or_else(|error| error.into_inner());
        let result = serde_json::to_writer(&mut *output, &packet)
            .map_err(std::io::Error::other)
            .and_then(|_| output.write_all(b"\n"))
            .and_then(|_| output.flush());
        if let Err(error) = result {
            eprintln!("Host daemon output: {error}");
        }
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

    pub fn spawn_session(
        &self,
        key: String,
        spec: LaunchSpec,
        timeout: Duration,
        ephemeral: bool,
        transient: bool,
        client: String,
        cwd: Option<String>,
    ) -> Result<Arc<Session>> {
        let pending = self.registry().pending.remove(&key).unwrap_or_default();
        let session = Session::spawn(
            key.clone(),
            spec,
            timeout,
            ephemeral,
            transient,
            client,
            cwd,
            pending,
            Arc::new(Callbacks(self.weak.clone())),
            &self.home,
        )?;
        self.registry().sessions.insert(key, session.clone());
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

    pub async fn handle(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let runtime = text(&packet, "runtimeId");
        let name = kind(&packet);
        if name == "detach" {
            self.registry().attachments.remove(&runtime);
        }
        match name {
            "voice" | "provider_auth" | "provider_auth_cancel_owner" => return self.services.handle(packet).await,
            "ownership_drained" => {
                if let Some(sender) = self.registry().drains.remove(&text(&packet, "requestId")) {
                    let result = packet["error"]
                        .as_str()
                        .filter(|error| !error.is_empty())
                        .map(|error| Err(error.into()))
                        .unwrap_or(Ok(()));
                    let _ = sender.send(result);
                }
                return Ok(Value::Null);
            }
            "conversation_mutation" => {
                let operation = text(&packet, "operation");
                let guard = self.ownership().begin(&text(&packet,"sessionId"), &text(&packet,"clientId"), &json!({"mutation":operation!="save_diffs","message":operation=="message","archive":operation=="archive","path":packet["sessionPath"],"archived":packet["archived"]})).await?;
                if !guard.owned {
                    return Err(ownership_error());
                }
                let token = Uuid::new_v4().to_string();
                self.registry().guards.insert(token.clone(), (guard, operation));
                return Ok(json!({"token":token}));
            }
            "conversation_mutation_end" => {
                let guard = self.registry().guards.remove(&text(&packet, "token"));
                if let Some((guard, operation)) = guard {
                    guard.release(
                        self.ownership(),
                        flag(&packet, "success") && matches!(operation.as_str(), "delete" | "archive"),
                    )?;
                }
                return Ok(Value::Null);
            }
            "configure" => {
                self.configure(&packet["configuration"])?;
                return Ok(Value::Null);
            }
            "attach" => return self.attach(packet).await,
            "shutdown" => {
                self.shutdown().await;
                return Ok(Value::Null);
            }
            "retire" => {
                let session = {
                    let registry = self.registry();
                    registry.sessions.get(&text(&packet, "sessionKey")).cloned().or_else(|| {
                        registry
                            .sessions
                            .values()
                            .find(|session| {
                                session.saved_state()["sessionFile"] == packet["sessionPath"]
                                    || session.reserved_path().as_deref() == packet["sessionPath"].as_str()
                            })
                            .cloned()
                    })
                };
                if let Some(session) = session {
                    session.retire().await?;
                }
                return Ok(Value::Null);
            }
            "session_command" => {
                let session = self
                    .registry()
                    .sessions
                    .get(&text(&packet, "sessionKey"))
                    .cloned()
                    .ok_or("Conversation is no longer running")?;
                return session.execute(packet["command"].clone()).await;
            }
            _ => {}
        }
        if name == "command" && packet["command"]["type"] == "take_ownership" {
            let mut target = self
                .registry()
                .attachments
                .get(&runtime)
                .map(|value| (**value).clone())
                .ok_or("This conversation has been deleted or closed")?;
            if flag(&target["presence"], "readOnly") {
                return Err("This view is read-only".into());
            }
            target["takeOwnership"] = json!(true);
            return self.attach(target).await;
        }
        let readonly = self.registry().readonly.get(&runtime).cloned();
        if let Some(target) = readonly {
            return self.readonly_command(&packet, target).await;
        }
        let session = self.registry().subscriptions.get(&runtime).cloned();
        let Some(session) = session else {
            if name == "detach" {
                return Ok(json!({"stopped":false}));
            }
            return Err("Pi is not running".into());
        };
        if name == "detach" {
            self.services.detach_voice(&runtime).await;
            self.registry().subscriptions.remove(&runtime);
            let result = session
                .detach(&runtime, flag(&packet, "discardBlank"), flag(&packet, "preserveRunning"))
                .await;
            self.release_unused(&session).await?;
            return Ok(result);
        }
        if name == "presence" {
            session.presence(&runtime, packet["presence"].clone());
            return Ok(Value::Null);
        }
        self.session_command(session, &runtime, packet["command"].clone()).await
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

    async fn attach(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let runtime = text(&packet, "runtimeId");
        let packet = Arc::new(packet);
        self.registry().attachments.insert(runtime.clone(), packet.clone());
        let mut spec: LaunchSpec = serde_json::from_value(packet["spec"].clone()).map_err(|error| error.to_string())?;
        let identity = spec.identity(&text(&packet, "sessionKey"))?;
        let path = spec.argument("--session").map(str::to_owned);
        self.assert_attachment(&runtime, &packet)?;
        if flag(&packet["presence"], "readOnly") {
            if path.is_none() || self.ownership().locate(&identity, path.as_deref(), false, true)?.is_none() {
                return Err("This conversation has been deleted or archived".into());
            }
            self.assert_attachment(&runtime, &packet)?;
            self.registry().readonly.insert(runtime, ReadonlyView { id: identity, path });
            return Ok(json!({"attached":true,"owned":false}));
        }
        let guard = if flag(&packet, "ephemeral") {
            Guard::ephemeral()
        } else {
            self.ownership()
                .begin(
                    &identity,
                    &text(&packet, "clientId"),
                    &json!({"take":packet["takeOwnership"],"path":path,"create":path.is_none()}),
                )
                .await?
        };
        let owned = guard.owned;
        let mut opened = None;
        let result = async {
            self.assert_attachment(&runtime, &packet)?;
            if !owned {
                self.registry().readonly.insert(
                    runtime.clone(),
                    ReadonlyView {
                        id: identity.clone(),
                        path: path.clone(),
                    },
                );
                return Ok(json!({"attached":true,"owned":false}));
            }
            let cwd = guard
                .saved
                .as_ref()
                .and_then(|saved| saved.header["cwd"].as_str())
                .or_else(|| packet["cwd"].as_str())
                .map(|cwd| expand_home(cwd, &self.home).to_string_lossy().into_owned());
            if spec.env.contains_key("PIOP_REMOTE_SESSION_CLAIMS") {
                spec.env.insert("PIOP_SESSION_CWD".into(), cwd.clone().unwrap_or("~".into()));
            } else if cwd.is_some() {
                spec.cwd = cwd.clone();
            }
            let mut session = self.find_session(&identity);
            if session.as_ref().is_some_and(|session| session.transient()) {
                return Err("This conversation branch is still being prepared".into());
            }
            if let Some(stopping) = session.as_ref().filter(|session| session.stopping()) {
                stopping.stop().await;
                session = self.find_session(&identity);
            }
            let session = match session {
                Some(session) => session,
                None => self.spawn_session(
                    identity.clone(),
                    spec,
                    Duration::from_millis(packet["timeout"].as_u64().unwrap_or(630000)),
                    flag(&packet, "ephemeral"),
                    false,
                    text(&packet, "clientId"),
                    cwd,
                )?,
            };
            opened = Some(session.clone());
            session.execute(json!({"type":"get_state"})).await?;
            self.assert_attachment(&runtime, &packet)?;
            self.registry().readonly.remove(&runtime);
            self.attach_view(&runtime, session.clone(), packet["presence"].clone());
            self.remember(&runtime, &session);
            self.reconcile(session.clone());
            Ok(json!({"attached":session.views().len()>1||session.submitted(),"owned":true}))
        }
        .await;
        let released = guard.release(self.ownership(), false);
        // Successful attachment replaces the launch packet with the normalized session spec.
        let still_attached = {
            let registry = self.registry();
            registry
                .subscriptions
                .get(&runtime)
                .is_some_and(|session| opened.as_ref().is_some_and(|opened| Arc::ptr_eq(session, opened)))
                || registry
                    .attachments
                    .get(&runtime)
                    .is_some_and(|current| Arc::ptr_eq(current, &packet))
        };
        if !still_attached {
            if let Some(session) = opened {
                if session.views().is_empty() {
                    if !session.submitted() && !session.working() {
                        session.stop().await;
                    } else {
                        self.release_unused(&session).await?;
                    }
                }
            } else if owned {
                self.ownership()
                    .release_client(&identity, &text(&packet, "clientId"), || {
                        !self
                            .registry()
                            .attachments
                            .values()
                            .any(|value| value["clientId"] == packet["clientId"] && value["sessionKey"] == packet["sessionKey"])
                    })
                    .await?;
            }
        }
        released?;
        result
    }

    fn assert_attachment(&self, runtime: &str, packet: &Arc<Value>) -> Result<()> {
        if self
            .registry()
            .attachments
            .get(runtime)
            .is_some_and(|current| Arc::ptr_eq(current, packet))
        {
            Ok(())
        } else {
            Err("The conversation was closed while attaching".into())
        }
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
