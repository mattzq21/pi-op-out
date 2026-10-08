use std::collections::{HashMap, HashSet};
use super::settings_types::AppSettings;

pub(super) fn default_keybindings() -> HashMap<String, String> {
    [
        ("newConversation", "Ctrl+N"),
        ("toggleConversations", "Ctrl+B"),
        ("toggleTerminal", "Ctrl+J"),
        ("toggleDebugMode", "Ctrl+D"),
        ("focusComposer", "Ctrl+E"),
        ("openSettings", "Ctrl+,"),
    ].into_iter().map(|(action, shortcut)| (action.into(), shortcut.into())).collect()
}

pub(super) fn canonical_shortcut(shortcut: &str) -> Result<Option<String>, String> {
    let mut raw: Vec<&str> = shortcut.split('+').collect();
    let mut plus_key = false;
    if raw.len() > 1 && raw[raw.len() - 1].trim().is_empty() { plus_key = true; raw.pop(); }
    let mut parts: Vec<String> = raw.iter().map(|part| part.trim().to_lowercase()).filter(|part| !part.is_empty()).collect();
    if plus_key { parts.push("+".to_string()); }
    if parts.is_empty() { return Ok(None); }
    let modifiers = ["ctrl", "meta", "alt", "shift", "mod"];
    let keys: Vec<&String> = parts.iter().filter(|part| !modifiers.contains(&part.as_str())).collect();
    if keys.len() != 1 { return Err(format!("Shortcut '{shortcut}' needs exactly one key")); }
    let key = keys[0];
    if ["control", "meta", "alt", "shift", "mod"].contains(&key.as_str()) { return Err(format!("Shortcut '{shortcut}' needs a key")); }
    let protected = parts.iter().any(|part| matches!(part.as_str(), "ctrl" | "meta" | "alt" | "mod"));
    if !protected { return Err(format!("Shortcut '{shortcut}' needs Ctrl, Alt, or Meta")); }
    let mut canonical: Vec<&str> = modifiers.iter().copied().filter(|modifier| parts.iter().any(|part| part == modifier)).collect(); canonical.push(key); Ok(Some(canonical.join("+")))
}

pub(super) fn migrate_keybindings(settings: &mut AppSettings) {
    let supported = default_keybindings();
    settings.keybindings.retain(|action, _| supported.contains_key(action));
    for (action, shortcut) in supported {
        settings.keybindings.entry(action).or_insert(shortcut);
    }
    if settings.keybindings.get("focusComposer").map(String::as_str) == Some("Ctrl+L") {
        settings.keybindings.insert("focusComposer".into(), "Ctrl+E".into());
    }
}

pub(super) fn validate_keybindings(settings: &AppSettings) -> Result<(), String> {
    let mut shortcuts = HashSet::new();
    for shortcut in settings.keybindings.values() {
        if let Some(canonical) = canonical_shortcut(shortcut)? {
            if matches!(canonical.as_str(), "ctrl+g" | "meta+g" | "mod+g") { return Err(format!("Shortcut '{shortcut}' is reserved for conversation search")); }
            if !shortcuts.insert(canonical) { return Err(format!("Shortcut '{shortcut}' is assigned more than once")); }
        }
    }
    Ok(())
}
