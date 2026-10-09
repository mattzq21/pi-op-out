use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::{fs, path::Path};

fn open(root: &Path) -> Result<Connection, String> {
    let database = crate::session_registry::open(root)?;
    database.execute_batch("CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT)")
        .map_err(|error| error.to_string())?;
    Ok(database)
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.len() != 40 || !key.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("Invalid conversation ownership key".into());
    }
    Ok(())
}

fn legacy(root: &Path, key: &str) -> Result<Option<String>, String> {
    match fs::read_to_string(root.join("conversation-ownership").join(format!("{key}.json"))) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn read(root: &Path, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    let mut database = open(root)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let saved: Option<Option<String>> = transaction.query_row("SELECT record_json FROM conversation_ownership WHERE record_id=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = if let Some(saved) = saved { saved } else {
        let body = legacy(root, key)?;
        transaction.execute("INSERT INTO conversation_ownership VALUES (?, ?)", rusqlite::params![key, body]).map_err(|error| error.to_string())?;
        body
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(body)
}

pub(crate) fn write(root: &Path, key: &str, body: &str) -> Result<(), String> {
    validate_key(key)?;
    open(root)?.execute("INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json", [key, body])
        .map_err(|error| error.to_string())?;
    Ok(())
}
