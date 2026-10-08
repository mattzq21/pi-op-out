use super::*;

pub(super) fn interactive(event: &Value) -> bool {
    matches!(event["method"].as_str(), Some("input" | "editor" | "select" | "confirm"))
}

pub(super) fn state_change(name: &str) -> bool {
    matches!(
        name,
        "session_info_changed"
            | "session_switched"
            | "model_select"
            | "thinking_level_changed"
            | "agent_start"
            | "agent_end"
            | "agent_settled"
            | "message_start"
            | "message_end"
            | "entry_appended"
            | "pause_state"
            | "compaction_start"
            | "compaction_end"
            | "auto_compaction_start"
            | "auto_compaction_end"
    )
}

impl Session {
    pub(super) fn receive(&self, mut event: Value) {
        if kind(&event) == "queue_consumed" {
            if event["sessionId"] == self.identity { self.queue.consumed(&text(&event, "queueId")); }
            return;
        }
        self.record_tool_failure(&event);
        if !self.ephemeral && (kind(&event) == "agent_settled" || (kind(&event) == "message_end" && event["message"]["role"] == "assistant")) {
            crate::session_registry::record(&self.state().state, self.cwd.as_deref());
        }
        self.retain_live(&event);
        if kind(&event) == "extension_ui_request" {
            let Some(next) = self.receive_extension(event) else {
                return;
            };
            event = next;
        }
        if kind(&event) == "extension_error" && event["event"] == "command" {
            let command = event["extensionPath"]
                .as_str()
                .and_then(|path| path.strip_prefix("command:"))
                .unwrap_or_default();
            self.state()
                .command_errors
                .insert(command.into(), event["error"].as_str().unwrap_or("Extension command failed").into());
        }
        self.queue.receive(event);
    }

    fn record_tool_failure(&self, event: &Value) {
        let (call, result) = match kind(event) {
            "tool_execution_end" if flag(event, "isError") => (event, &event["result"]),
            "message_end" if event["message"]["role"] == "toolResult" && flag(&event["message"], "isError") => {
                (&event["message"], &event["message"])
            }
            _ => return,
        };
        let Some(id) = call["toolCallId"].as_str().filter(|id| !id.is_empty()) else { return; };
        let record = {
            let state = self.state();
            let running = state.tools.iter().find(|(key, _)| key == id).map(|(_, tool)| tool);
            let requested = state.tool_calls.get(id);
            let input = call.get("args").filter(|value| !value.is_null())
                .or_else(|| running.and_then(|tool| tool.get("args")))
                .or_else(|| requested.and_then(|tool| tool.get("arguments")));
            json!({"session":state.key,"epoch":self.epoch,"cwd":self.cwd,"model":state.state["model"],
                "toolCallId":id,"toolName":call.get("toolName").or_else(|| running.and_then(|tool| tool.get("toolName"))).or_else(|| requested.and_then(|tool| tool.get("name"))),
                "input":input,"result":result,"failureKind":super::super::payload::tool_failure_kind(result)})
        };
        self.host.record_tool_failure(record);
    }

    fn retain_live(&self, event: &Value) {
        let name = kind(event);
        {
            let mut state = self.state();
            if state_change(name) || name.starts_with("tool_execution_") { state.tool_payload_revision += 1; }
            match name {
                "agent_start" => {
                    state.working = true;
                    state.submitted = true;
                }
                "agent_settled" => {
                    state.working = false;
                    state.live_messages.clear();
                    state.tools.clear();
                    state.tool_calls.clear();
                }
                "compaction_start" | "auto_compaction_start" => state.compacting = true,
                "compaction_end" | "auto_compaction_end" => state.compacting = false,
                "pause_state" => state.pause_state = json!({"isPaused":event["isPaused"],"isPausing":event["isPausing"]}),
                _ => {}
            }
            retain_message(&mut state, event);
        }
        if matches!(
            name,
            "agent_start"
                | "agent_settled"
                | "compaction_start"
                | "compaction_end"
                | "auto_compaction_start"
                | "auto_compaction_end"
                | "pause_state"
        ) {
            self.publish_state();
        }
    }

    fn receive_extension(&self, mut event: Value) -> Option<Value> {
        if event["method"] == "setStatus" && self.receive_status(&event) {
            return None;
        }
        if event["method"] == "notify" && event["notifyType"] == "error" && event["message"] == self.state().input_rejection["error"] {
            event["inputRejected"] = json!(true);
        }
        if matches!(event["method"].as_str(), Some("setStatus" | "setWidget" | "setTitle")) {
            let key = format!(
                "{}:{}",
                text(&event, "method"),
                event["statusKey"]
                    .as_str()
                    .or_else(|| event["widgetKey"].as_str())
                    .unwrap_or_default()
            );
            set(&mut self.state().statuses, key, event.clone());
        }
        if !interactive(&event) {
            return Some(event);
        }
        self.receive_dialog(&event);
        None
    }

    fn receive_dialog(&self, event: &Value) {
        let id = text(event, "id");
        let generation = Uuid::new_v4().to_string();
        set(
            &mut self.state().dialogs,
            id.clone(),
            Dialog {
                event: event.clone(),
                owner: None,
                generation: generation.clone(),
                answering: false,
                answer_queued: false,
                queued_response: None,
            },
        );
        if let Some(timeout) = event["timeout"].as_f64().filter(|timeout| timeout.is_finite() && *timeout >= 0.0) {
            let weak = self.weak.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout.min(2147483647.0) as u64)).await;
                if let Some(session) = weak.upgrade() {
                    if session.dialog(&id).is_some_and(|dialog| dialog.generation == generation) {
                        session.resolve_dialog(&id);
                    }
                }
            });
        }
        self.route_dialogs();
    }

    fn receive_status(&self, event: &Value) -> bool {
        let parsed = || serde_json::from_str::<Value>(event["statusText"].as_str().unwrap_or_default());
        match event["statusKey"].as_str() {
            Some("piop-async-questions" | "piop-async-question-recovery") => self.receive_question_status(event, parsed()),
            Some("pi-desktop-turn-capture") => self.receive_capture(parsed()),
            Some("pi-desktop-worktree-root") => self.receive_worktree_root(parsed()),
            Some("piop-input-rejected") => {
                if let Ok(rejection) = parsed() {
                    self.state().input_rejection = rejection;
                }
            }
            _ => return false,
        }
        true
    }

    fn receive_question_status(&self, event: &Value, parsed: serde_json::Result<Value>) {
        match parsed {
            Ok(requests) => {
                if event["statusKey"] == "piop-async-question-recovery" { self.queue.recover_question_answers(&requests); }
                else { self.receive_questions(requests); }
            }
            Err(error) => self.host.output(json!({"type":"diagnostic","line":error.to_string()})),
        }
    }

    fn receive_capture(&self, parsed: serde_json::Result<Value>) {
        match parsed {
            Ok(mut capture) => {
                capture["type"] = json!("turn_capture");
                capture["sessionKey"] = json!(self.key());
                capture["ephemeral"] = json!(self.ephemeral);
                self.host.output(capture);
            }
            Err(error) => self.host.output(json!({"type":"diagnostic","line":error.to_string()})),
        }
    }

    fn receive_worktree_root(&self, parsed: serde_json::Result<Value>) {
        if let Ok(root) = parsed {
            {
                let mut state = self.state();
                state.worktree = root;
            }
            self.publish_state();
        }
    }

    fn receive_questions(&self, requests: Value) {
        let Some(requests) = requests.as_array() else {
            return;
        };
        let ids: Vec<_> = requests.iter().map(|request| format!("question:{}", text(request, "id"))).collect();
        let removed: Vec<_> = self
            .state()
            .dialogs
            .iter()
            .filter(|(id, dialog)| dialog.event["asyncQuestion"].is_string() && !ids.contains(id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in removed {
            self.resolve_dialog(&id);
        }
        for request in requests {
            let id = format!("question:{}", text(request, "id"));
            if self.dialog(&id).is_some() {
                continue;
            }
            let questions: Vec<_> = array(request, "questions")
                .iter()
                .enumerate()
                .map(|(index, question)| {
                    json!({"id":format!("question_{index}"),"header":"Question","question":question["title"],
                "options":array(question,"options").iter().map(|label|json!({"label":label,"description":""})).collect::<Vec<_>>()})
                })
                .collect();
            let event = json!({"type":"extension_ui_request","id":id,"method":"input","title":"__piop_request_user_input__","asyncQuestion":request["id"],"placeholder":json!({"questions":questions}).to_string()});
            set(
                &mut self.state().dialogs,
                id,
                Dialog {
                    event,
                    owner: None,
                    generation: Uuid::new_v4().to_string(),
                    answering: false,
                    answer_queued: false,
                    queued_response: None,
                },
            );
        }
        self.route_dialogs();
    }

    pub fn route_dialogs(&self) {
        let events = {
            let mut state = self.state();
            let views = state.views.clone();
            let mut events = Vec::new();
            let owner = views
                .iter()
                .find(|(_, view)| flag(view, "visible") && flag(view, "focused"))
                .or_else(|| views.iter().find(|(_, view)| flag(view, "visible")))
                .map(|(id, _)| id.clone());
            for (id, dialog) in &mut state.dialogs {
                if dialog
                    .owner
                    .as_ref()
                    .is_some_and(|owner| views.iter().any(|(id, view)| id == owner && flag(view, "visible")))
                {
                    continue;
                }
                if let Some(previous) = dialog.owner.take() {
                    events.push((previous, json!({"type":"extension_ui_resolved","id":id})));
                }
                dialog.owner = owner.clone();
                if let Some(owner) = &dialog.owner {
                    events.push((owner.clone(), dialog.event.clone()));
                }
            }
            events
        };
        for (runtime, event) in events {
            self.publish(event, Some(&runtime));
        }
        self.publish_state();
    }

    pub fn resolve_dialog(&self, id: &str) {
        let removed = {
            let mut state = self.state();
            let count = state.dialogs.len();
            state.dialogs.retain(|(key, _)| key != id);
            count != state.dialogs.len()
        };
        if !removed {
            return;
        }
        self.publish(json!({"type":"extension_ui_resolved","id":id}), None);
        self.publish_state();
        self.host.maintenance(&self.key());
    }
}

fn retain_tool_calls(state: &mut SessionState, message: &Value) {
            if message["role"] == "assistant" {
                for call in message["content"].as_array().into_iter().flatten().filter(|part| kind(part) == "toolCall") {
                    if let Some(id) = call["id"].as_str() {
                        state.tool_calls.insert(id.into(), call.clone());
                    }
                }
            } else if message["role"] == "toolResult" {
                if let Some(id) = message["toolCallId"].as_str() { state.tool_calls.remove(id); }
            }
}

fn retain_message(state: &mut SessionState, event: &Value) {
    match kind(event) {
        "message_start" => set(&mut state.live_messages, text(&event["message"], "role"), event["message"].clone()),
        "message_update" => {
            let next = event["assistantMessageEvent"]
                .get("partial")
                .filter(|value| !value.is_null())
                .or_else(|| event.get("message").filter(|value| !value.is_null()))
                .cloned()
                .or_else(|| state.live_messages.iter_mut().find(|(role, _)| role == "assistant")
                    .map(|(_, message)| assistant_delta(message.take(), &event["assistantMessageEvent"])));
            if let Some(mut next) = next {
                if let Some(usage) = event.get("usage") {
                    next["usage"] = usage.clone();
                }
                let role = next["role"].as_str().unwrap_or("assistant").to_owned();
                set(&mut state.live_messages, role, next);
            }
        }
        "message_end" => {
            let message = &event["message"];
            retain_tool_calls(state, message);
            state.live_messages.retain(|(role, _)| message["role"] != *role);
        }
        "tool_execution_start" | "tool_execution_update" => {
            let id = text(event, "toolCallId");
            let mut tool = state
                .tools
                .iter()
                .find(|(key, _)| key == &id)
                .map(|(_, tool)| tool.clone())
                .unwrap_or(json!({}));
            merge(&mut tool, event.clone());
            tool["type"] = json!("tool_execution_start");
            set(&mut state.tools, id, tool);
        }
        "tool_execution_end" => state.tools.retain(|(id, _)| event["toolCallId"] != *id),
        _ => {}
    }
}
