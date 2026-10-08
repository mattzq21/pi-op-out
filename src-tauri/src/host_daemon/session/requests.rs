use super::*;

impl Session {
    pub fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            match kind(&command) {
                "get_session_revision" => return Ok(json!({"revision":self.revision()})),
                "get_tool_payload" => return self.collect_tool_payload(&command).await,
                "get_snapshot" => return self.collect_snapshot().await,
                "get_entries" => return self.collect_snapshot().await.map(|mut snapshot| snapshot.get_mut("history").map(Value::take).unwrap_or(Value::Null)),
                "get_state" => return self.collect_state(command).await,
                "force_stop" => {
                    self.stop().await;
                    return Ok(Value::Null);
                }
                "get_available_models" => self.refresh_providers().await?,
                _ => {}
            }
            self.execute_worker(command).await
        })
    }

    async fn collect_state(&self, command: Value) -> Result<Value> {
        let mut state = self.raw(command).await?;
        merge(&mut state, self.raw(json!({"type":"get_pause_state"})).await?);
        state["pendingMessages"] = self.queue.view()["pendingMessages"].clone();
        state["ephemeral"] = json!(self.ephemeral);
        state["pendingMessageCount"] = json!(state["pendingMessageCount"].as_u64().unwrap_or(0) + self.queue.held_count() as u64);
        Ok(state)
    }

    async fn refresh_providers(&self) -> Result<()> {
        let revision = self.host.refresh_providers().await;
        let force = revision.is_err();
        let revision = revision.unwrap_or(self.state().provider_revision);
        if force || revision != 0 && revision != self.state().provider_revision {
            self.raw(json!({"type":"provider_auth_refresh"})).await?;
            self.state().provider_revision = revision;
        }
        Ok(())
    }

    pub(super) async fn execute_worker(&self, command: Value) -> Result<Value> {
        let (runtime_key, cached) = self.prepare_worker_command(&command);
        if let Some(result) = cached {
            return Ok(result);
        }
        let result = self.raw(command.clone()).await?;
        self.remember_worker_result(&command, runtime_key, &result);
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

    fn prepare_worker_command(&self, command: &Value) -> (Option<Value>, Option<Value>) {
        let mut state = self.state();
        if matches!(kind(command), "prompt" | "queue_prompt") && !text(command, "message").starts_with('/') {
            state.submitted = true;
        }
        let key = (kind(command) == "runtime_settings").then(
            || json!({"settings":command["settings"],"agentRevision":command["agentRevision"].as_u64().unwrap_or(state.agent_revision)}),
        );
        if let Some(key) = &key {
            if let Some((saved, result)) = &state.applied_runtime_settings {
                if key == saved {
                    return (Some(key.clone()), Some(result.clone()));
                }
            }
        }
        (key, None)
    }

    fn remember_worker_result(&self, command: &Value, runtime_key: Option<Value>, result: &Value) {
        let mut state = self.state();
        if let Some(key) = runtime_key {
            state.applied_runtime_settings = Some((key, result.clone()));
        }
        if kind(command) == "set_auto_compaction" {
            state.auto_compaction = command["enabled"].as_bool();
        }
        if kind(command) == "set_auto_retry" {
            state.auto_retry = command["enabled"].as_bool();
        }
    }

    async fn collect_tool_payload(&self, command: &Value) -> Result<Value> {
        let id = text(command, "toolCallId");
        let revision = self.state().tool_payload_revision.to_string();
        if let Some(payload) = self.tool_payloads.get(&self.epoch, &revision, &id) {
            return payload.page(command);
        }
        let payload = Arc::new(ToolPayload::new(self.tool_payload_message(&id).await?)?);
        let page = payload.page(command)?;
        if self.state().tool_payload_revision.to_string() == revision {
            self.tool_payloads.insert(&self.epoch, &revision, &id, payload);
        }
        Ok(page)
    }

    async fn tool_payload_message(&self, id: &str) -> Result<Option<Value>> {
        let live = self
            .state()
            .tools
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, value)| value.clone());
        if let Some(live) = live {
            let mut result = live["partialResult"].as_object().cloned().map(Value::Object).unwrap_or(json!({}));
            if let Some(args) = live.get("args") {
                result["toolInput"] = args.clone();
            }
            return Ok(Some(result));
        }
        let history = self.raw(json!({"type":"get_entries"})).await?;
        let entries = history["entries"].as_array().map(Vec::as_slice).unwrap_or_default();
        Ok(saved_tool_payload(entries, id))
    }

    async fn collect_snapshot(&self) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + self.timeout;
        loop {
            let revision = self.state().state_revision;
            let mut state = self.raw(json!({"type":"get_state"})).await?;
            state["ephemeral"] = json!(self.ephemeral);
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

    pub(super) fn response(&self, mut event: Value, request: &Request) -> Result<Value> {
        if let Some(result) = self.reject_goal_preparation(&event, request) { return result; }
        if let Err(error) = self.response_error(&event, request) {
            if flag(&request.command, "discardOnRejection") { self.queue.rejected(&text(&request.command, "queueId")); }
            return Err(error);
        }
        let mut data = event.get_mut("data").map(std::mem::take).unwrap_or(Value::Null);
        if matches!(request.request_type.as_str(), "get_entries" | "get_snapshot_entries") {
            self.queue.tag_entries(&mut data);
        }
        if request.request_type == "get_state" {
            self.receive_state(&data);
        }
        if request.request_type == "get_snapshot_entries" {
            return self.snapshot_response(data, request);
        }
        Ok(data)
    }

    fn response_error(&self, event: &Value, request: &Request) -> Result<()> {
        if matches!(request.request_type.as_str(), "prompt" | "queue_prompt") { self.check_prompt_error(&request.command, &event["data"]["submittedText"])?; }
        if !flag(event, "success") { return Err(event["error"].as_str().unwrap_or("Pi command failed").into()); }
        Ok(())
    }

    fn reject_goal_preparation(&self, event: &Value, request: &Request) -> Option<Result<Value>> {
        if flag(event, "success") || event["rejection"] != "goal_preparation" { return None; }
        if request.request_type == "queue_prompt" && !flag(&request.command, "discardOnRejection") {
            return Some(Err(event["error"].as_str().unwrap_or("Goal prompt preparation failed").into()));
        }
        if flag(&request.command, "discardOnRejection") { self.queue.rejected(&text(&request.command, "queueId")); }
        Some(Ok(json!(false)))
    }

    fn check_prompt_error(&self, command: &Value, submitted_text: &Value) -> Result<()> {
        let state = self.state();
        let message = text(command, "message");
        let command_name = message
            .strip_prefix('/')
            .and_then(|command| command.split_whitespace().next())
            .unwrap_or_default();
        if let Some(error) = state.command_errors.get(command_name).or_else(|| state.command_errors.get("")) {
            return Err(error.clone());
        }
        if state.input_rejection["text"] == message || submitted_text.is_string() && state.input_rejection["text"] == *submitted_text {
            if let Some(error) = state.input_rejection["error"].as_str() {
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn receive_state(&self, data: &Value) {
        if !self.ephemeral && self.state().state["sessionId"] != data["sessionId"] {
            crate::session_registry::record(data, self.cwd.as_deref());
        }
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

    fn snapshot_response(&self, mut data: Value, request: &Request) -> Result<Value> {
        let queue = self.queue.view();
        let state = self.state();
        for (_, message) in &state.live_messages {
            if !data["entries"].as_array().into_iter().flatten()
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
        snapshot_state["needsInput"] = json!(state.dialogs.iter().any(|(_, dialog)| !dialog.answering));
        snapshot_state["pendingMessageCount"] = json!(array(&queue, "steering").len() + array(&queue, "followUp").len());
        Ok(
            json!({"history":data,"revision":format!("{}:{}",self.epoch,state.content_revision),"sequence":state.sequence,"stateRevision":state.state_revision,
            "epoch":self.epoch,"liveTools":state.tools.iter().map(|(_,value)|value).collect::<Vec<_>>(),
            "extensionState":state.statuses.iter().map(|(_,value)|value).collect::<Vec<_>>(),"queue":queue,"state":snapshot_state}),
        )
    }
}
