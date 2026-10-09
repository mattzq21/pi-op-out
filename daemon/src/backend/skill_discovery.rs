use serde_json::{Value, json};
use std::fs;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use super::environment::home_dir;
use super::settings_types::AppSettings;
use walkdir::WalkDir;

pub(super) fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") { return None; }
    content.lines().skip(1).take_while(|line| line.trim() != "---").find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_string())
    })
}

pub(super) fn codex_disables_implicit_invocation(skill_directory: &Path) -> bool {
    let Ok(content) = fs::read_to_string(skill_directory.join("agents/openai.yaml")) else { return false };
    let mut policy_indent = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        let indent = line.len().saturating_sub(line.trim_start().len());
        if trimmed == "policy:" { policy_indent = Some(indent); continue; }
        let Some(parent_indent) = policy_indent else { continue };
        if indent <= parent_indent { policy_indent = None; continue; }
        let Some((key, value)) = trimmed.split_once(':') else { continue };
        if key.trim() == "allow_implicit_invocation" {
            return value.split('#').next().unwrap_or("").trim().trim_matches(['\'', '"']).eq_ignore_ascii_case("false");
        }
    }
    false
}

pub(super) fn skill_path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

pub(super) fn expand_skill_path(path: &str, home: &Path) -> PathBuf {
    path.strip_prefix("~/").map(|rest| home.join(rest)).unwrap_or_else(|| PathBuf::from(path))
}

#[cfg(test)]
pub(super) fn discover_skills_in(root: &Path, include_root_markdown: bool) -> Vec<Value> {
    discover_inventory(root, include_root_markdown).unwrap_or_default()
}

fn discover_inventory(root: &Path, include_root_markdown: bool) -> Result<Vec<Value>, String> {
    if !root.try_exists().map_err(|error| error.to_string())? { return Ok(Vec::new()); }

    let mut skill_files: Vec<PathBuf> = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 { return true; }
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        .into_iter()
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .map(|entry| entry.into_path())
        .collect();
    skill_files.sort_by_key(|path| path.components().count());

    let mut skill_roots: Vec<PathBuf> = Vec::new();
    let mut discovered = Vec::new();
    for skill_file in skill_files {
        let directory = skill_file.parent().unwrap_or(&skill_file);
        if skill_roots.iter().any(|known| directory != known && directory.starts_with(known)) { continue; }
        skill_roots.push(directory.to_path_buf());
        let content = fs::read_to_string(&skill_file).map_err(|error| error.to_string())?;
        let fallback = directory.file_name().and_then(|value| value.to_str()).unwrap_or("skill");
        let claude_user_only = frontmatter_value(&content, "disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true"));
        let codex_user_only = codex_disables_implicit_invocation(directory);
        discovered.push(json!({
            "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()),
            "path": directory.to_string_lossy(),
            "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()),
            "enabled": true,
            "discovered": true,
            "userInvokedOnly": claude_user_only || codex_user_only,
        }));
    }

    if include_root_markdown { discovered.extend(root_markdown(root)?); }
    Ok(discovered)
}

fn root_markdown(root: &Path) -> Result<Vec<Value>, String> {
    let mut discovered = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() || path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") || path.extension().and_then(|extension| extension.to_str()) != Some("md") { continue; }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("skill");
        let claude_user_only = frontmatter_value(&content, "disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true"));
        discovered.push(json!({
            "name": frontmatter_value(&content, "name").unwrap_or_else(|| fallback.to_string()),
            "path": path.to_string_lossy(),
            "description": frontmatter_value(&content, "description").unwrap_or_else(|| "Pi skill".into()),
            "enabled": true,
            "discovered": true,
            "userInvokedOnly": claude_user_only,
        }));
    }
    Ok(discovered)
}

pub(super) fn refresh_skills() -> Result<(), String> {
    saved_skills(&home_dir()?, true).map(|_| ())
}

fn saved_skills(home: &Path, refresh: bool) -> Result<Vec<Value>, String> {
    let root = home.join(".agents/skills");
    let path = home.join(crate::STORAGE_DIRECTORY).join("settings.json");
    crate::settings_storage::records::skill_inventory(&path, &root, refresh, || discover_inventory(&root, false))
}

pub(super) fn merge_discovered_skills(settings: &mut AppSettings) -> Result<(), String> {
    let home = home_dir()?;
    let skills = saved_skills(&home, false)?;
    merge_skills(settings, &home, skills);
    Ok(())
}

#[cfg(test)]
pub(super) fn merge_discovered_skills_at(settings: &mut AppSettings, home: &Path) {
    merge_skills(settings, home, discover_skills_in(&home.join(".agents/skills"), false));
}

fn merge_skills(settings: &mut AppSettings, home: &Path, skills: Vec<Value>) {
    let root = home.join(".agents/skills");
    let enabled_by_path: HashMap<PathBuf, bool> = settings.skills.iter().filter_map(|skill| {
        let path = expand_skill_path(skill.get("path")?.as_str()?, home);
        Some((path, skill.get("enabled").and_then(Value::as_bool).unwrap_or(true)))
    }).collect();

    settings.skills.retain(|skill| {
        let Some(path) = skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, home)) else { return true };
        !skill_path_is_within(&path, &root)
    });

    let mut known: HashSet<PathBuf> = settings.skills.iter().filter_map(|skill| skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, home))).collect();
    for mut skill in skills {
        let Some(path) = skill.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
        if !known.insert(path.clone()) { continue; }
        if !skill.get("userInvokedOnly").and_then(Value::as_bool).unwrap_or(false) {
            if let Some(enabled) = enabled_by_path.get(&path) { skill["enabled"] = Value::Bool(*enabled); }
        }
        settings.skills.push(skill);
    }
    settings.skills.sort_by(|left, right| {
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or("");
        let right_name = right.get("name").and_then(Value::as_str).unwrap_or("");
        left_name.to_lowercase().cmp(&right_name.to_lowercase())
    });
}
