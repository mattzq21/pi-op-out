use rusqlite::{OptionalExtension, TransactionBehavior, params};
use std::path::Path;

#[path = "../../../shared/rust/settings_records.rs"]
mod storage;

pub(crate) use storage::read;
pub(crate) use storage::{publish, Publication};
use storage::{open, name, old_body};

pub(super) fn needs_legacy(path: &Path) -> Result<bool, String> {
    if read(path)?.is_some() { return Ok(false); }
    open(path)?.query_row("SELECT legacy_imported=0 FROM application_settings WHERE name=?", [name(path)?], |row| row.get(0)).map_err(|error| error.to_string())
}

pub(super) fn import_legacy(path: &Path, legacy: &Path) -> Result<(), String> {
    let mut database = open(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let needed: bool = transaction.query_row("SELECT body IS NULL AND legacy_imported=0 FROM application_settings WHERE name=?", [name(path)?], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if needed {
        transaction.execute("UPDATE application_settings SET body=?, legacy_imported=1 WHERE name=?", params![old_body(legacy)?, name(path)?])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

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
        None => old_body(path)?.unwrap_or_else(|| initial.to_vec()),
    };
    transaction.execute("INSERT INTO application_settings VALUES (?, ?, 1) ON CONFLICT(name) DO UPDATE SET body=excluded.body, legacy_imported=1", params![key, body])
        .map_err(|error| error.to_string())?;
    Ok(body)
}
