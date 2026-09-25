mod configuration;
mod events;

use super::{
    payload::{assistant_delta, saved_tool_payload, tool_payload_page},
    protocol::{array, flag, kind, text, LaunchSpec, Result, SessionLaunch},
    queue::{Execution, SessionQueue},
    worker::{Observer, Request, Worker},
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

pub(super) trait SessionHost: Send + Sync {
    fn output(&self, packet: Value);
    fn configuration(&self) -> Option<Value>;
    fn readonly_views(&self, identity: &str) -> Vec<String>;
    fn readonly(&self, runtime: &str) -> bool;
    fn rekey(&self, old: &str, new: &str, epoch: &str);
    fn finished(&self, key: &str, epoch: &str, pending: Vec<Value>, transient: bool);
    fn maintenance(&self, key: &str);
    fn agent_event(&self, identity: &str, event: &Value);
    fn refresh_providers(&self) -> BoxFuture<'_, Result<u64>>;
}

#[derive(Clone)]
pub(super) struct Dialog {
    pub event: Value,
    pub owner: Option<String>,
    pub generation: String,
    pub answering: bool,
    pub answer_queued: bool,
    pub queued_response: Option<Value>,
}

struct SessionState {
    key: String,
    state: Value,
    views: Vec<(String, Value)>,
    statuses: Vec<(String, Value)>,
    dialogs: Vec<(String, Dialog)>,
    live_messages: Vec<(String, Value)>,
    tools: Vec<(String, Value)>,
    sequence: u64,
    state_revision: u64,
    content_revision: u64,
    working: bool,
    compacting: bool,
    submitted: bool,
    closed: bool,
    stopping: bool,
    transient: bool,
    pause_state: Value,
    worktree: Value,
    presence_id: Value,
    reserved_path: Option<String>,
    startup_error: Option<String>,
    input_rejection: Value,
    command_errors: HashMap<String, String>,
    applied_configuration: Option<Value>,
    applied_runtime_settings: Option<(Value, Value)>,
    configuration_error: Option<String>,
    configuring: bool,
    auto_compaction: Option<bool>,
    auto_retry: Option<bool>,
    agent_revision: u64,
    provider_revision: u64,
}

pub(super) struct Session {
    pub identity: String,
    pub client_id: String,
    pub spec: LaunchSpec,
    pub cwd: Option<String>,
    pub ephemeral: bool,
    pub timeout: Duration,
    pub queue: SessionQueue,
    epoch: String,
    state: Mutex<SessionState>,
    worker: OnceLock<Arc<Worker>>,
    host: Arc<dyn SessionHost>,
    configuration_gate: AsyncMutex<()>,
    publication: Mutex<()>,
    weak: Weak<Self>,
}

struct SessionCallbacks(Weak<Session>);

impl Execution for SessionCallbacks {
    fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move { self.0.upgrade().ok_or("Pi is not running")?.execute(command).await })
    }
    fn publish(&self, event: Value) {
        if let Some(session) = self.0.upgrade() {
            session.publish(event, None);
        }
    }
}

impl Observer for SessionCallbacks {
    fn event(&self, event: Value) {
        if let Some(session) = self.0.upgrade() {
            session.receive(event);
        }
    }
    fn response(&self, event: Value, request: &Request) -> Result<Value> {
        self.0.upgrade().ok_or("Pi is not running")?.response(event, request)
    }
    fn stderr(&self, line: String) {
        if let Some(session) = self.0.upgrade() {
            let views = {
                let mut state = session.state();
                if state.state.is_null() {
                    state.startup_error = Some(line.clone());
                }
                state.views.clone()
            };
            for (runtime, _) in views {
                session.host.output(json!({"type":"stderr","runtimeId":runtime,"line":line}));
            }
        }
    }
    fn diagnostic(&self, line: String) {
        if let Some(session) = self.0.upgrade() {
            session.host.output(json!({"type":"diagnostic","line":line}));
        }
    }
    fn finished(&self) {
        if let Some(session) = self.0.upgrade() {
            session.finish();
        }
    }
    fn disconnect_error(&self) -> String {
        self.0
            .upgrade()
            .and_then(|session| session.state().startup_error.clone())
            .unwrap_or_else(|| "Pi disconnected before responding".into())
    }
}

impl Session {
    pub fn spawn(launch: SessionLaunch, pending: Vec<Value>, host: Arc<dyn SessionHost>, home: &Path) -> Result<Arc<Self>> {
        let SessionLaunch {
            key,
            mut spec,
            timeout,
            ephemeral,
            transient,
            client_id,
            cwd,
        } = launch;
        spec.prepare(&key, &client_id, home);
        let identity = if spec.argument("--session").is_some() {
            key.clone()
        } else {
            spec.argument("--session-id").unwrap_or(&key).into()
        };
        let agent_revision = host
            .configuration()
            .and_then(|configuration| configuration["agentRevision"].as_u64())
            .unwrap_or(0);
        let session = Arc::new_cyclic(|weak| Self {
            identity,
            client_id,
            spec,
            cwd,
            ephemeral,
            timeout,
            epoch: Uuid::new_v4().to_string(),
            queue: SessionQueue::new(Arc::new(SessionCallbacks(weak.clone())), pending),
            worker: OnceLock::new(),
            host,
            configuration_gate: AsyncMutex::new(()),
            publication: Mutex::new(()),
            weak: weak.clone(),
            state: Mutex::new(SessionState {
                key,
                state: Value::Null,
                views: Vec::new(),
                statuses: Vec::new(),
                dialogs: Vec::new(),
                live_messages: Vec::new(),
                tools: Vec::new(),
                sequence: 0,
                state_revision: 0,
                content_revision: 0,
                working: false,
                compacting: false,
                submitted: false,
                closed: false,
                stopping: false,
                transient,
                pause_state: Value::Null,
                worktree: Value::Null,
                presence_id: Value::Null,
                reserved_path: None,
                startup_error: None,
                input_rejection: Value::Null,
                command_errors: HashMap::new(),
                applied_configuration: None,
                applied_runtime_settings: None,
                configuration_error: None,
                configuring: false,
                auto_compaction: None,
                auto_retry: None,
                agent_revision,
                provider_revision: 0,
            }),
        });
        let worker = Worker::spawn(
            &session.spec,
            &session.identity,
            timeout,
            Arc::new(SessionCallbacks(Arc::downgrade(&session))),
            home,
        )?;
        let _ = session.worker.set(worker);
        Ok(session)
    }

    fn state(&self) -> MutexGuard<'_, SessionState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    pub fn key(&self) -> String {
        self.state().key.clone()
    }
    pub fn saved_state(&self) -> Value {
        self.state().state.clone()
    }
    pub fn reserved_path(&self) -> Option<String> {
        self.state().reserved_path.clone()
    }
    pub fn set_reserved_path(&self, path: Option<String>) {
        self.state().reserved_path = path;
    }
    pub fn transient(&self) -> bool {
        self.state().transient
    }
    pub fn make_visible(&self) {
        self.state().transient = false;
    }
    pub fn closed(&self) -> bool {
        self.state().closed
    }
    pub fn stopping(&self) -> bool {
        self.state().stopping
    }
    pub fn working(&self) -> bool {
        self.state().working
    }
    pub fn compacting(&self) -> bool {
        self.state().compacting
    }
    pub fn submitted(&self) -> bool {
        self.state().submitted
    }
    pub fn views(&self) -> Vec<(String, Value)> {
        self.state().views.clone()
    }
    pub fn dialog(&self, id: &str) -> Option<Dialog> {
        self.state()
            .dialogs
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, dialog)| dialog.clone())
    }
    pub fn change_dialog(&self, id: &str, change: impl FnOnce(&mut Dialog)) {
        if let Some((_, dialog)) = self.state().dialogs.iter_mut().find(|(key, _)| key == id) {
            change(dialog);
        }
    }
    pub fn revision(&self) -> String {
        format!("{}:{}", self.epoch, self.state().content_revision)
    }
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn settings_pending(&self) -> bool {
        self.host
            .configuration()
            .is_some_and(|configuration| self.state().applied_configuration.as_ref() != Some(&configuration))
    }

    pub fn configuration_error(&self) -> Option<String> {
        let error = self.state().configuration_error.clone();
        error.filter(|_| self.settings_pending())
    }

    pub fn busy(&self, observed: &Value) -> bool {
        let queue = self.queue.view();
        let state = self.state();
        state.working
            || state.compacting
            || flag(observed, "isStreaming")
            || flag(observed, "isCompacting")
            || observed["pendingMessageCount"].as_u64().unwrap_or(0) > 0
            || !array(&queue, "steering").is_empty()
            || !array(&queue, "followUp").is_empty()
            || !array(&queue, "pendingMessages").is_empty()
    }

    pub fn unused(&self) -> bool {
        if self.busy(&Value::Null) {
            return false;
        }
        let state = self.state();
        state.views.is_empty()
            && !state.configuring
            && !flag(&state.pause_state, "isPausing")
            && !state
                .dialogs
                .iter()
                .any(|(_, dialog)| !dialog.event["asyncQuestion"].is_string() || dialog.answering)
    }

    pub fn publish(&self, mut event: Value, target: Option<&str>) {
        let _publication = self.publication.lock().unwrap_or_else(|error| error.into_inner());
        if target.is_none() {
            self.host.agent_event(&self.identity, &event);
        }
        let name = kind(&event).to_owned();
        let (key, targets) = {
            let mut state = self.state();
            let previous = format!("{}:{}", self.epoch, state.content_revision);
            if events::state_change(&name) {
                state.state_revision += 1;
            }
            if events::state_change(&name)
                || matches!(
                    name.as_str(),
                    "message_update"
                        | "tool_execution_start"
                        | "tool_execution_update"
                        | "tool_execution_end"
                        | "queue_update"
                        | "settings_applied"
                        | "extension_ui_request"
                )
            {
                state.content_revision += 1;
            }
            if state.transient {
                return;
            }
            state.sequence += 1;
            event["previousRevision"] = json!(previous);
            event["revision"] = json!(format!("{}:{}", self.epoch, state.content_revision));
            event["sequence"] = json!(state.sequence);
            event["epoch"] = json!(self.epoch);
            let targets = target
                .map(|target| vec![target.to_owned()])
                .unwrap_or_else(|| state.views.iter().map(|(id, _)| id.clone()).collect());
            (state.key.clone(), targets)
        };
        let mut targets = targets;
        if target.is_none() {
            for id in self.host.readonly_views(&self.identity) {
                if !targets.contains(&id) {
                    targets.push(id);
                }
            }
        }
        for runtime in targets {
            if self.host.readonly(&runtime) && name == "extension_ui_request" && events::interactive(&event) {
                continue;
            }
            self.host.output(json!({"type":"event","runtimeId":runtime,"event":event}));
        }
        if matches!(name.as_str(), "queue_update" | "settings_pending") {
            self.publish_state();
        }
        if matches!(
            name.as_str(),
            "agent_settled" | "compaction_end" | "auto_compaction_end" | "queue_update"
        ) {
            self.host.maintenance(&key);
        }
    }

    pub fn publish_state(&self) {
        let messageable = self.unused();
        let packet = {
            let state = self.state();
            if state.transient {
                return;
            }
            json!({"type":"session_state","sessionKey":state.key,"state":state.state,"working":state.working,
                "worktree":state.worktree,"presenceId":state.presence_id,"messageable":messageable})
        };
        self.host.output(packet);
    }

    fn publish_presence(&self) {
        let event = {
            let state = self.state();
            json!({"type":"runtime_presence","viewers":state.views.iter().filter(|(_, view)| flag(view,"visible")).count(),"isStreaming":state.working})
        };
        self.publish(event, None);
        self.publish_state();
    }

    pub fn attach(&self, runtime: &str, presence: Value) {
        let statuses = {
            let mut state = self.state();
            set(&mut state.views, runtime.to_owned(), presence);
            state.statuses.clone()
        };
        for (_, event) in statuses {
            self.publish(event, Some(runtime));
        }
        self.publish(self.queue.view(), Some(runtime));
        self.publish(json!({"type":"settings_pending","pending":self.settings_pending()}), Some(runtime));
        let error = self.state().configuration_error.clone();
        if let Some(error) = error {
            self.publish(json!({"type":"extension_error","error":error}), Some(runtime));
        }
        self.route_dialogs();
        self.publish_presence();
    }

    pub fn presence(&self, runtime: &str, presence: Value) {
        set(&mut self.state().views, runtime.into(), presence);
        self.route_dialogs();
        self.publish_presence();
    }

    pub fn detach_view(&self, runtime: &str) {
        self.state().views.retain(|(id, _)| id != runtime);
        self.route_dialogs();
        self.publish_presence();
    }

    pub async fn detach(&self, runtime: &str, discard_blank: bool, preserve_running: bool) -> Value {
        self.detach_view(runtime);
        let (stopped, submitted) = {
            let state = self.state();
            (
                !preserve_running && state.views.is_empty() && (self.ephemeral || discard_blank && !state.submitted && !state.working),
                state.submitted,
            )
        };
        if stopped {
            self.stop().await;
        }
        self.host.maintenance(&self.key());
        json!({"stopped":stopped,"submitted":submitted})
    }

    pub async fn stop(&self) {
        self.state().stopping = true;
        if let Some(worker) = self.worker.get() {
            worker.stop().await;
        }
    }

    pub async fn retire(&self) -> Result<()> {
        if self.transient() {
            return Err("This conversation branch is still being prepared".into());
        }
        if self.closed() {
            return Ok(());
        }
        self.assert_idle(&Value::Null)?;
        let _gate = self.queue.gate.lock().await;
        if self.closed() {
            return Ok(());
        }
        self.assert_idle(&Value::Null)?;
        let state = self.execute(json!({"type":"get_state"})).await?;
        self.assert_idle(&state)?;
        self.stop().await;
        Ok(())
    }

    fn assert_idle(&self, observed: &Value) -> Result<()> {
        if !self.views().is_empty() {
            return Err("Close this conversation in all windows before messaging or archiving it".into());
        }
        if !self.unused() || self.busy(observed) || flag(observed, "isPausing") {
            return Err(
                "Finish the response, queued messages, and settings changes before messaging or archiving this conversation".into(),
            );
        }
        Ok(())
    }

    fn finish(&self) {
        let (key, transient) = {
            let mut state = self.state();
            if state.closed {
                return;
            }
            state.closed = true;
            state.dialogs.clear();
            (state.key.clone(), state.transient)
        };
        self.queue.receive(json!({"type":"disconnected"}));
        let pending = if self.ephemeral { Vec::new() } else { self.queue.pending() };
        self.host.finished(&key, &self.epoch, pending, transient);
        if !transient {
            self.host
                .output(json!({"type":"session_closed","sessionKey":key,"state":self.saved_state(),"submitted":self.submitted()}));
        }
    }

    pub async fn raw(&self, command: Value) -> Result<Value> {
        let name = kind(&command).to_owned();
        self.raw_as(command, &name, Value::Null).await
    }

    async fn raw_as(&self, command: Value, request_type: &str, snapshot: Value) -> Result<Value> {
        if self.closed() {
            return Err(self.state().startup_error.clone().unwrap_or_else(|| "Pi is not running".into()));
        }
        if request_type == "prompt" {
            let mut state = self.state();
            state.input_rejection = Value::Null;
            state.command_errors.clear();
        }
        self.worker
            .get()
            .ok_or("Pi is not running")?
            .request(command, request_type, snapshot)
            .await
    }

    pub async fn send(&self, command: &Value) -> Result<()> {
        self.worker.get().ok_or("Pi is not running")?.send(command).await
    }

    pub fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            match kind(&command) {
                "get_session_revision" => return Ok(json!({"revision":self.revision()})),
                "get_tool_payload" => return self.collect_tool_payload(&command).await,
                "get_snapshot" => return self.collect_snapshot().await,
                "get_entries" => return Ok(self.collect_snapshot().await?["history"].clone()),
                "get_state" => {
                    let mut state = self.raw(command).await?;
                    merge(&mut state, self.raw(json!({"type":"get_pause_state"})).await?);
                    state["pendingMessages"] = self.queue.view()["pendingMessages"].clone();
                    state["pendingMessageCount"] =
                        json!(state["pendingMessageCount"].as_u64().unwrap_or(0) + self.queue.held_count() as u64);
                    return Ok(state);
                }
                "force_stop" => {
                    self.stop().await;
                    return Ok(Value::Null);
                }
                "get_available_models" => {
                    let revision = self.host.refresh_providers().await;
                    let force = revision.is_err();
                    let revision = revision.unwrap_or(self.state().provider_revision);
                    if force || revision != 0 && revision != self.state().provider_revision {
                        self.raw(json!({"type":"provider_auth_refresh"})).await?;
                        self.state().provider_revision = revision;
                    }
                }
                _ => {}
            }
            self.execute_worker(command).await
        })
    }

    async fn execute_worker(&self, command: Value) -> Result<Value> {
        let runtime_key = {
            let mut state = self.state();
            if kind(&command) == "voice_history" || kind(&command) == "prompt" && !text(&command, "message").starts_with('/') {
                state.submitted = true;
            }
            let key = (kind(&command) == "runtime_settings").then(|| json!({"settings":command["settings"],"agentRevision":command["agentRevision"].as_u64().unwrap_or(state.agent_revision)}));
            if let Some(key) = &key {
                if let Some((saved, result)) = &state.applied_runtime_settings {
                    if key == saved {
                        return Ok(result.clone());
                    }
                }
            }
            key
        };
        let result = self.raw(command.clone()).await?;
        {
            let mut state = self.state();
            if let Some(key) = runtime_key {
                state.applied_runtime_settings = Some((key, result.clone()));
            }
            if kind(&command) == "set_auto_compaction" {
                state.auto_compaction = command["enabled"].as_bool();
            }
            if kind(&command) == "set_auto_retry" {
                state.auto_retry = command["enabled"].as_bool();
            }
        }
        if kind(&command) == "resume" && result["resumeMessage"].as_str().is_some_and(|message| !message.is_empty()) {
            self.raw(json!({"type":"prompt","message":result["resumeMessage"]})).await?;
        }
        if matches!(
            kind(&command),
            "set_model" | "set_thinking_level" | "set_session_name" | "fork_and_forget" | "runtime_settings"
        ) {
            self.publish(json!({"type":"session_info_changed"}), None);
        }
        Ok(result)
    }

    async fn collect_tool_payload(&self, command: &Value) -> Result<Value> {
        let id = text(command, "toolCallId");
        let live = self
            .state()
            .tools
            .iter()
            .find(|(key, _)| key == &id)
            .map(|(_, value)| value.clone());
        if let Some(live) = live {
            let mut result = live["partialResult"].as_object().cloned().map(Value::Object).unwrap_or(json!({}));
            if let Some(args) = live.get("args") {
                result["toolInput"] = args.clone();
            }
            return tool_payload_page(Some(result), command);
        }
        let history = self.raw(json!({"type":"get_entries"})).await?;
        tool_payload_page(saved_tool_payload(&array(&history, "entries"), &id), command)
    }

    async fn collect_snapshot(&self) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + self.timeout;
        loop {
            let revision = self.state().state_revision;
            let mut state = self.raw(json!({"type":"get_state"})).await?;
            merge(&mut state, self.raw(json!({"type":"get_pause_state"})).await?);
            let mut snapshot = self.raw_as(json!({"type":"get_entries"}), "get_snapshot_entries", state).await?;
            let current = snapshot["stateRevision"].as_u64();
            if let Some(snapshot) = snapshot.as_object_mut() {
                snapshot.remove("stateRevision");
            }
            if current == Some(revision) {
                return Ok(snapshot);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Session kept changing while collecting its snapshot".into());
            }
        }
    }

    fn response(&self, event: Value, request: &Request) -> Result<Value> {
        if request.request_type == "prompt" {
            let state = self.state();
            let message = text(&request.command, "message");
            let command_name = message
                .strip_prefix('/')
                .and_then(|command| command.split_whitespace().next())
                .unwrap_or_default();
            if let Some(error) = state.command_errors.get(command_name).or_else(|| state.command_errors.get("")) {
                return Err(error.clone());
            }
            if state.input_rejection["text"] == message {
                if let Some(error) = state.input_rejection["error"].as_str() {
                    return Err(error.into());
                }
            }
        }
        if !flag(&event, "success") {
            return Err(event["error"].as_str().unwrap_or("Pi command failed").into());
        }
        let mut data = event.get("data").cloned().unwrap_or(Value::Null);
        if matches!(request.request_type.as_str(), "get_entries" | "get_snapshot_entries") {
            self.queue.tag_entries(&mut data);
        }
        if request.request_type == "get_state" {
            let rekey = {
                let mut state = self.state();
                state.state = data.clone();
                data["sessionId"]
                    .as_str()
                    .filter(|id| !id.is_empty() && !self.ephemeral && !state.transient && state.key != *id)
                    .map(|id| {
                        let old = std::mem::replace(&mut state.key, id.into());
                        (old, id.to_owned())
                    })
            };
            if let Some((old, new)) = rekey {
                self.host.rekey(&old, &new, &self.epoch);
            }
            self.publish_state();
        }
        if request.request_type != "get_snapshot_entries" {
            return Ok(data);
        }
        let queue = self.queue.view();
        let state = self.state();
        for (_, message) in &state.live_messages {
            if !array(&data, "entries")
                .iter()
                .any(|entry| entry["message"]["role"] == message["role"] && entry["message"]["timestamp"] == message["timestamp"])
            {
                let id = format!("live-{}-{}", text(message, "role"), message["timestamp"]);
                let mut message = message.clone();
                message["streaming"] = json!(message["role"] == "assistant");
                let entry = json!({"type":"message","id":id,"parentId":data["leafId"],"message":message});
                if let Some(entries) = data["entries"].as_array_mut() {
                    entries.push(entry);
                }
                data["leafId"] = json!(id);
            }
        }
        let mut snapshot_state = request.snapshot_state.clone();
        snapshot_state["isStreaming"] = json!(state.working);
        snapshot_state["viewers"] = json!(state.views.iter().filter(|(_, view)| flag(view, "visible")).count());
        snapshot_state["pendingMessageCount"] = json!(array(&queue, "steering").len() + array(&queue, "followUp").len());
        Ok(
            json!({"history":data,"revision":format!("{}:{}",self.epoch,state.content_revision),"sequence":state.sequence,"stateRevision":state.state_revision,
            "epoch":self.epoch,"liveTools":state.tools.iter().map(|(_,value)|value).collect::<Vec<_>>(),
            "extensionState":state.statuses.iter().map(|(_,value)|value).collect::<Vec<_>>(),"queue":queue,"state":snapshot_state}),
        )
    }
}

fn set<T>(items: &mut Vec<(String, T)>, key: String, value: T) {
    if let Some((_, item)) = items.iter_mut().find(|(id, _)| id == &key) {
        *item = value;
    } else {
        items.push((key, value));
    }
}
pub(super) fn merge(target: &mut Value, source: Value) {
    if let (Some(target), Value::Object(source)) = (target.as_object_mut(), source) {
        target.extend(source);
    }
}
