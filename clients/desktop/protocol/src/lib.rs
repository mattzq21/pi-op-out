use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const PEER_PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;

pub fn development_endpoint_key(project: &std::path::Path) -> String {
    let identity = project.join("src-tauri");
    let key = identity.to_string_lossy().bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("{key:016x}")
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
    pub protocol: u32,
}

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub command: String,
    #[serde(default = "empty_args")]
    pub args: Value,
}

fn empty_args() -> Value { serde_json::json!({}) }

#[derive(Serialize, Deserialize)]
pub struct Event {
    pub event: String,
    pub payload: Value,
}

#[derive(Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn from_result(id: u64, result: Result<Value, String>) -> Self {
        match result {
            Ok(result) => Self { id, result: Some(result), error: None },
            Err(error) => Self { id, result: None, error: Some(error) },
        }
    }
}
