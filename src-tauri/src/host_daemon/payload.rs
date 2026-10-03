use super::protocol::kind;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};


pub(super) fn client_payload(mut value: Value) -> Value {
    if value["entries"].is_array() && value.get("leafId").is_some() {
        return client_history(value);
    }
    if value["role"] == "toolResult" {
        if value["isError"] == true {
            value["toolFailureKind"] = json!(tool_failure_kind(&value));
        }
        value["content"] = json!("");
        value["deferredToolPayload"] = value["toolCallId"].clone();
        remove(&mut value, &["details", "toolInput", "structuredContent", "nestedCalls"]);
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
        name if name.starts_with("tool_execution_") => defer_tool_result(&mut value),
        _ => {}
    }
    value
}

fn defer_tool_result(value: &mut Value) {
    if value["isError"] == true {
        value["toolFailureKind"] = json!(tool_failure_kind(&value["result"]));
    }
    remove(value, &["args"]);
    let deferred = json!({"content":"","deferredToolPayload":value["toolCallId"]});
    for field in ["result", "partialResult"] {
        if value.get(field).is_some_and(|item| !item.is_null()) {
            value[field] = deferred.clone();
        }
    }
}

pub(super) fn tool_failure_kind(result: &Value) -> &'static str {
    let invalid_use = |text: &str| {
        let text = text.trim();
        text.starts_with("Validation failed for tool ")
            || (text.starts_with("Tool ") && text.ends_with(" not found") && !text.contains('\n'))
            || text.starts_with("MCP error -32602:")
            || text.starts_with("McpError: MCP error -32602:")
    };
    let content = &result["content"];
    if content.as_str().is_some_and(invalid_use)
        || content.as_array().into_iter().flatten().any(|part| {
            part["type"] == "text" && part["text"].as_str().is_some_and(invalid_use)
        })
    {
        "invalid-use"
    } else {
        "other"
    }
}

fn branch_entries(history: &Value) -> Vec<&Value> {
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
        result.push(*entry);
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
                inputs.insert(id, &part["arguments"]);
            }
        }
    }
    let branch = branch_entries(&history);
    let mut entries = Vec::new();
    let mut size = 0;
    let mut wire_size = 0;
    for entry in branch.iter().rev() {
        let mut entry = (*entry).clone();
        if entry["message"]["role"] == "toolResult" {
            let message = &entry["message"];
            let input = inputs
                .get(message["toolCallId"].as_str().unwrap_or_default())
                .copied()
                .unwrap_or(&Value::Null);
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
        let serialized = entry.to_string();
        let cost = serialized.encode_utf16().count() * 4 + 256;
        if size + cost > 256 * 1024 * 1024 || wire_size + serialized.len() + 1 > 120 * 1024 * 1024 {
            break;
        }
        size += cost;
        wire_size += serialized.len() + 1;
        entries.push(entry);
    }
    history["omittedEntries"] = json!(branch.len() - entries.len());
    entries.reverse();
    history["entries"] = json!(entries);
    history
}

pub(super) fn saved_tool_payload(entries: &[Value], id: &str) -> Option<Value> {
    let (input, result) = latest_tool_parts(entries, id);
    if result.is_none() && input.is_none() { return None; }
    let mut result = result.cloned().unwrap_or_else(|| json!({"content":""}));
    if let Some(input) = input { result["toolInput"] = input.clone(); }
    Some(result)
}

fn latest_tool_parts<'a>(entries: &'a [Value], id: &str) -> (Option<&'a Value>, Option<&'a Value>) {
    let mut call = None;
    let mut result = None;
    for entry in entries.iter().rev() {
        let message = &entry["message"];
        if result.is_none() && message["role"] == "toolResult" && message["toolCallId"] == id {
            result = Some(message);
        }
        if call.is_none() {
            call = message["content"].as_array().into_iter().flatten().find(|part| kind(part) == "toolCall" && part["id"] == id);
        }
        if result.is_some() && call.is_some() { break; }
    }
    (call.and_then(|call| call.get("arguments")), result)
}

pub(super) fn assistant_delta(mut message: Value, event: &Value) -> Value {
    let Some(index) = event["contentIndex"].as_u64().and_then(|index| usize::try_from(index).ok()) else {
        return message;
    };
    if index > 1_000_000 || !valid_delta(event) { return message; }
    if !message["content"].is_array() {
        let content = message["content"].take();
        message["content"] = if content.is_string() { json!([{"type":"text","text":content}]) } else { json!([]) };
    }
    let content = message["content"].as_array_mut().unwrap();
    content.resize_with(content.len().max(index + 1), || json!({"type":"text","text":""}));
    if kind(event).starts_with("toolcall_") {
        tool_delta(&mut content[index], event, index);
    } else {
        text_delta(&mut content[index], event);
    }
    message
}

fn valid_delta(event: &Value) -> bool {
    match kind(event) {
        "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | "thinking_end" | "toolcall_start" | "toolcall_delta" => true,
        "toolcall_end" => event["toolCall"].is_object(),
        _ => false,
    }
}

fn append_delta(current: &mut Value, field: &str, event: &Value) {
    if !current[field].is_string() { current[field] = json!(""); }
    if let Value::String(value) = &mut current[field] {
        value.push_str(event["delta"].as_str().unwrap_or_default());
    }
}

fn tool_delta(current: &mut Value, event: &Value, index: usize) {
    if kind(current) != "toolCall" {
        *current = json!({"type":"toolCall","id":event.get("id").cloned().unwrap_or(json!(format!("tool-{index}"))),
            "name":event.get("toolName").cloned().unwrap_or(json!("tool")),"arguments":{}});
    }
    match kind(event) {
        "toolcall_start" => {
            *current = json!({"type":"toolCall","id":event.get("id").unwrap_or(&current["id"]),"name":event.get("toolName").unwrap_or(&current["name"]),"arguments":{},"partialArgs":""});
        }
        "toolcall_delta" => append_delta(current, "partialArgs", event),
        "toolcall_end" => {
            *current = event["toolCall"].clone();
            current["type"] = json!("toolCall");
        }
        _ => {}
    }
}

fn text_delta(current: &mut Value, event: &Value) {
    let (field, action) = kind(event).split_once('_').unwrap();
    match action {
        "start" => *current = json!({"type":field,field:""}),
        "delta" => {
            if kind(current) != field { current[field] = json!(""); }
            current["type"] = json!(field);
            append_delta(current, field, event);
        }
        "end" => {
            current["type"] = json!(field);
            current[field] = event.get("content").cloned().unwrap_or(json!(""));
        }
        _ => {}
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn non_ascii_history_fits_the_client_wire_limit() {
        let content = "界".repeat(1024 * 1024);
        let entries: Vec<_> = (0..48).map(|i| json!({"id":i.to_string(),"parentId":if i == 0 { Value::Null } else { json!((i-1).to_string()) },"type":"message","message":{"role":"assistant","content":content}})).collect();
        let history = client_payload(json!({"entries":entries,"leafId":"47"}));
        assert!(history.to_string().len() < 128 * 1024 * 1024);
        assert!(history["omittedEntries"].as_u64().unwrap() > 0);
    }
}
