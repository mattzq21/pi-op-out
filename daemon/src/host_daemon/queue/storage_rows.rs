use super::super::protocol::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) fn item_id(item: &Value) -> Result<i64> {
    item["id"].as_str().and_then(|id| id.parse::<i64>().ok()).filter(|id| *id > 0)
        .ok_or_else(|| "Invalid queue item ID".into())
}

pub(super) fn load(db: &Connection, session: &str) -> Result<Vec<Value>> {
    let mut statement = db.prepare("SELECT queue_item_id, message, behavior, details_json FROM queue_items WHERE session_id=? ORDER BY queue_position").map_err(|error| error.to_string())?;
    let rows = statement.query_map([session], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let (id, message, behavior, details) = row.map_err(|error| error.to_string())?;
        let mut item: Value = serde_json::from_str(&details).map_err(|error| error.to_string())?;
        item["id"] = json!(id.to_string());
        item["message"] = json!(message);
        item["behavior"] = json!(behavior);
        let images = load_images(db, id)?;
        if !images.is_empty() { item["images"] = json!(images); }
        items.push(item);
    }
    Ok(items)
}

fn load_images(db: &Connection, id: i64) -> Result<Vec<Value>> {
    let mut statement = db.prepare("SELECT media_type, data, details_json FROM queue_attachments WHERE queue_item_id=? ORDER BY attachment_position").map_err(|error| error.to_string())?;
    let rows = statement.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())?;
    let mut images = Vec::new();
    for row in rows {
        let (media_type, data, details) = row.map_err(|error| error.to_string())?;
        let mut image: Value = serde_json::from_str(&details).map_err(|error| error.to_string())?;
        image["mimeType"] = json!(media_type);
        image["data"] = json!(STANDARD.encode(data));
        images.push(image);
    }
    Ok(images)
}

fn details(item: &Value, omitted: &[&str]) -> Result<String> {
    let mut fields = item.as_object().ok_or("Invalid queue item")?.clone();
    for key in omitted { fields.remove(*key); }
    Ok(Value::Object(fields).to_string())
}

pub(super) fn save(db: &Connection, session: &str, items: &[Value]) -> Result<()> {
    let ids = items.iter().map(item_id).collect::<Result<Vec<_>>>()?;
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() { return Err("Duplicate queue item ID".into()); }
    db.execute("DELETE FROM queue_items WHERE session_id=? AND queue_item_id NOT IN (SELECT value FROM json_each(?))", params![session, json!(ids).to_string()]).map_err(|error| error.to_string())?;
    for (index, item) in items.iter().enumerate() { save_item(db, session, index + 1, item)?; }
    Ok(())
}

fn save_item(db: &Connection, session: &str, position: usize, item: &Value) -> Result<()> {
    let id = item_id(item)?;
    let written = db.execute("INSERT INTO queue_items VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(queue_item_id) DO UPDATE SET
        queue_position=excluded.queue_position, message=excluded.message, behavior=excluded.behavior, details_json=excluded.details_json
        WHERE queue_items.session_id=excluded.session_id", params![id, session, position, item["message"].as_str(), item["behavior"].as_str(), details(item, &["id", "message", "behavior", "images"])?]).map_err(|error| error.to_string())?;
    if written != 1 { return Err("Queue item belongs to another session".into()); }
    let images = item["images"].as_array().map(Vec::as_slice).unwrap_or_default();
    db.execute("DELETE FROM queue_attachments WHERE queue_item_id=? AND attachment_position>?", params![id, images.len()]).map_err(|error| error.to_string())?;
    for (index, image) in images.iter().enumerate() { save_image(db, id, index + 1, image)?; }
    Ok(())
}

fn save_image(db: &Connection, id: i64, position: usize, image: &Value) -> Result<()> {
    let data = STANDARD.decode(image["data"].as_str().ok_or("Missing queue attachment data")?).map_err(|error| error.to_string())?;
    db.execute("INSERT INTO queue_attachments (queue_item_id, attachment_position, media_type, data, details_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(queue_item_id, attachment_position) DO UPDATE SET media_type=excluded.media_type, data=excluded.data, details_json=excluded.details_json",
        params![id, position, image["mimeType"].as_str(), data, details(image, &["data", "mimeType"])?]).map_err(|error| error.to_string())?;
    Ok(())
}
