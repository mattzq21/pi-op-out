use super::{flag, json, text, QueueState, Result, SessionQueue, Value};

impl QueueState {
    fn recover_question(&mut self, item: &Value) {
        let request = &item["questionResponse"]["requestId"];
        if self.retained.iter().any(|saved| saved["id"] == item["id"] || saved["questionResponse"]["requestId"] == *request) { return; }
        let matched = self.retained.iter().find(|saved| saved["message"] == item["message"] && saved.get("questionResponse").is_none())
            .map(|saved| text(saved, "id"));
        if let Some(id) = matched {
            for saved in self.pending.iter_mut().chain(&mut self.retained).chain(self.held.iter_mut().flatten()) {
                if saved["id"] == id { saved["questionResponse"] = item["questionResponse"].clone(); saved["recovered"] = json!(true); }
            }
        } else {
            self.pending.push(item.clone());
            self.retained.push(item.clone());
        }
    }
}

impl SessionQueue {
    pub fn recover_question_answers(&self, answers: &Value) {
        {
            let mut state = self.state();
            for item in answers.as_array().into_iter().flatten().filter(|item| valid_answer(item)) {
                state.recover_question(item);
            }
        }
        self.report_storage_error(self.publish());
    }

    pub(super) async fn acknowledge_question_removal(&self, item: &Value, action: &str) -> Result<()> {
        if action != "remove" || !item["questionResponse"].is_object() { return Ok(()); }
        let mut command = item["questionResponse"].clone();
        command["action"] = json!("resolve");
        command["queueId"] = item["id"].clone();
        self.execute(command).await.map(|_| ())
    }
}

fn valid_answer(item: &Value) -> bool {
    item["message"].is_string() && item["behavior"] == "followUp" && flag(item, "retry") && flag(item, "recovered")
        && item["questionResponse"]["type"] == "answer_question" && item["questionResponse"]["value"].is_string()
        && item["questionResponse"]["requestId"].as_str().is_some_and(|request| item["id"] == format!("question:{request}"))
}
