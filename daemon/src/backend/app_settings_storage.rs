use rusqlite::{OptionalExtension, TransactionBehavior, params};
use std::path::Path;

#[path = "../../../shared/rust/settings_records.rs"]
mod storage;

pub(crate) use storage::read;
pub(crate) use storage::{publish, Publication};
use storage::{open, name};

pub(crate) fn read_or_create(path: &Path, initial: &[u8]) -> Result<Vec<u8>, String> {
    let mut database = open(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let body = initialize_record(&transaction, path, initial)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(body)
}

fn initialize_record(transaction: &rusqlite::Connection, path: &Path, initial: &[u8]) -> Result<Vec<u8>, String> {
    let key = name(path)?;
    let saved: Option<Option<Vec<u8>>> = transaction.query_row("SELECT body FROM application_settings WHERE name=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = match saved {
        Some(Some(body)) => return Ok(body),
        Some(None) => initial.to_vec(),
        None => initial.to_vec(),
    };
    transaction.execute("INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body", params![key, body])
        .map_err(|error| error.to_string())?;
    Ok(body)
}

pub(crate) fn skill_inventory(path: &Path, root: &Path, refresh: bool, discover: impl FnOnce() -> Result<Vec<serde_json::Value>, String>) -> Result<Vec<serde_json::Value>, String> {
    let mut database = open(path)?;
    database.execute_batch("CREATE TABLE IF NOT EXISTS skill_inventory (root TEXT PRIMARY KEY, entries_json TEXT NOT NULL)").map_err(|error| error.to_string())?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let key = root.to_str().ok_or("Invalid skill directory")?;
    let saved: Option<String> = transaction.query_row("SELECT entries_json FROM skill_inventory WHERE root=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let skills = inventory_contents(&transaction, key, saved.filter(|_| !refresh), discover)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(skills)
}

fn inventory_contents(database: &rusqlite::Connection, key: &str, saved: Option<String>, discover: impl FnOnce() -> Result<Vec<serde_json::Value>, String>) -> Result<Vec<serde_json::Value>, String> {
    if let Some(saved) = saved {
        serde_json::from_str(&saved).map_err(|error| error.to_string())
    } else {
        let skills = discover()?;
        let body = serde_json::to_string(&skills).map_err(|error| error.to_string())?;
        database.execute("INSERT INTO skill_inventory VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET entries_json=excluded.entries_json", params![key, body])
            .map_err(|error| error.to_string())?;
        Ok(skills)
    }
}
