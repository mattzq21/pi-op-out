use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

pub(super) type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

impl LaunchSpec {
    pub fn argument(&self, flag: &str) -> Option<&str> {
        self.args
            .iter()
            .rposition(|arg| arg == flag)
            .and_then(|index| self.args.get(index + 1))
            .map(String::as_str)
    }

    pub fn session(&self, flag: &str, value: &str) -> Self {
        let mut next = self.clone();
        next.args.clear();
        let mut args = self.args.iter();
        while let Some(arg) = args.next() {
            if matches!(arg.as_str(), "--session" | "--session-id" | "--fork") {
                args.next();
            } else if arg != "--no-session" {
                next.args.push(arg.clone());
            }
        }
        next.args.extend([flag.to_owned(), value.to_owned()]);
        next
    }

    pub fn prepare(&mut self, key: &str, client: &str, home: &std::path::Path) {
        self.env.insert("PIOP_CONVERSATION_CLIENT".into(), client.into());
        if let Some(cwd) = self.env.get_mut("PIOP_SESSION_CWD") {
            *cwd = expand_home(cwd, home).to_string_lossy().into_owned();
        }
        if self.argument("--session").is_none() && self.argument("--session-id").is_none() {
            self.args.extend(["--session-id".into(), key.into()]);
        }
    }

    pub fn identity(&self, fallback: &str) -> Result<String> {
        use std::io::{BufRead, BufReader, Read};
        let Some(path) = self.argument("--session") else {
            return Ok(self.argument("--session-id").unwrap_or(fallback).into());
        };
        let file = std::fs::File::open(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "This conversation has been deleted or archived".into()
            } else {
                error.to_string()
            }
        })?;
        let mut header = String::new();
        BufReader::new(file)
            .take(64 * 1024)
            .read_line(&mut header)
            .map_err(|error| error.to_string())?;
        let header: Value = serde_json::from_str(&header).map_err(|error| error.to_string())?;
        header["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Missing session identity".into())
    }
}

pub(super) fn expand_home(path: &str, home: &std::path::Path) -> PathBuf {
    if path == "~" {
        home.to_owned()
    } else if let Some(path) = path.strip_prefix("~/") {
        home.join(path)
    } else {
        PathBuf::from(path)
    }
}

pub(super) fn wire_command(command: &Value, id: &str) -> Value {
    let action = match kind(command) {
        "pause" => Some("pause"),
        "resume" => Some("resume"),
        "abort" => Some("stop"),
        "cancel_preparation" => Some("cancel-preparation"),
        "get_pause_state" => Some("state"),
        _ => None,
    };
    let extension = match kind(command) {
        "answer_question" => Some("piop-answer-question"),
        "provider_auth_refresh" => Some("piop-provider-auth-refresh"),
        "runtime_settings" => Some("piop-runtime-settings"),
        "branch_checkpoint" => Some("pi-desktop-branch-checkpoint"),
        "fork_and_forget" => Some("pi-desktop-fork-and-forget"),
        "fork_after" => Some("pi-desktop-fork-after"),
        "voice_history" => Some("pi-desktop-voice-history"),
        _ => None,
    };
    let mut wire = command.clone();
    wire["id"] = json!(id);
    if action.is_some() || extension.is_some() {
        let payload = action.map(|action| json!({"id":id,"action":action})).unwrap_or(wire);
        json!({"type":"prompt","id":format!("{id}:desktop-control"),
            "message":format!("/{} {}", extension.unwrap_or("pi-desktop-control"), payload)})
    } else {
        wire
    }
}

pub(super) fn kind(value: &Value) -> &str {
    value["type"].as_str().unwrap_or_default()
}
pub(super) fn text(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap_or_default().to_owned()
}
pub(super) fn flag(value: &Value, field: &str) -> bool {
    value[field].as_bool().unwrap_or(false)
}
pub(super) fn array(value: &Value, field: &str) -> Vec<Value> {
    value[field].as_array().cloned().unwrap_or_default()
}

pub(super) fn message_text(content: &Value, separator: &str) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| kind(part) == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join(separator)
}
