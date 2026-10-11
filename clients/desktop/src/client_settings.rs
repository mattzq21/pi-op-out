use super::*;
use crate::settings_concurrency::{lock_settings, settings_revision};

#[path = "../../../shared/rust/settings_records.rs"]
pub(crate) mod records;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientSettings {
    keybindings: HashMap<String, String>,
    debug_mode: bool,
}

fn storage_path() -> Result<PathBuf, String> {
    let directory = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&directory)?;
    Ok(directory.join("client-settings.json"))
}

fn read_preferences(path: &Path) -> Result<Option<ClientSettings>, String> {
    records::read(path)?.map(|body| serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))).transpose()
}

fn merge_keybindings(latest: &mut HashMap<String, String>, baseline: &HashMap<String, String>, intended: &HashMap<String, String>) -> Result<(), String> {
    for key in baseline.keys().chain(intended.keys()) {
        let before = baseline.get(key);
        let after = intended.get(key);
        if before == after { continue; }
        let current = latest.get(key);
        if current != before && current != after { return Err(format!("Client preference conflict at keybindings.{key}: another window changed this shortcut. Reload the latest preferences and choose the shortcut again.")); }
    }
    for key in baseline.keys().chain(intended.keys()) {
        if baseline.get(key) == intended.get(key) { continue; }
        if let Some(value) = intended.get(key) { latest.insert(key.clone(), value.clone()); }
        else { latest.remove(key); }
    }
    Ok(())
}

fn merge_preferences(mut latest: ClientSettings, baseline: &ClientSettings, intended: &ClientSettings) -> Result<ClientSettings, String> {
    merge_keybindings(&mut latest.keybindings, &baseline.keybindings, &intended.keybindings)?;
    if intended.debug_mode != baseline.debug_mode { latest.debug_mode = intended.debug_mode; }
    Ok(latest)
}

fn intended_preferences(path: &Path, baseline: &ClientSettings, intended: ClientSettings, initialize: bool) -> Result<ClientSettings, String> {
    match read_preferences(path)? {
        Some(latest) if initialize => Ok(latest),
        Some(latest) => merge_preferences(latest, baseline, &intended),
        None => Ok(intended),
    }
}

#[tauri::command]
pub(crate) fn load_client_settings() -> Result<Value, String> {
    let path = storage_path()?;
    let _guard = lock_settings(&path)?;
    match records::read(&path)? {
        Some(body) => {
            let settings: ClientSettings = serde_json::from_slice(&body).map_err(|error| format!("Could not read client preferences: {error}"))?;
            Ok(json!({"settings":settings,"revision":settings_revision(Some(&body))}))
        }
        None => Ok(json!({"settings":null,"revision":settings_revision(None)})),
    }
}

#[tauri::command]
pub(crate) fn save_client_settings(app: AppHandle, settings: ClientSettings, baseline: ClientSettings, initialize: Option<bool>) -> Result<Value, String> {
    let path = storage_path()?;
    let _guard = lock_settings(&path)?;
    let settings = intended_preferences(&path, &baseline, settings, initialize.unwrap_or(false))?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    let publication = records::publish(&path, &body)?;
    for window in app.webview_windows().values() { let _ = window.emit("pi://client-settings-changed", ()); }
    Ok(json!({"settings":settings,"revision":settings_revision(Some(&body)),"publication":publication}))
}

#[derive(Deserialize)]
pub(crate) struct PromptHistoryEntry {
    id: String,
    prompt: String,
}

fn append_prompt_history(db: &rusqlite::Connection, entries: &[PromptHistoryEntry]) -> Result<(), String> {
    for entry in entries {
        if entry.prompt.trim().is_empty() { continue; }
        db.execute("INSERT OR IGNORE INTO desktop_prompt_history (event_id, prompt) VALUES (?, ?)",
            rusqlite::params![entry.id, entry.prompt]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn update_prompt_history(entries: Vec<PromptHistoryEntry>, legacy: Vec<String>) -> Result<(Vec<String>, bool), String> {
    let path = storage_path()?;
    let mut db = records::open(&path)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS desktop_prompt_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL);")
        .map_err(|error| error.to_string())?;
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let before = transaction.total_changes();
    import_prompt_history(&transaction, legacy)?;
    append_prompt_history(&transaction, &entries)?;
    transaction.execute("DELETE FROM desktop_prompt_history WHERE sequence NOT IN (SELECT sequence FROM desktop_prompt_history ORDER BY sequence DESC LIMIT 100)", [])
        .map_err(|error| error.to_string())?;
    let history = read_prompt_history(&transaction)?;
    let changed = transaction.total_changes() != before;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok((history, changed))
}

#[tauri::command]
pub(crate) fn sync_prompt_history(app: AppHandle, entries: Vec<PromptHistoryEntry>, legacy: Vec<String>) -> Result<Vec<String>, String> {
    let (history, changed) = update_prompt_history(entries, legacy)?;
    if changed {
        for window in app.webview_windows().values() { let _ = window.emit("pi://prompt-history-changed", ()); }
    }
    Ok(history)
}

fn read_prompt_history(db: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut statement = db.prepare("SELECT prompt FROM desktop_prompt_history ORDER BY sequence").map_err(|error| error.to_string())?;
    let mut entries = statement.query_map([], |row| row.get(0)).map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>().map_err(|error| error.to_string())?;
    entries.dedup();
    Ok(entries)
}

fn import_prompt_history(db: &rusqlite::Connection, legacy: Vec<String>) -> Result<(), String> {
    let empty: bool = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM desktop_prompt_history)", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if empty {
        let imported: Vec<_> = legacy.into_iter().rev().take(100).collect::<Vec<_>>().into_iter().rev().enumerate()
            .map(|(index, prompt)| PromptHistoryEntry { id: format!("legacy-{index}"), prompt }).collect();
        append_prompt_history(db, &imported)?;
    }
    Ok(())
}
