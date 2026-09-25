use super::*;

struct Attachment {
    runtime: String,
    packet: Arc<Value>,
    spec: LaunchSpec,
    identity: String,
    path: Option<String>,
}

impl Host {
    pub(super) async fn attach(self: &Arc<Self>, packet: Value) -> Result<Value> {
        let attachment = Attachment::new(self, packet)?;
        if flag(&attachment.packet["presence"], "readOnly") {
            return attachment.readonly(self);
        }
        let guard = attachment.ownership(self).await?;
        let owned = guard.owned;
        let mut opened = None;
        let result = attachment.open(self, &guard, &mut opened).await;
        let released = guard.release(self.ownership(), false);
        attachment.cleanup(self, opened, owned).await?;
        released.and(result)
    }
}

impl Attachment {
    fn new(host: &Host, packet: Value) -> Result<Self> {
        let runtime = text(&packet, "runtimeId");
        let packet = Arc::new(packet);
        host.registry().attachments.insert(runtime.clone(), packet.clone());
        let spec: LaunchSpec = serde_json::from_value(packet["spec"].clone()).map_err(|error| error.to_string())?;
        let identity = spec.identity(&text(&packet, "sessionKey"))?;
        let path = spec.argument("--session").map(str::to_owned);
        let attachment = Self {
            runtime,
            packet,
            spec,
            identity,
            path,
        };
        attachment.assert_current(host)?;
        Ok(attachment)
    }

    fn assert_current(&self, host: &Host) -> Result<()> {
        if host
            .registry()
            .attachments
            .get(&self.runtime)
            .is_some_and(|current| Arc::ptr_eq(current, &self.packet))
        {
            Ok(())
        } else {
            Err("The conversation was closed while attaching".into())
        }
    }

    fn readonly(&self, host: &Host) -> Result<Value> {
        if self.path.is_none()
            || host
                .ownership()
                .locate(&self.identity, self.path.as_deref(), false, true)?
                .is_none()
        {
            return Err("This conversation has been deleted or archived".into());
        }
        self.assert_current(host)?;
        Ok(self.attach_readonly(host))
    }

    fn attach_readonly(&self, host: &Host) -> Value {
        host.registry().readonly.insert(
            self.runtime.clone(),
            ReadonlyView {
                id: self.identity.clone(),
                path: self.path.clone(),
            },
        );
        json!({"attached":true,"owned":false})
    }

    async fn ownership(&self, host: &Host) -> Result<Guard> {
        if flag(&self.packet, "ephemeral") {
            return Ok(Guard::ephemeral());
        }
        host.ownership()
            .begin(
                &self.identity,
                &text(&self.packet, "clientId"),
                &json!({"take":self.packet["takeOwnership"],"path":self.path,"create":self.path.is_none()}),
            )
            .await
    }

    async fn open(&self, host: &Arc<Host>, guard: &Guard, opened: &mut Option<Arc<Session>>) -> Result<Value> {
        self.assert_current(host)?;
        if !guard.owned {
            return Ok(self.attach_readonly(host));
        }
        let gate = host
            .registry()
            .session_gates
            .entry(self.identity.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _creation = gate.lock().await;
        let session = self.session(host, guard).await?;
        *opened = Some(session.clone());
        session.execute(json!({"type":"get_state"})).await?;
        self.assert_current(host)?;
        host.registry().readonly.remove(&self.runtime);
        host.attach_view(&self.runtime, session.clone(), self.packet["presence"].clone());
        host.remember(&self.runtime, &session);
        host.reconcile(session.clone());
        Ok(json!({"attached":session.views().len()>1||session.submitted(),"owned":true}))
    }

    async fn session(&self, host: &Host, guard: &Guard) -> Result<Arc<Session>> {
        let mut session = host.find_session(&self.identity);
        if session.as_ref().is_some_and(|session| session.transient()) {
            return Err("This conversation branch is still being prepared".into());
        }
        if let Some(stopping) = session.as_ref().filter(|session| session.stopping()) {
            stopping.stop().await;
            session = host.find_session(&self.identity);
        }
        match session {
            Some(session) => Ok(session),
            None => host.spawn_session(self.launch(host, guard)),
        }
    }

    fn launch(&self, host: &Host, guard: &Guard) -> SessionLaunch {
        let cwd = guard
            .saved
            .as_ref()
            .and_then(|saved| saved.header["cwd"].as_str())
            .or_else(|| self.packet["cwd"].as_str())
            .map(|cwd| expand_home(cwd, &host.home).to_string_lossy().into_owned());
        let mut spec = self.spec.clone();
        if spec.env.contains_key("PIOP_REMOTE_SESSION_CLAIMS") {
            spec.env.insert("PIOP_SESSION_CWD".into(), cwd.clone().unwrap_or("~".into()));
        } else if cwd.is_some() {
            spec.cwd = cwd.clone();
        }
        SessionLaunch {
            key: self.identity.clone(),
            spec,
            timeout: Duration::from_millis(self.packet["timeout"].as_u64().unwrap_or(630000)),
            ephemeral: flag(&self.packet, "ephemeral"),
            transient: false,
            client_id: text(&self.packet, "clientId"),
            cwd,
        }
    }

    fn still_attached(&self, host: &Host, opened: Option<&Arc<Session>>) -> bool {
        let registry = host.registry();
        registry
            .subscriptions
            .get(&self.runtime)
            .is_some_and(|session| opened.is_some_and(|opened| Arc::ptr_eq(session, opened)))
            || registry
                .attachments
                .get(&self.runtime)
                .is_some_and(|current| Arc::ptr_eq(current, &self.packet))
    }

    async fn cleanup(&self, host: &Host, opened: Option<Arc<Session>>, owned: bool) -> Result<()> {
        if self.still_attached(host, opened.as_ref()) {
            return Ok(());
        }
        if let Some(session) = opened {
            if session.views().is_empty() {
                if !session.submitted() && !session.working() {
                    session.stop().await;
                } else {
                    host.release_unused(&session).await?;
                }
            }
        } else if owned {
            host.ownership()
                .release_client(&self.identity, &text(&self.packet, "clientId"), || {
                    !host
                        .registry()
                        .attachments
                        .values()
                        .any(|value| value["clientId"] == self.packet["clientId"] && value["sessionKey"] == self.packet["sessionKey"])
                })
                .await?;
        }
        Ok(())
    }
}
