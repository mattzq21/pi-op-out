use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::{Value, json};
use std::collections::HashMap;
use super::DEVELOPMENT;
use super::keybindings::default_keybindings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteHost {
    #[serde(default = "default_true")]
    pub(super) enabled: bool,
    pub(super) id: String,
    pub(super) name: String,
    pub(super) target: String,
    #[serde(default = "default_pi_path")]
    pub(super) pi_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) settings_revision: Option<String>,
    #[serde(default = "default_agent")]
    pub(super) review_agent: String,
    #[serde(default = "default_review_prompt")]
    pub(super) review_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) dictation_model_path: Option<String>,
    #[serde(default = "default_true")]
    pub(super) local_enabled: bool,
    #[serde(default = "default_agent")]
    pub(super) default_agent: String,
    pub(super) default_model: String,
    #[serde(default)]
    pub(super) hidden_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) known_models: Option<Vec<String>>,
    pub(super) default_thinking: String,
    #[serde(default)]
    pub(super) default_fast_mode: bool,
    #[serde(default = "default_context_window_cap", deserialize_with = "deserialize_context_window_cap")]
    pub(super) context_window_cap: u64,
    #[serde(default = "default_context_window_cap_enabled")]
    pub(super) context_window_cap_enabled: bool,
    #[serde(default = "default_true")]
    pub(super) auto_retry: bool,
    #[serde(default)]
    pub(super) debug_mode: bool,
    #[serde(default = "default_keybindings")]
    pub(super) keybindings: HashMap<String, String>,
    pub(super) tools: Vec<Value>,
    pub(super) skills: Vec<Value>,
    #[serde(default)]
    pub(super) hosts: Vec<RemoteHost>,
}

pub(super) fn default_pi_path() -> String { "pi".into() }
pub(super) fn default_context_window_cap() -> u64 { 300_000 }
pub(super) fn default_context_window_cap_enabled() -> bool { true }
pub(super) fn default_true() -> bool { true }
pub(super) fn deserialize_context_window_cap<'de, D>(deserializer: D) -> Result<u64, D::Error> where D: Deserializer<'de> {
    let value = Value::deserialize(deserializer)?;
    value.as_u64().ok_or_else(|| de::Error::custom("Context window cap must be a whole number"))
}
pub(super) const DEFAULT_MODEL: &str = if DEVELOPMENT { "openai-codex/gpt-6-luna" } else { "openai-codex/gpt-5.6-sol" };

pub(super) fn default_agent() -> String { "general".into() }
pub(super) fn default_review_prompt() -> String { include_str!("../../resources/session-broker/review-prompt.txt").trim().into() }

pub(super) fn default_settings() -> AppSettings {
    AppSettings {
        settings_revision: None,
        review_agent: default_agent(),
        review_prompt: default_review_prompt(),
        dictation_model_path: None,
        local_enabled: true,
        default_agent: default_agent(),
        default_fast_mode: false,
         default_model: DEFAULT_MODEL.into(), hidden_models: vec![], known_models: None, default_thinking: "medium".into(), context_window_cap: default_context_window_cap(), context_window_cap_enabled: default_context_window_cap_enabled(), auto_retry: true, debug_mode: false, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List child agents and their status","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Deliver an agent mailbox message","enabled":true,"builtin":false}),
            json!({"name":"read_trace","description":"Extract clean user and final assistant messages from a Pi trace","enabled":true,"builtin":false}),
            codex_web_search_tool(),
        ]).collect(),
        skills: vec![], hosts: vec![],
    }
}

pub(super) fn session_operation_tools() -> Vec<Value> {
    [("subagent", "Delegate parallel tasks to agents with saved transcripts"), ("request_user_input", "Ask the user questions with choices and free-text answers"), ("lookup_terminals", "Read session terminal activity through terminal-agent"), ("render_html", "Display self-contained HTML previews in chat"), ("get_goal", "Read the current persistent goal"), ("create_goal", "Create a persistent goal with an optional token budget"), ("update_goal", "Complete, block or pause the current goal")].into_iter().map(|(name, description)| json!({"name":name,"description":description,"enabled":true,"builtin":false})).collect()
}

pub(super) fn codex_web_search_tool() -> Value {
    json!({"name":"web_search","description":"Search the web with Pi's Codex login and return cited answers","enabled":true,"builtin":false})
}

pub(super) fn validate_remote_host(host: &RemoteHost) -> Result<(), String> {
    if host.target.is_empty() || !host.target.chars().all(|character| character.is_ascii_alphanumeric() || "._@:-[]".contains(character)) { return Err("SSH target may only contain a host, user, and port-safe characters".into()); }
    if host.pi_path.is_empty() || !host.pi_path.chars().all(|character| character.is_ascii_alphanumeric() || "._/-~".contains(character)) { return Err("Pi executable must be a plain executable name or path".into()); }
    Ok(())
}

pub(super) const MAX_REMOTE_HOSTS: usize = 16;
