use super::*;

impl Session {
    pub async fn reconcile(&self, retry: bool) {
        if retry {
            self.state().configuration_error = None;
        }
        if self.transient() || self.closed() || self.stopping() || !self.settings_pending() {
            return;
        }
        let _configuration = self.configuration_gate.lock().await;
        if self.state().configuration_error.is_some() || self.busy(&Value::Null) || !self.settings_pending() {
            return;
        }
        self.state().configuring = true;
        let result = self.apply_configuration().await;
        if let Err(error) = result {
            self.configuration_failed(&error);
        }
        self.state().configuring = false;
        self.publish(json!({"type":"settings_pending","pending":self.settings_pending()}), None);
    }

    fn configuration_failed(&self, error: &str) {
        if self.closed() || self.stopping() || self.busy(&Value::Null) {
            return;
        }
        let message = format!("Saved settings could not be applied: {error}. Save again or reopen the conversation to retry.");
        self.state().configuration_error = Some(message.clone());
        self.publish(json!({"type":"extension_error","error":message}), None);
        if self.views().is_empty() {
            self.host
                .output(json!({"type":"diagnostic","line":format!("Could not apply settings to {}: {error}",self.key())}));
        }
    }

    async fn apply_configuration(&self) -> Result<()> {
        let _gate = self.queue.gate.lock().await;
        while !self.closed() && !self.stopping() && self.settings_pending() {
            let observed = self.raw(json!({"type":"get_state"})).await?;
            if self.busy(&observed) {
                return Ok(());
            }
            let Some(configuration) = self.host.configuration() else {
                return Ok(());
            };
            let revision = configuration["agentRevision"].as_u64().unwrap_or(0);
            let reload = self.state().agent_revision < revision;
            self.execute_worker(
                json!({"type":"runtime_settings","settings":configuration["settings"],"agentRevision":revision,"reloadAgents":reload}),
            )
            .await?;
            self.apply_automatic_options(&configuration).await?;
            {
                let mut state = self.state();
                state.agent_revision = revision;
                state.applied_configuration = Some(configuration);
            }
            self.publish(json!({"type":"settings_applied"}), None);
        }
        Ok(())
    }

    async fn apply_automatic_options(&self, configuration: &Value) -> Result<()> {
        let (compaction, retry) = {
            let state = self.state();
            (state.auto_compaction, state.auto_retry)
        };
        if compaction != configuration["autoCompaction"].as_bool() {
            self.execute_worker(json!({"type":"set_auto_compaction","enabled":configuration["autoCompaction"]}))
                .await?;
        }
        if retry != configuration["autoRetry"].as_bool() {
            self.execute_worker(json!({"type":"set_auto_retry","enabled":configuration["autoRetry"]}))
                .await?;
        }
        Ok(())
    }
}
