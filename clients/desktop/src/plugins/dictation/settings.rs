//! The dictation fields of the client settings and how two windows' edits of them merge.
use crate::{client_settings, platform::AppHandle};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The dictation fields of the client preferences. Empty strings mean "not set".
/// engine is "transcribe.cpp" or "needle"; program is its optional path; args holds engine options such as "--language en".
#[derive(Clone, PartialEq)]
pub(super) struct DictationSettings { pub engine: String, pub program: String, pub model: String, pub args: String }

/// A model added to an engine, with its arguments. The path and the arguments together identify it.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct DictationModel {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    args: String,
}

/// The settings of one engine type: its program path ("" searches PATH) and its models. The engine type identifies it.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct DictationEngineEntry {
    engine: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    path: String,
    #[serde(default)]
    models: Vec<DictationModel>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    dictation_engine: Option<String>,
    dictation_engines: Option<Vec<DictationEngineEntry>>,
    dictation_model_path: Option<String>,
    dictation_args: Option<String>,
}

const ENGINES: &str = "dictationEngines";

pub(super) fn register(app: &AppHandle) -> Result<(), String> {
    client_settings::register_field_merge(app, ENGINES, merge_engine_field)
}

/// The dictation settings in a client settings object. None or missing fields use the defaults.
pub(super) fn from_client_settings(settings: Option<&Value>) -> Result<DictationSettings, String> {
    let preferences: Preferences = settings.map(|value| serde_json::from_value(value.clone())).transpose()
        .map_err(|error| format!("Could not read the dictation preferences: {error}"))?.unwrap_or_default();
    let field = |value: &Option<String>| value.as_deref().unwrap_or_default().trim().to_owned();
    let engine = field(&preferences.dictation_engine);
    let engine = if engine.is_empty() { "transcribe.cpp".to_owned() } else { engine };
    let program = preferences.dictation_engines.iter().flatten().find(|entry| entry.engine == engine).map(|entry| entry.path.trim().to_owned()).unwrap_or_default();
    Ok(DictationSettings { engine, program, model: field(&preferences.dictation_model_path), args: field(&preferences.dictation_args) })
}

fn merge_engine_field(latest: Option<&Value>, baseline: Option<&Value>, intended: Option<&Value>) -> Result<Option<Value>, String> {
    if latest.is_none() && intended.is_none() { return Ok(None); }
    let entries = |value: Option<&Value>| -> Result<Vec<DictationEngineEntry>, String> {
        value.map(|value| serde_json::from_value(value.clone())).transpose().map_err(|error| format!("Could not read {ENGINES}: {error}")).map(Option::unwrap_or_default)
    };
    let merged = merge_engines(&entries(latest)?, &entries(baseline)?, &entries(intended)?)?;
    serde_json::to_value(merged).map(Some).map_err(|error| error.to_string())
}

fn merge_engines(latest: &[DictationEngineEntry], baseline: &[DictationEngineEntry], intended: &[DictationEngineEntry]) -> Result<Vec<DictationEngineEntry>, String> {
    let find = |entries: &[DictationEngineEntry], engine: &str| entries.iter().find(|entry| entry.engine == engine).cloned();
    let mut engines: Vec<String> = latest.iter().map(|entry| entry.engine.clone()).collect();
    for entry in intended { if !engines.contains(&entry.engine) { engines.push(entry.engine.clone()); } }
    let mut merged = Vec::new();
    for engine in engines {
        let (before, after) = (find(baseline, &engine), find(intended, &engine));
        let current = find(latest, &engine);
        if before != after && current != before && current != after { return Err(format!("Client preference conflict at {ENGINES}.{engine}: another window changed this engine. Reload the latest preferences and apply your edits again.")); }
        if let Some(entry) = if before != after { after } else { current } { merged.push(entry); }
    }
    Ok(merged)
}
