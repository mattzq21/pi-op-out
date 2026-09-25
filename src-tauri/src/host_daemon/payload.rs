use super::protocol::{array, kind, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(super) fn client_payload(mut value: Value) -> Value {
    if value["entries"].is_array() && value.get("leafId").is_some() {
        return client_history(value);
    }
    if value["role"] == "toolResult" {
        value["content"] = json!("");
        value["deferredToolPayload"] = value["toolCallId"].clone();
        remove(&mut value, &["details", "toolInput"]);
    } else {
        value = client_tool_payload(value);
    }
    match &mut value {
        Value::Array(items) => {
            for item in items {
                *item = client_payload(std::mem::take(item));
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                *item = client_payload(std::mem::take(item));
            }
        }
        _ => {}
    }
    value
}

fn remove(value: &mut Value, keys: &[&str]) {
    if let Some(fields) = value.as_object_mut() {
        for key in keys {
            fields.remove(*key);
        }
    }
}

fn client_tool_payload(mut value: Value) -> Value {
    match kind(&value) {
        "toolCall" => {
            if let Some(fields) = value.as_object_mut() {
                fields.retain(|key, _| matches!(key.as_str(), "type" | "id" | "name"));
            }
        }
        "toolcall_delta" => remove(&mut value, &["delta"]),
        "toolcall_end" if value["toolCall"].is_object() => {
            value["toolCall"] = json!({"id":value["toolCall"]["id"],"name":value["toolCall"]["name"]});
        }
        name if name.starts_with("tool_execution_") => {
            remove(&mut value, &["args"]);
            let deferred = json!({"content":"","deferredToolPayload":value["toolCallId"]});
            for field in ["result", "partialResult"] {
                if value.get(field).is_some_and(|item| !item.is_null()) {
                    value[field] = deferred.clone();
                }
            }
        }
        _ => {}
    }
    value
}

pub(super) fn branch(history: &Value) -> Vec<Value> {
    let entries: HashMap<_, _> = history["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
        .collect();
    let mut visited = HashSet::new();
    let mut cursor = history["leafId"].as_str();
    let mut result = Vec::new();
    while let Some(id) = cursor {
        if !visited.insert(id) {
            break;
        }
        let Some(entry) = entries.get(id) else {
            break;
        };
        result.push((*entry).clone());
        cursor = entry["parentId"].as_str();
    }
    result.reverse();
    result
}

fn client_history(mut history: Value) -> Value {
    let mut inputs = HashMap::new();
    for entry in history["entries"].as_array().into_iter().flatten() {
        for part in entry["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| kind(part) == "toolCall")
        {
            if let Some(id) = part["id"].as_str() {
                inputs.insert(id.to_owned(), part["arguments"].clone());
            }
        }
    }
    let branch = branch(&history);
    let mut entries = Vec::new();
    let mut size = 0;
    for mut entry in branch.iter().rev().cloned() {
        if entry["message"]["role"] == "toolResult" {
            let message = &entry["message"];
            let input = inputs
                .get(message["toolCallId"].as_str().unwrap_or_default())
                .cloned()
                .unwrap_or(Value::Null);
            let patch = message["details"]["patch"].as_str().or_else(|| match message["toolName"].as_str() {
                Some("edit") => message["details"]["diff"].as_str(),
                Some("apply_patch") => input["patch"].as_str().or_else(|| input["input"].as_str()),
                _ => None,
            });
            if let Some(patch) = patch.filter(|patch| patch.encode_utf16().count() <= 2 * 1024 * 1024) {
                let mut diff = json!({"patch":patch});
                if input["path"].is_string() {
                    diff["path"] = input["path"].clone();
                }
                entry["message"]["toolDiff"] = diff;
            }
        }
        let entry = client_payload(entry);
        let cost = entry.to_string().encode_utf16().count() * 4 + 256;
        if size + cost > 256 * 1024 * 1024 {
            break;
        }
        size += cost;
        entries.push(entry);
    }
    history["omittedEntries"] = json!(branch.len() - entries.len());
    entries.reverse();
    history["entries"] = json!(entries);
    history
}

pub(super) fn saved_tool_payload(entries: &[Value], id: &str) -> Option<Value> {
    let mut input = None;
    let mut result = None;
    for entry in entries {
        let message = &entry["message"];
        if message["role"] == "toolResult" && message["toolCallId"] == id {
            result = Some(message.clone());
        }
        if let Some(call) = message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|part| kind(part) == "toolCall" && part["id"] == id)
        {
            input = call.get("arguments").cloned();
        }
    }
    if result.is_none() && input.is_none() {
        return None;
    }
    let mut result = result.unwrap_or_else(|| json!({"content":""}));
    if let Some(input) = input {
        result["toolInput"] = input;
    }
    Some(result)
}

pub(super) fn tool_payload_page(message: Option<Value>, command: &Value) -> Result<Value> {
    let message = message.ok_or("Tool input and output are not available yet")?;
    let mut payload = json!({"content":message.get("content").filter(|item| !item.is_null()).cloned().unwrap_or(json!(""))});
    for key in ["details", "toolInput"] {
        if let Some(value) = message.get(key) {
            payload[key] = value.clone();
        }
    }
    let serialized = payload.to_string();
    let revision = format!("{:x}", Sha256::digest(serialized.as_bytes()));
    if command["revision"].as_str().is_some_and(|expected| expected != revision) {
        return Err("Tool payload changed; reopen it to reload".into());
    }
    let offset = command
        .get("offset")
        .filter(|value| !value.is_null())
        .map(|value| value.as_u64().ok_or("Invalid output offset"))
        .transpose()?
        .unwrap_or(0);
    let length = serialized.encode_utf16().count();
    if offset > length as u64 {
        return Err("Invalid output offset".into());
    }
    let mut position = 0;
    let mut chunk = String::new();
    for ch in serialized.chars() {
        let next = position + ch.len_utf16();
        if position < offset as usize && next > offset as usize {
            return Err("Invalid output offset".into());
        }
        if position >= offset as usize {
            if next > offset as usize + 524288 {
                break;
            }
            chunk.push(ch);
        }
        position = next;
    }
    Ok(json!({"revision":revision,"length":length,"chunk":chunk}))
}

pub(super) fn assistant_delta(message: &Value, event: &Value) -> Value {
    let Some(index) = event["contentIndex"].as_u64().and_then(|index| usize::try_from(index).ok()) else {
        return message.clone();
    };
    let mut content = if message["content"].is_array() {
        array(message, "content")
    } else if message["content"].is_string() {
        vec![json!({"type":"text","text":message["content"]})]
    } else {
        Vec::new()
    };
    // A malformed worker event must not allocate an unbounded sparse array.
    if index > 1_000_000 {
        return message.clone();
    }
    content.resize_with(content.len().max(index + 1), || json!({"type":"text","text":""}));
    let current = &content[index];
    let tool = if kind(current) == "toolCall" {
        current.clone()
    } else {
        json!({"type":"toolCall","id":event.get("id").cloned().unwrap_or(json!(format!("tool-{index}"))),
            "name":event.get("toolName").cloned().unwrap_or(json!("tool")),"arguments":{}})
    };
    let mut next = current.clone();
    match kind(event) {
        "text_start" => next = json!({"type":"text","text":""}),
        "thinking_start" => next = json!({"type":"thinking","thinking":""}),
        "text_delta" | "thinking_delta" => {
            let field = if kind(event) == "text_delta" { "text" } else { "thinking" };
            let before = if kind(current) == field {
                current[field].as_str().unwrap_or_default()
            } else {
                ""
            };
            next["type"] = json!(field);
            next[field] = json!(format!("{before}{}", event["delta"].as_str().unwrap_or_default()));
        }
        "text_end" | "thinking_end" => {
            let field = if kind(event) == "text_end" { "text" } else { "thinking" };
            next["type"] = json!(field);
            next[field] = event.get("content").cloned().unwrap_or(json!(""));
        }
        "toolcall_start" => {
            next = json!({"type":"toolCall","id":event.get("id").unwrap_or(&tool["id"]),"name":event.get("toolName").unwrap_or(&tool["name"]),"arguments":{},"partialArgs":""})
        }
        "toolcall_delta" => {
            next = tool;
            next["partialArgs"] = json!(format!(
                "{}{}",
                next["partialArgs"].as_str().unwrap_or_default(),
                event["delta"].as_str().unwrap_or_default()
            ));
        }
        "toolcall_end" if event["toolCall"].is_object() => {
            next = event["toolCall"].clone();
            next["type"] = json!("toolCall");
        }
        _ => return message.clone(),
    }
    content[index] = next;
    let mut result = message.clone();
    result["content"] = json!(content);
    result
}
