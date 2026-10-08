use crate::{CachedSession, SessionSummary};
use rusqlite::{params, Connection};
use std::{collections::HashMap, path::{Path, PathBuf}};

pub(super) fn open(root: &Path) -> Result<Connection, String> {
    crate::session_registry::open(root)
}

pub(super) fn load(connection: &Connection) -> Result<HashMap<PathBuf, CachedSession>, String> {
    let mut statement = connection.prepare("SELECT s.session_id, s.session_path, c.fingerprint, c.modified_at, c.summary_json
        FROM session_sidebar c JOIN sessions s USING(session_id)
        WHERE NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id=lower(s.session_id))")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
        row.get::<_, String>(2)?, row.get::<_, u64>(3)?, row.get::<_, String>(4)?))).map_err(|error| error.to_string())?;
    let mut cache = HashMap::new();
    for row in rows {
        let (id, path, fingerprint, modified_at, body) = row.map_err(|error| error.to_string())?;
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&body) else { continue; };
        let Some(object) = value.as_object_mut() else { continue; };
        object.insert("id".into(), id.into()); object.insert("path".into(), path.clone().into());
        let Ok(mut summary) = serde_json::from_value::<SessionSummary>(value) else { continue; };
        summary.modified_at = modified_at;
        cache.insert(PathBuf::from(path), CachedSession { fingerprint, summary });
    }
    Ok(cache)
}

pub(super) fn save(connection: &mut Connection, cache: &HashMap<PathBuf, CachedSession>) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute_batch("CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY); DELETE FROM sidebar_seen;")
        .map_err(|error| error.to_string())?;
    for cached in cache.values() {
        save_row(&transaction, cached)?;
    }
    transaction.execute("DELETE FROM session_sidebar WHERE session_id NOT IN (SELECT session_id FROM sidebar_seen)", [])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn save_row(transaction: &rusqlite::Transaction<'_>, cached: &CachedSession) -> Result<(), String> {
    let summary = &cached.summary;
    let deleted: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?))",
        [&summary.id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if deleted { return Ok(()); }
    let mut value = serde_json::to_value(summary).map_err(|error| error.to_string())?;
    if let Some(object) = value.as_object_mut() { object.remove("id"); object.remove("path"); }
    let registered: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND session_path=?)",
        params![summary.id, summary.path], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !registered { return Ok(()); }
    transaction.execute("INSERT INTO session_sidebar VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
            fingerprint=excluded.fingerprint, modified_at=excluded.modified_at, summary_json=excluded.summary_json
            WHERE session_sidebar.fingerprint != excluded.fingerprint OR session_sidebar.summary_json != excluded.summary_json",
            params![summary.id, cached.fingerprint, summary.modified_at, value.to_string()]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT OR IGNORE INTO sidebar_seen VALUES (?)", [&summary.id]).map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn prepare(database: &mut Option<(PathBuf, Connection)>, root: &Path, cache: &mut HashMap<PathBuf, CachedSession>) -> bool {
    if database.as_ref().is_some_and(|(path, _)| path == root) { return false; }
    *database = None;
    match open(root).and_then(|connection| load(&connection).map(|saved| (connection, saved))) {
        Ok((connection, saved)) => { cache.extend(saved); *database = Some((root.to_path_buf(), connection)); }
        Err(error) => eprintln!("Could not load saved sidebar: {error}"),
    }
    true
}

pub(super) fn persist(database: &mut Option<(PathBuf, Connection)>, cache: &HashMap<PathBuf, CachedSession>) {
    let Some((_, connection)) = database.as_mut() else { return; };
    if let Err(error) = save(connection, cache) {
        eprintln!("Could not save sidebar: {error}");
        *database = None;
    }
}
