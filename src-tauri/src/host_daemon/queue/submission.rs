use super::{json, text, Result, SessionQueue, Uuid, Value};

impl SessionQueue {
    pub fn question_response(&self, request: &str) -> Option<Value> {
        self.state().unconsumed.iter().find(|item| item["questionResponse"]["requestId"] == request)
            .and_then(|item| item.get("questionResponse")).cloned()
    }

    pub(super) async fn enqueue(&self, command: Value, name: &str) -> Result<Value> {
        let Some(command) = self.prepare_submission(command).await? else { return Ok(json!(false)); };
        let question = command["questionResponse"]["requestId"].as_str();
        let id = question.map(|request| format!("question:{request}")).unwrap_or_else(|| Uuid::new_v4().to_string());
        if self.state().unconsumed.iter().any(|item| text(item, "id") == id || item["questionResponse"]["requestId"].as_str().is_some_and(|request| Some(request) == question)) { return Ok(Value::Null); }
        let pending = submission_payload(&command, &id, name);
        let held = self.save_submission(&id, &pending)?;
        if held {
            self.publish();
            return Ok(Value::Null);
        }
        let result = self.deliver(&pending, question.is_none()).await;
        let rejected = {
            let mut state = self.state();
            let rejected = result.is_err() && state.failed_submission(&id);
            state.sending.remove(&id);
            rejected
        };
        self.publish();
        if result.is_err() && !rejected {
            self.report_storage_error(result.map(|_| ()));
            return Ok(Value::Null);
        }
        result
    }

    async fn prepare_submission(&self, mut command: Value) -> Result<Option<Value>> {
        if !goal_submission(&command) { return Ok(Some(command)); }
        let mut request = json!({"type":"prepare_goal_prompt","message":command["message"]});
        for field in ["images", "goalSubmissionId"] {
            if let Some(value) = command.get(field) { request[field] = value.clone(); }
        }
        let prepared = self.execute(request).await?;
        if prepared == false { return Ok(None); }
        if !prepared["message"].is_string() { return Err("Goal prompt preparation did not produce an objective".into()); }
        command["message"] = prepared["message"].clone();
        command["goalSubmissionId"] = prepared["goalSubmissionId"].clone();
        command["goalPrepared"] = json!(true);
        command.as_object_mut().map(|command| command.remove("images"));
        Ok(Some(command))
    }

    fn save_submission(&self, id: &str, pending: &Value) -> Result<bool> {
        let mut state = self.state();
        state.pending.push(pending.clone());
        if let Err(error) = self.persist(&mut state) {
            state.remove(id);
            return Err(error);
        }
        if let Some(held) = &mut state.held {
            held.push(pending.clone());
            held.sort_by_key(|item| item["behavior"] == "followUp");
            Ok(true)
        } else {
            state.sending.insert(id.into());
            Ok(false)
        }
    }
}

fn submission_payload(command: &Value, id: &str, name: &str) -> Value {
    let mut pending = json!({"id":id,"message":command["message"],"behavior":if name == "steer" { "steer" } else { "followUp" }});
    for field in ["images", "questionResponse", "goalSubmissionId", "goalPrepared"] {
        if let Some(value) = command.get(field) { pending[field] = value.clone(); }
    }
    pending
}

fn goal_objective(message: &str) -> bool {
    let Some(value) = message.trim_start().strip_prefix("/goal").filter(|value| value.starts_with(char::is_whitespace)).map(str::trim) else { return false; };
    !value.is_empty() && !matches!(value, "edit" | "clear" | "pause" | "resume" | "budget") && !value.starts_with("budget ")
}

fn goal_submission(command: &Value) -> bool {
    let message = text(command, "message");
    goal_objective(&message) || message.trim() == "/goal" && command["images"].as_array().is_some_and(|images| !images.is_empty())
}
