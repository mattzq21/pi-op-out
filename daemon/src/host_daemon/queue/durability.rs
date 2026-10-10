use super::*;

impl SessionQueue {
    pub(super) async fn execute_held_prompt(&self, mut command: Value) -> Result<Value> {
        let id = self.next_item_id()?;
        let mut item = json!({"id":id,"message":command["message"],"behavior":"followUp","deliveryStarted":true});
        if let Some(images) = command.get("images") { item["images"] = images.clone(); }
        self.retain_item(&item)?;
        command["type"] = json!("queue_prompt");
        command["queueId"] = json!(id);
        command["streamingBehavior"] = json!("followUp");
        {
            let mut state = self.state();
            state.pending.push(item);
            state.sending.insert(id.clone());
        }
        let result = self.execute(command).await;
        {
            let mut state = self.state();
            state.sending.remove(&id);
            if result.is_err() {
                if let Some(item) = state.pending.iter_mut().find(|item| item["id"] == id) { item["retry"] = json!(true); }
            }
        }
        self.publish()?;
        result
    }

    fn save_retained(&self, retained: &[Value]) -> Result<()> {
        if retained.len() > 100 { return Err("A session can have at most 100 queued items".into()); }
        if let Some(storage) = &self.storage { storage.save(retained)?; }
        Ok(())
    }

    pub(super) fn retain_item(&self, item: &Value) -> Result<()> {
        let mut state = self.state();
        let mut retained = state.retained.clone();
        update_item(&mut retained, item);
        self.save_retained(&retained)?;
        state.retained = retained;
        Ok(())
    }

    pub(super) fn forget_item(&self, id: &str) -> Result<()> {
        let mut state = self.state();
        let retained: Vec<_> = state.retained.iter().filter(|item| item["id"] != id).cloned().collect();
        self.save_retained(&retained)?;
        state.retained = retained;
        state.pending.retain(|item| item["id"] != id);
        if let Some(held) = &mut state.held { held.retain(|item| item["id"] != id); }
        Ok(())
    }

    pub(super) fn persist_state(&self, state: &mut QueueState) -> Result<()> {
        let retained = durable_messages(state);
        self.save_retained(&retained)?;
        state.retained = retained;
        Ok(())
    }

    pub(super) fn journal_error(&self, error: String) {
        self.executor.publish(json!({"type":"extension_ui_request","method":"notify","notifyType":"error","message":format!("Queued input recovery could not be updated: {error}")}));
    }

    pub(super) fn observe_consumption(&self, event: &Value) {
        if self.storage.is_none() { return; }
        if kind(event) == "message_end" && event["message"]["role"] == "user" {
            if let Err(error) = self.record_consumption(&event["message"]) { self.journal_error(error); }
        }
        if matches!(kind(event), "message_end" | "agent_settled") {
            if let Err(error) = self.confirm_consumed() { self.journal_error(error); }
        }
    }

    fn record_consumption(&self, message: &Value) -> Result<()> {
        if !message["timestamp"].is_number() { return Ok(()); }
        let mut state = self.state();
        let mut retained = state.retained.clone();
        let candidates = consumption_candidates(&state, &retained, message);
        if let [index] = candidates.as_slice() {
            let item = &mut retained[*index];
            item["consumedTimestamp"] = message["timestamp"].clone();
            item["consumedContent"] = message["content"].clone();
            item["consumedInputId"] = queue_message_id(message).map_or(Value::Null, |id| json!(id));
            self.save_retained(&retained)?;
            state.retained = retained;
        }
        Ok(())
    }

    pub fn confirm_consumed(&self) -> Result<()> {
        if self.state().retained.is_empty() { return Ok(()); }
        let messages = self.executor.saved_user_messages()?;
        let mut state = self.state();
        let consumed: HashSet<_> = state.retained.iter().filter(|item| {
            messages.iter().any(|message| queue_message_id(message).is_some_and(|id| item["id"] == id)
                || item["consumedTimestamp"].is_number() && matches_recorded_consumption(item, message))
        }).map(|item| text(item, "id")).collect();
        if consumed.is_empty() { return Ok(()); }
        let retained: Vec<_> = state.retained.iter().filter(|item| !consumed.contains(&text(item, "id"))).cloned().collect();
        self.save_retained(&retained)?;
        state.retained = retained;
        state.pending.retain(|item| !consumed.contains(&text(item, "id")));
        if let Some(held) = &mut state.held { held.retain(|item| !consumed.contains(&text(item, "id"))); }
        Ok(())
    }
}

pub(super) fn durable_messages(state: &QueueState) -> Vec<Value> {
    let mut retained = Vec::new();
    for item in state.pending.iter().chain(state.held.iter().flatten()) { update_item(&mut retained, item); }
    for item in &state.retained {
        if let Some(current) = retained.iter_mut().find(|current| current["id"] == item["id"]) {
            preserve_delivery(current, item);
        } else {
            retained.push(item.clone());
        }
    }
    retained
}

fn queue_message_id(message: &Value) -> Option<&str> {
    message["piopQueueId"].as_str().or_else(|| message["piopQueueInputId"].as_str())
}

fn update_item(items: &mut Vec<Value>, item: &Value) {
    if let Some(saved) = items.iter_mut().find(|saved| saved["id"] == item["id"]) {
        let previous = saved.clone();
        *saved = item.clone();
        preserve_delivery(saved, &previous);
    } else {
        items.push(item.clone());
    }
}

fn preserve_delivery(item: &mut Value, saved: &Value) {
    for field in ["consumedTimestamp", "consumedContent", "consumedInputId", "deliveryStarted"] {
        if item.get(field).is_none() {
            if let Some(value) = saved.get(field) { item[field] = value.clone(); }
        }
    }
}

fn consumption_candidates(state: &QueueState, retained: &[Value], message: &Value) -> Vec<usize> {
    if let Some(id) = queue_message_id(message) {
        return retained.iter().enumerate().filter(|(_, item)| {
            item["id"] == id && flag(item, "deliveryStarted") && item["consumedTimestamp"].is_null()
        }).map(|(index, _)| index).collect();
    }
    if retained.iter().any(|item| item["consumedTimestamp"] == message["timestamp"]) { return Vec::new(); }
    let content = message_text(&message["content"], "");
    retained.iter().enumerate().filter(|(_, item)| {
        match_consumed(item, message, &content) && available_for_consumption(state, item)
    }).map(|(index, _)| index).collect()
}

fn matches_recorded_consumption(item: &Value, message: &Value) -> bool {
    let identified = item["consumedInputId"].as_str().is_none_or(|id| queue_message_id(message) == Some(id));
    identified && message["timestamp"] == item["consumedTimestamp"] && message["content"] == item["consumedContent"]
}

fn match_consumed(item: &Value, message: &Value, content: &str) -> bool {
    if flag(item, "retry") || !flag(item, "deliveryStarted") || !item["consumedTimestamp"].is_null() || item["message"] != content {
        return false;
    }
    let images = array(item, "images");
    let actual: Vec<_> = array(message, "content").into_iter().filter(|part| part["type"] == "image").collect();
    images.len() == actual.len() && images.iter().zip(&actual).all(|(expected, received)| {
        expected["data"] == received["data"] && expected["mimeType"] == received["mimeType"]
    })
}

fn available_for_consumption(state: &QueueState, item: &Value) -> bool {
    let id = text(item, "id");
    if state.held.iter().flatten().any(|held| held["id"] == id) { return false; }
    state.sending.contains(&id) || !state.pending.iter().any(|pending| pending["id"] == id)
}
