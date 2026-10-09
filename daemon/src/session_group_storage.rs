use super::{SessionGroup, SessionGroups};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use std::{collections::HashSet, path::Path};

fn database(path: &Path) -> Result<Connection, String> {
    let parent = path.parent().ok_or("Session group storage has no directory")?;
    let root = if parent.file_name().is_some_and(|name| name == "sessions") {
        parent.parent().ok_or("Session group storage has no root")?
    } else { parent };
    let database = crate::session_registry::open(root)?;
    database.execute("INSERT INTO session_group_state VALUES (1, 0) ON CONFLICT DO NOTHING", []).map_err(|error| error.to_string())?;
    Ok(database)
}



pub(super) fn read(path: &Path) -> Result<Option<SessionGroups>, String> {
    let mut database = database(path)?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let initialized: bool = transaction.query_row("SELECT initialized FROM session_group_state WHERE id=1", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !initialized { return Ok(None); }
    let groups = load_groups(&transaction).map_err(|error| error.to_string())?;
    let mut assignments = transaction.prepare("SELECT session_key, group_id FROM session_group_assignments").map_err(|error| error.to_string())?;
    let assignments = assignments.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
        .map_err(|error| error.to_string())?.collect::<rusqlite::Result<_>>().map_err(|error| error.to_string())?;
    let removed_projects = string_set(&transaction, "SELECT project_id FROM session_group_removed_projects")?;
    Ok(Some(SessionGroups { groups, assignments, removed_projects }))
}

fn load_groups(database: &Connection) -> rusqlite::Result<Vec<SessionGroup>> {
    let mut statement = database.prepare("SELECT group_id, name, cwd, host_id, host_name FROM session_groups ORDER BY position, group_id")?;
    let rows = statement.query_map([], |row| {
        Ok(SessionGroup { id: row.get(0)?, name: row.get(1)?, cwd: row.get(2)?, host_id: row.get(3)?, host_name: row.get(4)? })
    })?;
    rows.collect()
}

pub(super) fn write(path: &Path, groups: &SessionGroups) -> Result<(), String> {
    let mut database = database(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    save_groups(&transaction, groups)?;
    transaction.execute("UPDATE session_group_state SET initialized=1 WHERE id=1", []).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn save_groups(transaction: &Transaction<'_>, groups: &SessionGroups) -> Result<(), String> {
    transaction.execute_batch("DELETE FROM session_groups; DELETE FROM session_group_assignments; DELETE FROM session_group_removed_projects;")
        .map_err(|error| error.to_string())?;
    for (position, group) in groups.groups.iter().enumerate() {
        transaction.execute("INSERT INTO session_groups (group_id, position, name, cwd, host_id, host_name) VALUES (?, ?, ?, ?, ?, ?)",
            params![group.id, position as u64, group.name, group.cwd, group.host_id, group.host_name])
            .map_err(|error| error.to_string())?;
    }
    for (key, group) in &groups.assignments {
        transaction.execute("INSERT INTO session_group_assignments VALUES (?, ?)", params![key, group]).map_err(|error| error.to_string())?;
    }
    for project in &groups.removed_projects {
        transaction.execute("INSERT INTO session_group_removed_projects VALUES (?)", [project]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn string_set(database: &Connection, sql: &str) -> Result<HashSet<String>, String> {
    let mut statement = database.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get(0)).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|error| error.to_string())
}

pub(super) fn deleted(path: &Path) -> Result<HashSet<String>, String> {
    string_set(&database(path)?, "SELECT session_key FROM session_group_deletions")
}

fn save_deleted(transaction: &Transaction<'_>, deleted: &HashSet<String>) -> Result<(), String> {
    for key in deleted {
        transaction.execute("INSERT OR IGNORE INTO session_group_deletions VALUES (?)", [key]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn remember_deleted(path: &Path, deleted: &HashSet<String>) -> Result<(), String> {
    let mut database = database(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    save_deleted(&transaction, deleted)?;
    transaction.execute("DELETE FROM session_group_assignments WHERE session_key IN (SELECT session_key FROM session_group_deletions)", [])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}
