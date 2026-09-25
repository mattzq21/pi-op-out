fn default_agent() -> String { "general".into() }

fn default_settings() -> AppSettings {
    AppSettings {
        worktree_setup_scripts: vec![],
        default_agent: default_agent(),
        default_fast_mode: false,
         default_model: DEFAULT_MODEL.into(), hidden_models: vec![], known_models: None, default_thinking: "medium".into(), context_window_cap: default_context_window_cap(), context_window_cap_enabled: default_context_window_cap_enabled(), auto_retry: true, debug_mode: false, keybindings: default_keybindings(),
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"].iter().map(|name| json!({"name": name, "description": "Pi built-in tool", "enabled": true, "builtin": true})).chain([
            json!({"name":"list_agents","description":"List agents by machine and session","enabled":true,"builtin":false}),
            json!({"name":"send_message","description":"Send a message to another agent","enabled":true,"builtin":false}),
            json!({"name":"read_trace","description":"Extract clean user and final assistant messages from a Pi trace","enabled":true,"builtin":false}),
            codex_web_search_tool(),
        ]).collect(),
        skills: vec![], hosts: vec![],
    }
}

fn session_operation_tools() -> Vec<Value> {
    [("fork_session", "Fork a conversation in any project"), ("create_worktree", "Create a Git worktree"), ("remove_worktree", "Remove an unused Git worktree"), ("subagent", "Delegate parallel tasks to agents with saved transcripts"), ("request_user_input", "Ask the user questions with choices and free-text answers"), ("lookup_terminals", "Read session terminal activity through terminal-agent")].into_iter().map(|(name, description)| json!({"name":name,"description":description,"enabled":true,"builtin":false})).collect()
}

fn migrate_question_tool(settings: &mut AppSettings) {
    let has_current = settings.tools.iter().any(|tool| tool["name"] == "request_user_input");
    if has_current { settings.tools.retain(|tool| tool["name"] != "request_user_input_async"); }
    for tool in &mut settings.tools {
        if tool["name"] == "request_user_input_async" { tool["name"] = json!("request_user_input"); }
    }
}

fn codex_web_search_tool() -> Value {
    json!({"name":"web_search","description":"Search the web with Pi's Codex login and return cited answers","enabled":true,"builtin":false})
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") { return None; }
    content.lines().skip(1).take_while(|line| line.trim() != "---").find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_string())
    })
}

fn codex_disables_implicit_invocation(skill_directory: &Path) -> bool {
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

fn skill_path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn expand_skill_path(path: &str, home: &Path) -> PathBuf {
    path.strip_prefix("~/").map(|rest| home.join(rest)).unwrap_or_else(|| PathBuf::from(path))
}

fn discover_skills_in(root: &Path, include_root_markdown: bool) -> Vec<Value> {
    if !root.is_dir() { return Vec::new(); }

    let mut skill_files: Vec<PathBuf> = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 { return true; }
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .map(|entry| entry.into_path())
        .collect();
    skill_files.sort_by_key(|path| path.components().count());

    // A directory containing SKILL.md is one skill. Pi does not continue looking
    // for nested skills inside that directory.
    let mut skill_roots: Vec<PathBuf> = Vec::new();
    let mut discovered = Vec::new();
    for skill_file in skill_files {
        let directory = skill_file.parent().unwrap_or(&skill_file);
        if skill_roots.iter().any(|known| directory != known && directory.starts_with(known)) { continue; }
        skill_roots.push(directory.to_path_buf());
        let content = fs::read_to_string(&skill_file).unwrap_or_default();
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

    // Pi also treats direct .md children of ~/.pi/agent/skills as skills.
    if include_root_markdown {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) || path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") || path.extension().and_then(|extension| extension.to_str()) != Some("md") { continue; }
                let content = fs::read_to_string(&path).unwrap_or_default();
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
        }
    }
    discovered
}

fn merge_discovered_skills(settings: &mut AppSettings) {
    let Ok(home) = home_dir() else { return };
    merge_discovered_skills_at(settings, &home);
}

fn merge_discovered_skills_at(settings: &mut AppSettings, home: &Path) {
    let roots = [
        (home.join(".pi/agent/skills"), true),
        (home.join(".agents/skills"), false),
    ];
    let enabled_by_path: HashMap<PathBuf, bool> = settings.skills.iter().filter_map(|skill| {
        let path = expand_skill_path(skill.get("path")?.as_str()?, home);
        Some((path, skill.get("enabled").and_then(Value::as_bool).unwrap_or(true)))
    }).collect();

    // Preserve manually-added paths, but rebuild entries belonging to discovery
    // roots so deleted skills disappear and newly installed skills show up.
    settings.skills.retain(|skill| {
        let Some(path) = skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, home)) else { return true };
        !roots.iter().any(|(root, _)| skill_path_is_within(&path, root))
    });

    let mut known: HashSet<PathBuf> = settings.skills.iter().filter_map(|skill| skill.get("path").and_then(Value::as_str).map(|path| expand_skill_path(path, home))).collect();
    for (root, include_root_markdown) in roots {
        for mut skill in discover_skills_in(&root, include_root_markdown) {
            let Some(path) = skill.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
            if !known.insert(path.clone()) { continue; }
            if !skill.get("userInvokedOnly").and_then(Value::as_bool).unwrap_or(false) {
                if let Some(enabled) = enabled_by_path.get(&path) { skill["enabled"] = Value::Bool(*enabled); }
            }
            settings.skills.push(skill);
        }
    }
    settings.skills.sort_by(|left, right| {
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or("");
        let right_name = right.get("name").and_then(Value::as_str).unwrap_or("");
        left_name.to_lowercase().cmp(&right_name.to_lowercase())
    });
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn load_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    let mut settings = read_settings_at(&path)?;
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    merge_discovered_skills(&mut settings);
    Ok(settings)
}

fn read_settings_at(path: &Path) -> Result<AppSettings, String> {
    let mut settings = if !path.exists() { default_settings() } else { serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? };
    migrate_question_tool(&mut settings);
    for (legacy, replacements) in [
        ("exec_command", &["read", "bash", "grep", "find", "ls"][..]),
        ("apply_patch", &["edit", "write"][..]),
    ] {
        let enabled = settings.tools.iter().find(|tool| tool.get("name").and_then(Value::as_str) == Some(legacy))
            .and_then(|tool| tool.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
        settings.tools.retain(|tool| tool.get("name").and_then(Value::as_str) != Some(legacy));
        for name in replacements {
            if !settings.tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some(*name)) {
                settings.tools.push(json!({"name":name,"description":"Pi built-in tool","enabled":enabled,"builtin":true}));
            }
        }
    }
    if !settings.tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some("web_search")) {
        settings.tools.push(codex_web_search_tool());
    }
    migrate_keybindings(&mut settings);
    if settings.hosts.len() > MAX_REMOTE_HOSTS { return Err(format!("Settings contain more than {MAX_REMOTE_HOSTS} remote machines")); }
    Ok(settings)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn save_app_settings(app: AppHandle, mut settings: AppSettings, agent_host_id: Option<String>) -> Result<Value, String> {
    migrate_question_tool(&mut settings);
    for tool in session_operation_tools() {
        if !settings.tools.iter().any(|existing| existing["name"] == tool["name"]) { settings.tools.push(tool); }
    }
    let runtime = app.state::<PiRuntime>();
    let change = save_settings_with(&runtime, settings, agent_host_id,
        || settings_path(&app),
        |settings| daemon::invalidate_changed(&app, &runtime, settings),
        |settings| daemon::update_settings(&app, &runtime, settings))?;
    #[cfg(not(feature = "desktop"))]
    peers::invalidate(&app);
    let _ = app.emit("pi://settings-changed", &change);
    Ok(change)
}

fn validate_settings_for_save(settings: &AppSettings) -> Result<(), String> {
    if settings.context_window_cap < 1000 { return Err("Context window cap must be a whole number of at least 1000".into()); }
    validate_keybindings(settings)?;
    if settings.hosts.len() > MAX_REMOTE_HOSTS { return Err(format!("At most {MAX_REMOTE_HOSTS} remote machines can be configured")); }
    let mut host_ids = HashSet::new();
    let mut host_names = HashSet::from(["local".to_string()]);
    for host in &settings.hosts {
        if host.id.trim().is_empty() || !host_ids.insert(host.id.as_str()) { return Err("Every machine needs a unique id".into()); }
        let name = host.name.trim().to_lowercase();
        if name.is_empty() { return Err("Every machine needs a name".into()); }
        if !host_names.insert(name) { return Err(format!("Machine name '{}' is already in use", host.name.trim())); }
        validate_remote_host(host)?;
    }
    Ok(())
}

fn save_settings_with(
    runtime: &PiRuntime, mut settings: AppSettings, agent_host_id: Option<String>,
    path: impl FnOnce() -> Result<PathBuf, String>,
    invalidate: impl FnOnce(&AppSettings) -> Result<(), String>,
    synchronize: impl FnOnce(&AppSettings) -> Result<(), String>,
) -> Result<Value, String> {
    migrate_keybindings(&mut settings);
    validate_settings_for_save(&settings)?;
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    atomic_write_private(&path()?, &serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?)?;
    invalidate(&settings)?;
    let mut change = json!({"settings":settings});
    if let Some(host_id) = agent_host_id {
        let revision = runtime.agent_config_revision.fetch_add(1, Ordering::SeqCst) + 1;
        runtime.agent_config_revisions.lock().map_err(|_| "Agent configuration lock was poisoned")?.insert(host_id.clone(), revision);
        change["agentConfigChange"] = json!({"hostId":host_id,"revision":revision});
    }
    synchronize(&settings)?;
    Ok(change)
}
