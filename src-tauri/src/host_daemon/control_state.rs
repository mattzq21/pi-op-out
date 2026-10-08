use super::protocol::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) struct SavedControlState {
    pub is_paused: bool,
    pub needs_input: bool,
}

pub(super) fn reduce(entries: &[Value], leaf_id: Option<&str>) -> Result<SavedControlState> {
    let mut is_paused = false;
    let mut questions = HashMap::new();
    for entry in branch(entries, leaf_id) {
        if entry["type"] != "custom" {
            continue;
        }
        let data = &entry["data"];
        match entry["customType"].as_str() {
            Some("pi-desktop-pause-state") => is_paused = data["isPaused"] == true,
            Some("piop-async-question") => {
                let (id, resolved) =
                    request_state(data).ok_or("Invalid saved asynchronous question request")?;
                questions.insert(id, resolved);
            }
            _ => {}
        }
    }
    Ok(SavedControlState {
        is_paused,
        needs_input: questions.values().any(|resolved| !resolved),
    })
}

fn request_state(data: &Value) -> Option<(&str, bool)> {
    let id = data["id"].as_str()?;
    let questions = data["questions"].as_array()?;
    let valid = questions.iter().all(valid_question)
        && data.get("resolved").is_none_or(Value::is_boolean)
        && data.get("answers").is_none_or(valid_answers)
        && data.get("queueId").is_none_or(Value::is_string);
    valid.then_some((id, data["resolved"] == true))
}

fn valid_question(data: &Value) -> bool {
    data["title"].is_string() && data.get("options").is_none_or(string_array)
}

fn string_array(data: &Value) -> bool {
    data.as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn valid_answers(data: &Value) -> bool {
    data.as_object().is_some_and(|answers| {
        answers
            .iter()
            .filter(|(key, _)| !key.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
            .all(|(_, answer)| string_array(&answer["answers"]))
    })
}

fn branch<'a>(entries: &'a [Value], leaf_id: Option<&str>) -> Vec<&'a Value> {
    let by_id: HashMap<_, _> = entries
        .iter()
        .filter(|entry| entry["type"] != "session")
        .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
        .collect();
    let mut seen = HashSet::new();
    let mut cursor = leaf_id;
    let mut branch = Vec::new();
    while let Some(id) = cursor.filter(|id| !id.is_empty()) {
        if !seen.insert(id) {
            break;
        }
        let Some(entry) = by_id.get(id) else {
            break;
        };
        branch.push(*entry);
        cursor = entry["parentId"].as_str();
    }
    branch.reverse();
    branch
}
