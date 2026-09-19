use super::*;

pub(super) struct MutationGuard { daemon: Arc<daemon::Daemon>, token: String, finished: bool }

impl MutationGuard {
    pub(super) fn acquire(app: &AppHandle, host_id: &str, path: &str, client_id: &str, archived: bool, operation: &str) -> Result<Self, String> {
        let settings = load_app_settings(app.clone())?;
        let path = if archived { archived_session_file(&settings, host_id, path)? } else { desktop_session_file(&settings, host_id, path)? };
        let session_id = session_identity(&settings, host_id, &path)?;
        let daemon = daemon::connect(app, &app.state::<PiRuntime>(), &app.state::<BrokerRuntime>(), &settings, host_id)?;
        let result = daemon.request(json!({"type":"conversation_mutation","sessionId":session_id,"sessionPath":path,"clientId":client_id,"archived":archived,"operation":operation}))?;
        let token = result["token"].as_str().ok_or("Conversation mutation token missing")?.to_owned();
        Ok(Self { daemon, token, finished: false })
    }

    pub(super) fn finish(mut self) -> Result<(), String> {
        self.daemon.request(json!({"type":"conversation_mutation_end","token":self.token,"success":true}))?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        if !self.finished { let _ = self.daemon.request(json!({"type":"conversation_mutation_end","token":self.token,"success":false})); }
    }
}
