use super::*;

struct DeliveryGuard { host: Arc<Host>, session: String, delivery: String }

impl Drop for DeliveryGuard {
    fn drop(&mut self) {
        let mut registry = self.host.registry();
        if let Some(deliveries) = registry.deliveries.get_mut(&self.session) {
            deliveries.remove(&self.delivery);
            if deliveries.is_empty() { registry.deliveries.remove(&self.session); }
        }
    }
}

fn validate_delivery(packet: &Value) -> Result<()> {
    let source = text(packet, "sourceSessionId");
    if source.is_empty() || source == text(packet, "sessionKey") { return Err("Choose another conversation as the recipient".into()); }
    let message = text(packet, "message");
    if message.trim().is_empty() || message.len() > 100_000 { return Err("Message must contain 1–100000 bytes".into()); }
    Ok(())
}

impl Host {
    pub async fn handle(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let runtime = text(&packet, "runtimeId");
        let name = kind(&packet);
        if name == "detach" {
            self.registry().attachments.remove(&runtime);
        }
        match name {
            "agent_definitions" => return Ok(self.registry().agent_definitions.clone()),
            "conversation_owner" => return self.ownership().owns(&text(&packet, "sessionId"), &text(&packet, "clientId")).map(Value::Bool),
            "provider_auth" | "provider_auth_cancel_owner" => return self.services.handle(packet).await,
            "ownership_drained" => return Ok(self.ownership_drained(&packet)),
            "conversation_mutation" => return self.begin_mutation(&packet).await,
            "conversation_mutation_end" => return self.end_mutation(&packet),
            "configure" | "attach" | "shutdown" => return self.lifecycle(packet).await,
            "retire" | "session_command" | "orchestration" => return self.conversation_request(packet).await,
            _ => {}
        }
        self.runtime_command(packet, &runtime).await
    }

    async fn conversation_request(self: &Arc<Self>, packet: Value) -> Result<Value> {
        match kind(&packet) {
            "retire" => self.retire(&packet).await,
            "session_command" => self.direct_session_command(&packet).await,
            _ => self.orchestration(packet).await,
        }
    }

    async fn lifecycle(self: &Arc<Self>, packet: Value) -> Result<Value> {
        match kind(&packet) {
            "configure" => self.configure(&packet["configuration"]).await.map(|_| Value::Null),
            "attach" => self.attach(packet).await,
            _ => {
                self.shutdown().await;
                Ok(Value::Null)
            }
        }
    }

    async fn orchestration(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let id = text(&packet, "sessionKey");
        if text(&packet, "action") == "interrupt" {
            if self.cancel_deliveries(&id, packet["deliveryId"].as_str()) {
                return Ok(json!({"sessionId":id,"completed":false}));
            }
            return self.orchestration_cancel(&id).await;
        }
        if self.ownership().locate(&id, packet["sessionPath"].as_str(), false, true)?.is_none() {
            return Err("This conversation has been deleted or archived".into());
        }
        let session = self.find_session(&id);
        match text(&packet, "action").as_str() {
            "read" => match session {
                Some(session) => session.execute(json!({"type":"get_snapshot"})).await,
                None => self.ownership().snapshot(&id, packet["sessionPath"].as_str()),
            },
            "send" => self.orchestration_send(packet, session).await,
            _ => Err("Unknown orchestration action".into()),
        }
    }

    fn cancel_deliveries(&self, id: &str, delivery: Option<&str>) -> bool {
        let mut registry = self.registry();
        if let Some(delivery) = delivery { registry.cancelled_deliveries.insert(delivery.into()); }
        let pending = registry.deliveries.get(id).cloned().unwrap_or_default();
        registry.cancelled_deliveries.extend(pending.iter().cloned());
        !pending.is_empty()
    }

    async fn orchestration_cancel(&self, id: &str) -> Result<Value> {
        let session = self.find_session(id);
        if session.is_some() { return self.orchestration_interrupt(id, session).await; }
        if self.ownership().locate(id, None, false, true)?.is_some() {
            return self.orchestration_interrupt(id, None).await;
        }
        if self.ownership().removed(id)? || self.ownership().locate(id, None, true, true)?.is_some() {
            return Ok(json!({"sessionId":id,"completed":true,"retired":true}));
        }
        Err("Cannot confirm that this conversation has stopped or been retired".into())
    }

    async fn orchestration_interrupt(&self, id: &str, session: Option<Arc<Session>>) -> Result<Value> {
        let Some(session) = session else { return Ok(json!({"sessionId":id,"completed":true})); };
        let mut pending = session.orchestration_interrupt.lock().await;
        if pending.as_ref().is_some_and(|task| task.is_finished()) {
            let task = pending.take().ok_or("Missing interruption task")?;
            task.await.map_err(|error| error.to_string())??;
            return Ok(json!({"sessionId":id,"completed":true}));
        }
        if pending.is_none() {
            let target = session.clone();
            *pending = Some(tokio::spawn(async move { target.queue.interrupt_delegation().await }));
        }
        Ok(json!({"sessionId":id,"completed":false}))
    }

    async fn orchestration_send(self: &Arc<Self>, packet: Value, existing: Option<Arc<Session>>) -> Result<Value> {
        let id = text(&packet, "sessionKey");
        validate_delivery(&packet)?;
        let delivery = text(&packet, "deliveryId");
        if Uuid::parse_str(&delivery).is_err() { return Err("A valid deliveryId is required".into()); }
        {
            let mut registry = self.registry();
            if registry.cancelled_deliveries.contains(&delivery) { return Err("Agent delivery was cancelled".into()); }
            if !registry.deliveries.entry(id.clone()).or_default().insert(delivery.clone()) { return Err("Agent delivery is already pending".into()); }
        }
        let _delivery = DeliveryGuard { host: self.clone(), session: id.clone(), delivery };
        let runtime = format!("orchestration-{}", Uuid::new_v4());
        let attached = existing.is_none();
        if attached {
            let result = self.attach(json!({"type":"attach","runtimeId":runtime,"clientId":packet["clientId"],
                "sessionKey":id,"spec":packet["spec"],"cwd":packet["cwd"],"presence":{"visible":false}})).await?;
            if !flag(&result, "owned") {
                self.registry().attachments.remove(&runtime);
                self.registry().readonly.remove(&runtime);
                return Err(ownership_error());
            }
        }
        let result = self.orchestration_deliver(&packet).await;
        if attached {
            let detached = self.orchestration_detach(&runtime).await;
            if result.is_ok() { detached?; }
        }
        result
    }

    async fn orchestration_deliver(&self, packet: &Value) -> Result<Value> {
        let session = self.find_session(&text(packet, "sessionKey")).ok_or("Conversation is no longer running")?;
        if session.transient() || session.compacting() { return Err("Wait for conversation preparation or compaction to finish".into()); }
        session.reconcile(false).await;
        if let Some(error) = session.configuration_error() { return Err(error); }
        if self.registry().cancelled_deliveries.contains(&text(packet, "deliveryId")) { return Err("Agent delivery was cancelled".into()); }
        queue_command(&session, json!({"type":"orchestration_message","sourceSessionId":packet["sourceSessionId"],
            "sourceHostId":packet["sourceHostId"],"message":packet["message"],"wake":packet["wake"]})).await
    }

    async fn orchestration_detach(&self, runtime: &str) -> Result<Value> {
        self.registry().attachments.remove(runtime);
        let session = self.registry().subscriptions.get(runtime).cloned();
        if let Some(session) = session {
            self.detach(&json!({"preserveRunning":true}), runtime, &session).await
        } else { Ok(Value::Null) }
    }

    fn ownership_drained(&self, packet: &Value) -> Value {
        if let Some(sender) = self.registry().drains.remove(&text(packet, "requestId")) {
            let result = packet["error"]
                .as_str()
                .filter(|error| !error.is_empty())
                .map(|error| Err(error.into()))
                .unwrap_or(Ok(()));
            let _ = sender.send(result);
        }
        Value::Null
    }

    async fn begin_mutation(&self, packet: &Value) -> Result<Value> {
        let operation = text(packet, "operation");
        let guard = self.ownership().begin(&text(packet,"sessionId"), &text(packet,"clientId"), &json!({"mutation":operation!="save_diffs","message":operation=="message","archive":operation=="archive","path":packet["sessionPath"],"archived":packet["archived"]})).await?;
        if !guard.owned {
            return Err(ownership_error());
        }
        let token = Uuid::new_v4().to_string();
        self.registry().guards.insert(token.clone(), (guard, operation));
        Ok(json!({"token":token}))
    }

    fn end_mutation(&self, packet: &Value) -> Result<Value> {
        let guard = self.registry().guards.remove(&text(packet, "token"));
        if let Some((guard, operation)) = guard {
            if operation == "restore" {
                return guard.restore_finished(self.ownership(), packet["restoredPath"].as_str()).map(|()| Value::Null);
            }
            guard.release(
                self.ownership(),
                flag(packet, "success") && matches!(operation.as_str(), "delete" | "archive"),
            )?;
        }
        Ok(Value::Null)
    }

    async fn retire(&self, packet: &Value) -> Result<Value> {
        let session = {
            let registry = self.registry();
            registry.sessions.get(&text(packet, "sessionKey")).cloned().or_else(|| {
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
            if flag(packet, "archive") {
                self.release_owned_session(&session.identity.clone(), "archive", session).await?;
            } else {
                session.retire().await?;
            }
        }
        Ok(Value::Null)
    }

    async fn direct_session_command(&self, packet: &Value) -> Result<Value> {
        let session = self
            .registry()
            .sessions
            .get(&text(packet, "sessionKey"))
            .cloned()
            .ok_or("Conversation is no longer running")?;
        session.execute(packet["command"].clone()).await
    }

    async fn runtime_command(self: &Arc<Self>, packet: Value, runtime: &str) -> Result<Value> {
        let name = kind(&packet);
        if name == "command" && packet["command"]["type"] == "take_ownership" {
            return self.take_ownership(runtime).await;
        }
        let readonly = self.registry().readonly.get(runtime).cloned();
        if let Some(target) = readonly {
            return self.readonly_command(&packet, target).await;
        }
        let session = self.registry().subscriptions.get(runtime).cloned();
        let Some(session) = session else {
            if name == "detach" {
                return Ok(json!({"stopped":false}));
            }
            return Err("Pi is not running".into());
        };
        if name == "detach" {
            return self.detach(&packet, runtime, &session).await;
        }
        if name == "presence" {
            session.presence(runtime, packet["presence"].clone());
            let presence = &packet["presence"];
            if flag(presence, "visible") && flag(presence, "focused") && presence["htmlPreviewSize"].is_number() {
                session.raw(json!({"type":"html_preview_viewport","size":presence["htmlPreviewSize"]})).await?;
            }
            return Ok(Value::Null);
        }
        if name == "command" && packet["command"]["type"] == "reload_agents" {
            return self.reload_agents(runtime, &text(&packet["command"], "sessionId")).await;
        }
        self.session_command(session, runtime, packet["command"].clone()).await
    }

    async fn take_ownership(self: &Arc<Self>, runtime: &str) -> Result<Value> {
        let mut target = self
            .registry()
            .attachments
            .get(runtime)
            .map(|value| (**value).clone())
            .ok_or("This conversation has been deleted or closed")?;
        if flag(&target["presence"], "readOnly") {
            return Err("This view is read-only".into());
        }
        target["takeOwnership"] = json!(true);
        self.attach(target).await
    }

    async fn detach(&self, packet: &Value, runtime: &str, session: &Session) -> Result<Value> {
        self.registry().subscriptions.remove(runtime);
        session.detach_view(runtime);
        let result = session
            .finish_detach(flag(packet, "discardBlank"), flag(packet, "preserveRunning"))
            .await;
        self.release_unused(session).await?;
        Ok(result)
    }
}
