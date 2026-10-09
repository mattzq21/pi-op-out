use super::super::protocol::Result;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::HashSet, fs::OpenOptions, path::Path, time::Duration};

fn open(auth: &Path) -> Result<Connection> {
    let parent = auth.parent().ok_or("Invalid provider authentication path")?;
    crate::ensure_private_dir(parent)?;
    let path = parent.join("piop-accounts.sqlite");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    let file = options.open(&path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?; }
    drop(file);
    let db = Connection::open(path).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS provider_accounts (auth_file TEXT NOT NULL, provider_id TEXT NOT NULL, account_number INTEGER NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY(auth_file, id), UNIQUE(auth_file, provider_id, account_number))").map_err(|error| error.to_string())?;
    Ok(db)
}

fn key(auth: &Path) -> Result<&str> { auth.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid provider authentication filename".into()) }


pub(super) fn read(auth: &Path) -> Result<Vec<Value>> {
    let mut db = open(auth)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let records = read_rows(&transaction, key(auth)?)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(records)
}

fn read_rows(db: &Connection, key: &str) -> Result<Vec<Value>> {
    let mut statement = db.prepare("SELECT provider_id, account_number, id FROM provider_accounts WHERE auth_file=? ORDER BY rowid").map_err(|error| error.to_string())?;
    let rows = statement.query_map([key], |row| Ok(json!({"providerId":row.get::<_, String>(0)?, "number":row.get::<_, u64>(1)?, "id":row.get::<_, String>(2)?})))
        .map_err(|error| error.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub(super) fn allocate(auth: &Path, id: &str, occupied: HashSet<String>) -> Result<Value> {
    let mut db = open(auth)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let key = key(auth)?;
    let maximum: u64 = transaction.query_row("SELECT COALESCE(MAX(account_number), 1) FROM provider_accounts WHERE auth_file=? AND provider_id=?", [key, id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let number = available_number(maximum, id, &occupied)?;
    let account = format!("{id}--piop-account-{number}");
    transaction.execute("INSERT INTO provider_accounts VALUES (?, ?, ?, ?)", rusqlite::params![key, id, number, account]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(json!({"providerId":id,"number":number,"id":account}))
}

fn available_number(maximum: u64, id: &str, occupied: &HashSet<String>) -> Result<u64> {
    let mut number = maximum;
    loop {
        number = number.checked_add(1).filter(|value| *value <= 9_007_199_254_740_991).ok_or("Provider account numbers are exhausted")?;
        if !occupied.contains(&format!("{id}--piop-account-{number}")) { return Ok(number); }
    }
}
