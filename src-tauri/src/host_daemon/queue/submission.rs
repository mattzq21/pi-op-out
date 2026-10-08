use super::{json, text, Result, SessionQueue, Uuid, Value};

impl SessionQueue {
    pub fn question_response(&self, request: &str) -> Option<Value> {
        self.state().unconsumed.iter().find(|item| item["questionResponse"]["requestId"] == request)
            .and_then(|item| item.get("questionResponse")).cloned()
    }

    pub(super) async fn enqueue(&self, command: Value, name: &str) -> Result<Value> {
        let question = command["questionResponse"]["requestId"].as_str();
        let id = question.map(|request| format!("question:{request}")).unwrap_or_else(|| Uuid::new_v4().to_string());
        if self.state().unconsumed.iter().any(|item| text(item, "id") == id || item["questionResponse"]["requestId"].as_str().is_some_and(|request| Some(request) == question)) { return Ok(Value::Null); }
        let mut pending = json!({"id":id,"message":command["message"],"behavior":if name == "steer" { "steer" } else { "followUp" }});
        for field in ["images", "questionResponse"] {
            if let Some(value) = command.get(field) { pending[field] = value.clone(); }
        }
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
