use super::*;

impl Host {
    pub async fn handle(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let runtime = text(&packet, "runtimeId");
        let name = kind(&packet);
        if name == "detach" {
            self.registry().attachments.remove(&runtime);
        }
        match name {
            "agent_definitions" => return Ok(self.registry().agent_definitions.clone()),
            "command" if packet["command"]["type"] == "reload_agents" => return self.reload_agents().await,
            "conversation_owner" => return self.ownership().owns(&text(&packet, "sessionId"), &text(&packet, "clientId")).map(Value::Bool),
            "provider_auth" | "provider_auth_cancel_owner" => return self.services.handle(packet).await,
            "ownership_drained" => return Ok(self.ownership_drained(&packet)),
            "conversation_mutation" => return self.begin_mutation(&packet).await,
            "conversation_mutation_end" => return self.end_mutation(&packet),
            "configure" | "attach" | "shutdown" => return self.lifecycle(packet).await,
            "retire" => return self.retire(&packet).await,
            "session_command" => return self.direct_session_command(&packet).await,
            _ => {}
        }
        self.runtime_command(packet, &runtime).await
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
            session.retire().await?;
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
            return Ok(Value::Null);
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
