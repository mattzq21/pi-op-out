use super::protocol::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const PAGE_UNITS: usize = 524288;
const INDEX_UNITS: usize = 4096;
const CACHE_BYTES: usize = 128 * 1024 * 1024;
const CACHE_ENTRIES: usize = 32;

pub(super) struct ToolPayload {
    serialized: String,
    revision: String,
    length: usize,
    checkpoints: Vec<(usize, usize)>,
}

impl ToolPayload {
    pub fn new(message: Option<Value>) -> Result<Self> {
        let mut message = message.ok_or("Tool input and output are not available yet")?;
        let mut payload = json!({"content":message.get_mut("content").map(Value::take).filter(|item| !item.is_null()).unwrap_or(json!(""))});
        for key in ["details", "toolInput", "nestedCalls"] {
            if let Some(value) = message.get_mut(key) {
                payload[key] = value.take();
            }
        }
        let serialized = payload.to_string();
        let revision = format!("{:x}", Sha256::digest(serialized.as_bytes()));
        let mut length = 0;
        let mut checkpoints = vec![(0, 0)];
        let mut indexed = 0;
        for (byte, ch) in serialized.char_indices() {
            if length - indexed >= INDEX_UNITS {
                checkpoints.push((length, byte));
                indexed = length;
            }
            length += ch.len_utf16();
        }
        Ok(Self { serialized, revision, length, checkpoints })
    }

    fn byte_offset(&self, offset: usize) -> Result<usize> {
        let index = self.checkpoints.partition_point(|(units, _)| *units <= offset) - 1;
        let (mut units, byte) = self.checkpoints[index];
        for (relative, ch) in self.serialized[byte..].char_indices() {
            if units == offset { return Ok(byte + relative); }
            units += ch.len_utf16();
            if units > offset { return Err("Invalid output offset".into()); }
        }
        Ok(self.serialized.len())
    }

    pub fn page(&self, command: &Value) -> Result<Value> {
        if command["revision"].as_str().is_some_and(|expected| expected != self.revision) {
            return Err("Tool payload changed; reopen it to reload".into());
        }
        let offset = command.get("offset").filter(|value| !value.is_null())
            .map(|value| value.as_u64().ok_or("Invalid output offset")).transpose()?.unwrap_or(0);
        if offset > self.length as u64 { return Err("Invalid output offset".into()); }
        let start = self.byte_offset(offset as usize)?;
        let mut units = 0;
        let mut bytes = 0;
        for ch in self.serialized[start..].chars() {
            units += ch.len_utf16();
            if units > PAGE_UNITS { break; }
            bytes += ch.len_utf8();
        }
        Ok(json!({"revision":self.revision,"length":self.length,"chunk":&self.serialized[start..start + bytes]}))
    }

    fn bytes(&self) -> usize {
        self.serialized.capacity() + self.checkpoints.capacity() * std::mem::size_of::<(usize, usize)>()
    }
}

struct CachedPayload {
    scope: String,
    source_revision: String,
    tool: String,
    payload: Arc<ToolPayload>,
}

#[derive(Default)]
pub(super) struct ToolPayloadCache {
    entries: Mutex<VecDeque<CachedPayload>>,
}

impl ToolPayloadCache {
    pub fn get(&self, scope: &str, source_revision: &str, tool: &str) -> Option<Arc<ToolPayload>> {
        let mut entries = self.entries.lock().unwrap_or_else(|error| error.into_inner());
        let index = entries.iter().position(|entry| entry.scope == scope && entry.source_revision == source_revision && entry.tool == tool)?;
        let entry = entries.remove(index)?;
        let payload = entry.payload.clone();
        entries.push_back(entry);
        Some(payload)
    }

    pub fn insert(&self, scope: &str, source_revision: &str, tool: &str, payload: Arc<ToolPayload>) {
        let size = payload.bytes();
        if size > CACHE_BYTES { return; }
        let mut entries = self.entries.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|entry| entry.scope != scope || entry.tool != tool);
        let mut total: usize = entries.iter().map(|entry| entry.payload.bytes()).sum();
        while entries.len() >= CACHE_ENTRIES || total + size > CACHE_BYTES {
            let Some(entry) = entries.pop_front() else { break; };
            total -= entry.payload.bytes();
        }
        entries.push_back(CachedPayload { scope: scope.into(), source_revision: source_revision.into(), tool: tool.into(), payload });
    }
}
