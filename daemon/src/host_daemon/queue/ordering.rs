use super::{array, flag, json, text, Value, Uuid};

pub(super) fn cleared_messages(cleared: &Value, originals: &[Value], id: &str, behavior: &str) -> Vec<Value> {
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

pub(super) fn queue_neighbor(pending: &[Value], target: &Value, action: &Value, behavior: &str) -> Option<String> {
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

pub(super) fn move_item(items: &mut Vec<Value>, id: &str, neighbor: &str, action: &Value) {
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
