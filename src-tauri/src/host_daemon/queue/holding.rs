use super::*;

pub(super) struct Clearing<'a> {
    queue: &'a SessionQueue,
    active: bool,
}

impl<'a> Clearing<'a> {
    pub(super) fn new(queue: &'a SessionQueue, command: &Value) -> Self {
        let active = kind(command) == "clear_queue";
        if active { queue.state().clearing = true; }
        Self { queue, active }
    }
}

impl Drop for Clearing<'_> {
    fn drop(&mut self) {
        if self.active { self.queue.state().clearing = false; }
    }
}

struct Holding<'a> {
    queue: &'a SessionQueue,
    originals: Vec<Value>,
    active: bool,
}

impl<'a> Holding<'a> {
    fn begin(queue: &'a SessionQueue) -> Result<Option<Self>> {
        let mut state = queue.state();
        if state.held.is_some() { return Ok(None); }
        validate_hold(&state)?;
        state.changing = true;
        Ok(Some(Self { queue, originals: state.pending.clone(), active: true }))
    }

    fn finish(mut self, cleared: &Value) -> Result<()> {
        {
            let mut state = self.queue.state();
            let originals = self.surviving(&state);
            state.held = Some(held_messages(cleared, &originals));
            state.changing = false;
        }
        self.active = false;
        self.queue.publish()
    }

    fn surviving(&self, state: &QueueState) -> Vec<Value> {
        self.originals.iter().filter(|item| {
            self.queue.storage.is_none() || state.retained.iter().any(|retained| retained["id"] == item["id"])
        }).cloned().collect()
    }

    fn recover(&self) {
        let _publication = self.queue.publication.lock().unwrap_or_else(|error| error.into_inner());
        let (event, saved) = {
            let mut state = self.queue.state();
            let mut originals = self.surviving(&state);
            for item in &mut originals { item["retry"] = json!(true); }
            state.pending.retain(|item| !originals.iter().any(|original| original["id"] == item["id"]));
            state.pending.extend(originals);
            state.changing = false;
            state.clearing = false;
            let event = state.publish();
            let saved = self.queue.persist_state(&mut state);
            (event, saved)
        };
        self.queue.executor.publish(event);
        if let Err(error) = saved { self.queue.journal_error(error); }
    }
}

impl Drop for Holding<'_> {
    fn drop(&mut self) {
        if self.active { self.recover(); }
    }
}

impl SessionQueue {
    pub(super) async fn hold(&self) -> Result<()> {
        let Some(holding) = Holding::begin(self)? else { return Ok(()); };
        let cleared = self.execute(json!({"type":"clear_queue"})).await?;
        holding.finish(&cleared)
    }
}

fn validate_hold(state: &QueueState) -> Result<()> {
    for behavior in ["steer", "followUp"] {
        for message in state.texts(behavior) {
            let saved = state.pending.iter().filter(|item| {
                !flag(item, "retry") && item["behavior"] == behavior && item["message"] == *message
            }).count();
            if saved < state.texts(behavior).iter().filter(|item| *item == message).count() {
                return Err("Cannot preserve all queued attachments while pausing. Wait for messages sent outside this window to finish first.".into());
            }
        }
    }
    Ok(())
}

fn held_messages(cleared: &Value, originals: &[Value]) -> Vec<Value> {
    let mut held = Vec::new();
    for (field, behavior) in [("steering", "steer"), ("followUp", "followUp")] {
        let texts = array(cleared, field);
        let mut matches = hold_matches(&texts, originals, behavior);
        for message in texts {
            let original = matches.get_mut(&message.to_string()).and_then(Vec::pop);
            held.push(original.unwrap_or_else(|| {
                json!({"id":Uuid::new_v4().to_string(),"message":message,"behavior":behavior,"retry":true})
            }));
        }
    }
    held
}

fn hold_matches(texts: &[Value], originals: &[Value], behavior: &str) -> std::collections::HashMap<String, Vec<Value>> {
    let mut matches = std::collections::HashMap::new();
    for message in texts {
        let count = texts.iter().filter(|item| *item == message).count();
        let candidates: Vec<_> = originals.iter().filter(|item| {
            !flag(item, "retry") && item["behavior"] == behavior && item["message"] == *message
        }).rev().take(count).cloned().collect();
        matches.insert(message.to_string(), candidates);
    }
    matches
}
