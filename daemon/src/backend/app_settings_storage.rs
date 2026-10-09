use rusqlite::{TransactionBehavior, params};
use std::path::Path;

#[path = "../../../shared/rust/settings_records.rs"]
mod storage;

pub(crate) use storage::read;
pub(super) use storage::{publish, Publication};
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
