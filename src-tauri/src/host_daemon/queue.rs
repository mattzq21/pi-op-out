use super::protocol::{array, flag, kind, message_text, text, Result};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;


pub(super) trait Execution: Send + Sync {
    fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>>;
    fn publish(&self, event: Value);
}

#[derive(Default)]
struct QueueState {
    pending: Vec<Value>,
    held: Option<Vec<Value>>,
    steering: Vec<Value>,
    follow_up: Vec<Value>,
    changing: bool,
    clearing: bool,
    sending: HashSet<String>,
    awaiting_steering: Vec<Value>,
    steering_timestamps: HashSet<String>,
    inference_revision: u64,
}

impl QueueState {
    fn texts(&self, behavior: &str) -> &[Value] {
        if behavior == "steer" {
            &self.steering
        } else {
            &self.follow_up
        }
    }

    fn view(&self, pending: &[Value]) -> Value {
        let mut steering = self.steering.clone();
        let mut follow_up = self.follow_up.clone();
        for item in self.held.iter().flatten().filter(|item| !flag(item, "retry")) {
            if item["behavior"] == "steer" {
                steering.push(item["message"].clone());
            } else if item["behavior"] == "followUp" {
                follow_up.push(item["message"].clone());
            }
        }
        let pending: Vec<_> = pending.iter().cloned().map(|mut item| {
            if let Some(images) = item["images"].as_array_mut() {
                for image in images { if let Some(fields) = image.as_object_mut() { fields.remove("data"); } }
            }
            item
        }).collect();
        json!({"type":"queue_update","steering":steering,"followUp":follow_up,"pendingMessages":pending})
    }

    fn publish(&mut self) -> Value {
        let held_ids: HashSet<_> = self.held.iter().flatten().map(|item| text(item, "id")).collect();
        let mut available: Vec<_> = self
            .pending
            .iter()
            .filter(|item| !held_ids.contains(&text(item, "id")))
            .cloned()
            .collect();
        for behavior in ["steer", "followUp"] {
            let texts = self.texts(behavior);
            let unique: HashSet<_> = texts.iter().collect();
            for message in unique {
                let matches: Vec<_> = available
                    .iter()
                    .filter(|item| {
                        !flag(item, "retry")
                            && !self.sending.contains(&text(item, "id"))
                            && item["behavior"] == behavior
                            && &item["message"] == message
                    })
                    .map(|item| text(item, "id"))
                    .collect();
                let count = texts.iter().filter(|item| *item == message).count();
                let stale: HashSet<_> = matches.iter().take(matches.len().saturating_sub(count)).collect();
                available.retain(|item| !stale.contains(&text(item, "id")));
            }
        }
        let mut pending = Vec::new();
        for behavior in ["steer", "followUp"] {
            for message in self.texts(behavior) {
                if let Some(index) = available
                    .iter()
                    .position(|item| !flag(item, "retry") && item["behavior"] == behavior && item["message"] == *message)
                {
                    pending.push(available.remove(index));
                }
            }
        }
        pending.extend(self.held.iter().flatten().cloned());
        pending.extend(available.iter().filter(|item| flag(item, "retry")).cloned());
        self.pending = pending.clone();
        self.pending.extend(
            available
                .into_iter()
                .filter(|item| !flag(item, "retry") && self.sending.contains(&text(item, "id"))),
        );
        self.view(&pending)
    }

    fn receive_queue(&mut self, event: &Value) {
        if !self.clearing {
            let mut remaining = array(event, "steering");
            for message in &self.steering {
                if let Some(index) = remaining.iter().position(|item| item == message) {
                    remaining.remove(index);
                } else {
                    self.awaiting_steering.push(message.clone());
                }
            }
        }
        for (field, behavior) in [("steering", "steer"), ("followUp", "followUp")] {
            let mut before = self.texts(behavior).to_vec();
            let added: Vec<_> = array(event, field)
                .into_iter()
                .filter(|message| {
                    if let Some(index) = before.iter().position(|item| item == message) {
                        before.remove(index);
                        false
                    } else {
                        true
                    }
                })
                .collect();
            let sending: Vec<_> = self
                .pending
                .iter()
                .enumerate()
                .filter(|(_, item)| self.sending.contains(&text(item, "id")) && item["behavior"] == behavior)
                .map(|(index, _)| index)
                .collect();
            if added.len() == 1 && sending.len() == 1 {
                self.pending[sending[0]]["message"] = added[0].clone();
            }
        }
        self.steering = array(event, "steering");
        self.follow_up = array(event, "followUp");
    }

    fn tag_message(&mut self, event: &mut Value) {
        if !matches!(kind(event), "message_start" | "message_end")
            || event["message"]["role"] != "user"
            || !event["message"]["timestamp"].is_number()
        {
            return;
        }
        let timestamp = event["message"]["timestamp"].to_string();
        if kind(event) == "message_start" {
            let message = message_text(&event["message"]["content"], "");
            let index = self.awaiting_steering.iter().position(|item| item == &message);
            let sending = self
                .pending
                .iter()
                .any(|item| self.sending.contains(&text(item, "id")) && item["behavior"] == "steer" && item["message"] == message);
            if index.is_some() || sending {
                self.steering_timestamps.insert(timestamp.clone());
            }
            if let Some(index) = index {
                self.awaiting_steering.remove(index);
            }
        }
        if self.steering_timestamps.contains(&timestamp) {
            event["message"]["deliveryBehavior"] = json!("steer");
        }
    }

    fn failed_held(&mut self) -> Value {
        let mut held = self.held.take().unwrap_or_default();
        for item in &mut held {
            item["retry"] = json!(true);
        }
        self.pending.retain(|item| !held.iter().any(|saved| saved["id"] == item["id"]));
        self.pending.extend(held);
        self.publish()
    }
}

pub(super) struct SessionQueue {
    state: Mutex<QueueState>,
    publication: Mutex<()>,
    pub gate: AsyncMutex<()>,
    executor: Arc<dyn Execution>,
}

impl SessionQueue {
    pub fn new(executor: Arc<dyn Execution>, pending: Vec<Value>) -> Self {
        Self {
            state: Mutex::new(QueueState {
                pending,
                ..QueueState::default()
            }),
            gate: AsyncMutex::new(()),
            publication: Mutex::new(()),
            executor,
        }
    }

    fn state(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    pub fn view(&self) -> Value {
        let state = self.state();
        state.view(&state.pending)
    }
    pub fn pending(&self) -> Vec<Value> {
        self.state().pending.clone()
    }
    pub fn held(&self) -> bool {
        self.state().held.is_some()
    }
    pub fn held_count(&self) -> usize {
        self.state().held.as_ref().map_or(0, Vec::len)
    }
    pub fn is_empty(&self) -> bool {
        self.state().pending.is_empty()
    }
    fn publish(&self) {
        let _publication = self.publication.lock().unwrap_or_else(|error| error.into_inner());
        let event = self.state().publish();
        self.executor.publish(event);
    }

    pub fn tag_entries(&self, entries: &mut Value) {
        let state = self.state();
        for entry in entries["entries"].as_array_mut().into_iter().flatten() {
            if entry["message"]["role"] == "user" && state.steering_timestamps.contains(&entry["message"]["timestamp"].to_string()) {
                entry["message"]["deliveryBehavior"] = json!("steer");
            }
        }
    }

    pub fn receive(&self, mut event: Value) {
        let _publication = self.publication.lock().unwrap_or_else(|error| error.into_inner());
        let queue_event = {
            let mut state = self.state();
            if kind(&event) == "agent_start" {
                state.inference_revision += 1;
            }
            if kind(&event) == "disconnected" {
                for item in &mut state.pending {
                    item["retry"] = json!(true);
                }
                state.held = None;
                state.steering.clear();
                state.follow_up.clear();
                Some(state.publish())
            } else if kind(&event) == "queue_update" {
                state.receive_queue(&event);
                if state.changing {
                    return;
                }
                Some(state.publish())
            } else {
                None
            }
        };
        if let Some(queue_event) = queue_event {
            self.executor.publish(queue_event);
        }
        if kind(&event) == "queue_update" {
            return;
        }
        {
            let mut state = self.state();
            state.tag_message(&mut event);
            if kind(&event) == "agent_settled" {
                state.awaiting_steering.clear();
            }
        }
        self.executor.publish(event);
    }

    async fn execute(&self, command: Value) -> Result<Value> {
        let clearing = kind(&command) == "clear_queue";
        if clearing {
            self.state().clearing = true;
        }
        let result = self.executor.execute(command).await;
        if clearing {
            self.state().clearing = false;
        }
        result
    }

    async fn deliver(&self, item: &Value) -> Result<Value> {
        let id = text(item, "id");
        self.state().sending.insert(id.clone());
        let mut command = json!({"type":"prompt","message":item["message"],"streamingBehavior":item["behavior"]});
        if item["images"].as_array().is_some_and(|images| !images.is_empty()) {
            command["images"] = item["images"].clone();
        }
        let result = self.execute(command).await;
        self.state().sending.remove(&id);
        result
    }

    async fn hold(&self) -> Result<()> {
        let originals = {
            let mut state = self.state();
            if state.held.is_some() {
                return Ok(());
            }
            for behavior in ["steer", "followUp"] {
                for message in state.texts(behavior) {
                    let saved = state
                        .pending
                        .iter()
                        .filter(|item| !flag(item, "retry") && item["behavior"] == behavior && item["message"] == *message)
                        .count();
                    if saved < state.texts(behavior).iter().filter(|item| *item == message).count() {
                        return Err("Cannot preserve all queued attachments while pausing. Wait for messages sent outside this window to finish first.".into());
                    }
                }
            }
            state.changing = true;
            state.pending.clone()
        };
        let result = self.execute(json!({"type":"clear_queue"})).await;
        {
            let mut state = self.state();
            if let Ok(cleared) = &result {
                let mut held = Vec::new();
                for (field, behavior) in [("steering", "steer"), ("followUp", "followUp")] {
                    let texts = array(cleared, field);
                    let mut matches = std::collections::HashMap::new();
                    for message in &texts {
                        let count = texts.iter().filter(|item| *item == message).count();
                        let candidates: Vec<_> = originals
                            .iter()
                            .filter(|item| !flag(item, "retry") && item["behavior"] == behavior && item["message"] == *message)
                            .cloned()
                            .collect();
                        let candidates = candidates[candidates.len().saturating_sub(count)..].to_vec();
                        matches.insert(message.to_string(), candidates);
                    }
                    for message in &texts {
                        let original =
                            matches
                                .get_mut(&message.to_string())
                                .and_then(|items| if items.is_empty() { None } else { Some(items.remove(0)) });
                        held.push(original.unwrap_or_else(
                            || json!({"id":Uuid::new_v4().to_string(),"message":message,"behavior":behavior,"retry":true}),
                        ));
                    }
                }
                state.held = Some(held);
            }
            state.changing = false;
        }
        self.publish();
        result.map(|_| ())
    }

    fn held_failed(&self) {
        let _publication = self.publication.lock().unwrap_or_else(|error| error.into_inner());
        let event = self.state().failed_held();
        self.executor.publish(event);
    }

    async fn restore(&self) -> Result<()> {
        if !self.held() {
            return Ok(());
        }
        loop {
            let item = {
                let mut state = self.state();
                state
                    .held
                    .as_mut()
                    .and_then(|held| if held.is_empty() { None } else { Some(held.remove(0)) })
            };
            let Some(item) = item else {
                break;
            };
            if flag(&item, "retry") {
                continue;
            }
            if let Err(error) = self.deliver(&item).await {
                self.state().held.get_or_insert_with(Vec::new).insert(0, item);
                self.held_failed();
                return Err(error);
            }
            self.publish();
        }
        self.state().held = None;
        self.publish();
        Ok(())
    }

    pub async fn command(&self, command: Value) -> Result<Value> {
        let name = kind(&command).to_owned();
        if name == "abort" {
            let abort = async {
                let (cancelled, _gate) = tokio::join!(self.execute(json!({"type":"cancel_preparation"})), self.gate.lock());
                cancelled?;
                self.hold().await?;
                self.execute(command).await
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), abort).await.unwrap_or_else(|_| Err("Pi command timed out".into()));
            return self.stop(result).await;
        }
        if name == "compact" || name.starts_with("get_") {
            return self.execute(command).await;
        }
        let _gate = self.gate.lock().await;
        self.serial_command(command, &name).await
    }

    async fn serial_command(&self, command: Value, name: &str) -> Result<Value> {
        if name == "pause" {
            self.hold().await?;
            let result = self.execute(command).await;
            if result.is_err() {
                self.held_failed();
            }
            return result;
        }
        if name == "resume" || name == "prompt" && self.held() && command["message"].is_string() {
            return self.resume_command(command, name).await;
        }
        if !matches!(name, "steer" | "follow_up") {
            return self.execute(command).await;
        }
        self.enqueue(command, name).await
    }

    async fn resume_command(&self, command: Value, name: &str) -> Result<Value> {
        let revision = self.state().inference_revision;
        let slash = text(&command, "message").starts_with('/');
        let result = self.execute(command).await?;
        if name == "resume" || !slash || self.state().inference_revision != revision {
            self.restore().await?;
        }
        Ok(result)
    }

    async fn enqueue(&self, command: Value, name: &str) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let mut pending = json!({"id":id,"message":command["message"],"behavior":if name == "steer" { "steer" } else { "followUp" }});
        if let Some(images) = command.get("images") {
            pending["images"] = images.clone();
        }
        let held = {
            let mut state = self.state();
            state.pending.push(pending.clone());
            if let Some(held) = &mut state.held {
                held.push(pending.clone());
                held.sort_by_key(|item| item["behavior"] == "followUp");
                true
            } else {
                state.sending.insert(id.clone());
                false
            }
        };
        if held {
            self.publish();
            return Ok(Value::Null);
        }
        let result = self.deliver(&pending).await;
        {
            let mut state = self.state();
            if result.is_err() {
                state.pending.retain(|item| item["id"] != id);
            }
            state.sending.remove(&id);
        }
        self.publish();
        result
    }

    async fn stop(&self, result: Result<Value>) -> Result<Value> {
        match result {
            Err(error) if error == "Pi command timed out" => {
                self.execute(json!({"type":"force_stop"})).await?;
                {
                    let mut state = self.state();
                    for item in &mut state.pending {
                        item["retry"] = json!(true);
                    }
                    state.held = None;
                    state.changing = false;
                    state.clearing = false;
                    state.steering.clear();
                    state.follow_up.clear();
                    state.awaiting_steering.clear();
                }
                self.publish();
                self.executor.publish(json!({"type":"disconnected"}));
                Ok(Value::Null)
            }
            result => result,
        }
    }

    pub async fn change_pending(&self, id: &str, action: Value) -> Result<Value> {
        let cancelling = action == "remove" && self.state().sending.contains(id);
        let _gate = if cancelling {
            let (cancelled, gate) = tokio::join!(self.execute(json!({"type":"cancel_preparation"})), self.gate.lock());
            cancelled?;
            gate
        } else {
            self.gate.lock().await
        };
        let (target, behavior, neighbor) = {
            let state = self.state();
            let Some(target) = state.pending.iter().find(|item| item["id"] == id).cloned() else {
                return Ok(Value::Null);
            };
            let behavior = action.as_str().unwrap_or("reorder").to_owned();
            let moving = matches!(behavior.as_str(), "moveUp" | "moveDown" | "reorder");
            let neighbor = queue_neighbor(&state.pending, &target, &action, &behavior);
            if moving && (flag(&target, "retry") || neighbor.is_none()) {
                return Ok(Value::Null);
            }
            (target, behavior, neighbor)
        };
        if cancelling {
            return self.change_live(id, "remove", None, &action).await;
        }
        if self.change_held(id, &behavior, neighbor.as_deref(), &action) {
            self.publish();
            return Ok(Value::Null);
        }
        if flag(&target, "retry") {
            return self.retry(id, target, &behavior).await;
        }
        self.change_live(id, &behavior, neighbor.as_deref(), &action).await
    }

    fn change_held(&self, id: &str, behavior: &str, neighbor: Option<&str>, action: &Value) -> bool {
        let mut state = self.state();
        if let Some(held) = state.held.as_mut().filter(|held| held.iter().any(|item| item["id"] == id)) {
            if behavior == "remove" {
                held.retain(|item| item["id"] != id);
            } else if matches!(behavior, "steer" | "followUp") {
                if let Some(target) = held.iter_mut().find(|item| item["id"] == id) {
                    target["behavior"] = json!(behavior);
                    target["retry"] = json!(false);
                }
            } else if let Some(neighbor) = neighbor {
                move_item(held, id, neighbor, action);
            }
            held.sort_by_key(|item| item["behavior"] == "followUp");
            true
        } else {
            false
        }
    }

    async fn retry(&self, id: &str, mut target: Value, behavior: &str) -> Result<Value> {
        if behavior == "remove" {
            self.state().pending.retain(|item| item["id"] != id);
            self.publish();
            return Ok(Value::Null);
        }
        target["retry"] = json!(false);
        target["behavior"] = json!(if behavior == "steer" { "steer" } else { "followUp" });
        if let Some(item) = self.state().pending.iter_mut().find(|item| item["id"] == id) {
            *item = target.clone();
        }
        let result = self.deliver(&target).await;
        if result.is_err() {
            if let Some(item) = self.state().pending.iter_mut().find(|item| item["id"] == id) {
                item["retry"] = json!(true);
            }
        }
        self.publish();
        result.map(|_| Value::Null)
    }

    async fn change_live(&self, id: &str, behavior: &str, neighbor: Option<&str>, action: &Value) -> Result<Value> {
        let originals = {
            let mut state = self.state();
            let snapshot: Vec<_> = state.steering.iter().chain(&state.follow_up).collect();
            let unique: HashSet<_> = snapshot.iter().copied().collect();
            if unique.len() != snapshot.len()
                || snapshot.iter().any(|message| {
                    !state
                        .pending
                        .iter()
                        .any(|item| !flag(item, "retry") && item["message"] == **message)
                })
            {
                return Err("This queue contains messages that cannot be safely switched. Use Ctrl+Enter to steer a new message.".into());
            }
            state.changing = true;
            state.pending.clone()
        };
        let result = self.replace_live(id, behavior, neighbor, action, originals).await;
        self.state().changing = false;
        self.publish();
        result
    }

    async fn replace_live(&self, id: &str, behavior: &str, neighbor: Option<&str>, action: &Value, originals: Vec<Value>) -> Result<Value> {
        let cleared = self.execute(json!({"type":"clear_queue"})).await?;
        let mut remaining = cleared_messages(&cleared, &originals, id, behavior);
        if let Some(neighbor) = neighbor {
            move_item(&mut remaining, id, neighbor, action);
        }
        if behavior == "remove" {
            remaining.retain(|item| item["id"] != id);
        }
        {
            let mut state = self.state();
            state.pending = originals.into_iter().filter(|item| flag(item, "retry")).collect();
            state.pending.extend(remaining.clone());
        }
        if remaining.iter().any(|item| flag(item, "retry")) {
            self.mark_retry(&remaining);
            return Err("Another source changed the queue while switching. Pending text has been kept for retry; reattach any images from messages sent outside this window.".into());
        }
        for (index, item) in remaining.iter().enumerate() {
            if let Err(error) = self.deliver(item).await {
                self.mark_retry(&remaining[index..]);
                return Err(error);
            }
        }
        Ok(Value::Null)
    }

    fn mark_retry(&self, items: &[Value]) {
        for pending in &mut self.state().pending {
            if items.iter().any(|item| item["id"] == pending["id"]) {
                pending["retry"] = json!(true);
            }
        }
    }
}

fn cleared_messages(cleared: &Value, originals: &[Value], id: &str, behavior: &str) -> Vec<Value> {
    let mut remaining = Vec::new();
    for (field, mode) in [("steering", "steer"), ("followUp", "followUp")] {
        for message in array(cleared, field) {
            let mut item = originals
                .iter()
                .find(|item| !flag(item, "retry") && item["behavior"] == mode && item["message"] == message)
                .cloned()
                .unwrap_or_else(|| json!({"id":Uuid::new_v4().to_string(),"message":message,"behavior":mode,"retry":true}));
            if item["id"] == id && matches!(behavior, "steer" | "followUp") {
                item["behavior"] = json!(behavior);
            }
            remaining.push(item);
        }
    }
    remaining
}

fn queue_neighbor(pending: &[Value], target: &Value, action: &Value, behavior: &str) -> Option<String> {
    let id = &target["id"];
    let peers: Vec<_> = pending
        .iter()
        .filter(|item| !flag(item, "retry") && item["behavior"] == target["behavior"])
        .collect();
    if action.is_object() {
        return peers
            .iter()
            .find(|item| item["id"] == action["targetId"] && item["id"] != *id)
            .map(|item| text(item, "id"));
    }
    if !matches!(behavior, "moveUp" | "moveDown" | "reorder") {
        return None;
    }
    let index = peers.iter().position(|item| item["id"] == *id)?;
    let neighbor = if behavior == "moveUp" {
        index.checked_sub(1)
    } else {
        index.checked_add(1)
    }?;
    peers.get(neighbor).map(|item| text(item, "id"))
}

fn move_item(items: &mut Vec<Value>, id: &str, neighbor: &str, action: &Value) {
    let Some(from) = items.iter().position(|item| item["id"] == id) else {
        return;
    };
    let Some(to) = items.iter().position(|item| item["id"] == neighbor) else {
        return;
    };
    if action.is_object() {
        let item = items.remove(from);
        if let Some(destination) = items.iter().position(|item| item["id"] == neighbor) {
            items.insert(destination + usize::from(action["edge"] == "after"), item);
        }
    } else {
        items.swap(from, to);
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn queue_updates_keep_attachment_metadata_without_image_data() {
        let item = json!({"id":"queued","message":"inspect","behavior":"followUp","images":[{"type":"image","mimeType":"image/png","data":"private-image"}]});
        let view = QueueState::default().view(&[item]);
        assert_eq!(view["pendingMessages"][0]["id"], "queued");
        assert_eq!(view["pendingMessages"][0]["images"][0]["mimeType"], "image/png");
        assert!(view["pendingMessages"][0]["images"][0].get("data").is_none());
    }

    struct StuckPreparation;
    impl Execution for StuckPreparation {
        fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
            Box::pin(async move {
                if kind(&command) == "force_stop" { Ok(Value::Null) } else { std::future::pending().await }
            })
        }
        fn publish(&self, _event: Value) {}
    }
    #[tokio::test]
    async fn abort_escalates_even_when_preparation_and_gate_are_stuck() {
        let queue = SessionQueue::new(Arc::new(StuckPreparation), Vec::new());
        let _gate = queue.gate.lock().await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(6), queue.command(json!({"type":"abort"}))).await;
        assert!(result.is_ok(), "abort never reached force_stop");
        assert!(result.unwrap().is_ok());
    }
}
