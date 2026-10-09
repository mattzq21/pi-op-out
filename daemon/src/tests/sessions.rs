#[test]
fn worktree_scripts_run_in_order_with_context_and_cleanup_in_reverse() {
    let root = TestDirectory::new(); let source = root.0.join("source"); fs::create_dir(&source).unwrap();
    test_git(&source, &["init", "--initial-branch=main"]); test_git(&source, &["commit", "--allow-empty", "-m", "Initial"]);
    let target = root.0.join("target"); test_git(&source, &["worktree", "add", "-b", "feature", target.to_str().unwrap()]);
    let mut settings = default_settings();
    settings.worktree_setup_scripts = vec![
        setup_script("first", &source, "printf 'first\\n' >> order; printf '%s\\n' \"$PIOP_SOURCE_TREE_PATH\" \"$PIOP_WORKTREE_PATH\" \"$PIOP_WORKTREE_BRANCH\" > context", "printf 'undo-first\\n' >> order"),
        setup_script("second", &source, "printf 'second\\n' >> order", "printf 'undo-second\\n' >> order"),
    ];
    let mut disabled = setup_script("disabled", &source, "exit 99", "exit 99"); disabled.enabled = false;
    let mut remote = setup_script("remote", &source, "exit 99", "exit 99"); remote.host_id = Some("remote".into());
    let mut unassigned = setup_script("unassigned", &source, "exit 99", "exit 99"); unassigned.project_path = None;
    settings.worktree_setup_scripts.extend([disabled, remote, unassigned, setup_script("empty", &source, " ", " ")]);
    for phase in [WorktreeScriptPhase::Setup, WorktreeScriptPhase::Cleanup] {
        run_worktree_scripts(&settings, source.to_str().unwrap(), target.to_str().unwrap(), "local", &AtomicBool::new(false), phase).unwrap();
    }
    assert_eq!(fs::read_to_string(target.join("order")).unwrap(), "first\nsecond\nundo-second\nundo-first\n");
    assert_eq!(fs::read_to_string(target.join("context")).unwrap(), format!("{}\n{}\nfeature\n", source.canonicalize().unwrap().display(), target.canonicalize().unwrap().display()));
}

#[test]
fn worktree_script_failure_stops_later_scripts_and_includes_diagnostics() {
    let root = TestDirectory::new(); test_git(&root.0, &["init", "--initial-branch=main"]);
    let mut settings = default_settings();
    settings.worktree_setup_scripts = vec![
        setup_script("dependencies", &root.0, "echo 'installation refused' >&2; exit 7", ""),
        setup_script("later", &root.0, "touch should-not-exist", ""),
    ];
    let error = run_worktree_scripts(&settings, root.0.to_str().unwrap(), root.0.to_str().unwrap(), "local", &AtomicBool::new(false), WorktreeScriptPhase::Setup).unwrap_err();
    assert!(error.contains("Setup script 'dependencies' failed (exit status 7)"), "{error}"); assert!(error.contains("installation refused"), "{error}");
    assert!(!root.0.join("should-not-exist").exists());
    settings.worktree_setup_scripts[0].script = "x".repeat(32 * 1024 + 1);
    assert!(run_worktree_scripts(&settings, "unused", "unused", "local", &AtomicBool::new(false), WorktreeScriptPhase::Setup).unwrap_err().contains("script exceeds 32 KiB"));
    assert_eq!(run_worktree_scripts(&settings, "unused", "unused", "local", &AtomicBool::new(true), WorktreeScriptPhase::Setup).unwrap_err(), "Environment setup cancelled");
    settings.worktree_setup_scripts[0].cleanup_script = Some("echo cleanup".into());
    assert_eq!(run_worktree_scripts(&settings, "unused", "unused", "local", &AtomicBool::new(true), WorktreeScriptPhase::Cleanup).unwrap_err(), "Worktree cleanup cancelled");
}

#[test]
fn session_file_validation_restricts_access_to_the_correct_store() {
    let home = TestDirectory::new();
    for (store, validate) in [
        ("sessions", local_desktop_session_file_at as fn(&Path, &str) -> Result<PathBuf, String>),
        ("archived", local_archived_session_file_at as fn(&Path, &str) -> Result<PathBuf, String>),
    ] {
        assert!(validate(&home.0, "missing").unwrap_err().contains("Could not locate piop"));
        let root = home.0.join(STORAGE_DIRECTORY).join(store); fs::create_dir_all(root.join("nested")).unwrap();
        let valid = root.join("nested/chat.jsonl"); fs::write(&valid, "session").unwrap();
        assert_eq!(validate(&home.0, valid.to_str().unwrap()).unwrap(), valid.canonicalize().unwrap());
        let wrong_type = root.join("chat.json"); fs::write(&wrong_type, "{}").unwrap();
        let directory = root.join("directory.jsonl"); fs::create_dir(&directory).unwrap();
        let outside = home.0.join("outside.jsonl"); fs::write(&outside, "outside").unwrap();
        for path in [&wrong_type, &directory, &outside] {
            assert!(validate(&home.0, path.to_str().unwrap()).unwrap_err().starts_with("Only "));
        }
        assert!(validate(&home.0, root.join("missing.jsonl").to_str().unwrap()).unwrap_err().starts_with("Could not locate"));
    }
    let active = home.0.join(STORAGE_DIRECTORY).join("sessions/nested/chat.jsonl");
    let archived = home.0.join(".piop/archived/nested/chat.jsonl");
    assert!(local_desktop_session_file_at(&home.0, archived.to_str().unwrap()).is_err());
    assert!(local_archived_session_file_at(&home.0, active.to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn session_file_validation_resolves_symlinks_before_checking_store_boundaries() {
    use std::os::unix::fs::symlink;
    let home = TestDirectory::new(); let root = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&root).unwrap();
    let valid = root.join("chat.jsonl"); fs::write(&valid, "session").unwrap();
    let alias = root.join("alias.jsonl"); symlink(&valid, &alias).unwrap();
    assert_eq!(local_desktop_session_file_at(&home.0, alias.to_str().unwrap()).unwrap(), valid.canonicalize().unwrap());
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, "outside").unwrap();
    let escape = root.join("escape.jsonl"); symlink(&outside, &escape).unwrap();
    assert_eq!(local_desktop_session_file_at(&home.0, escape.to_str().unwrap()).unwrap_err(), "Only piop session files can be accessed");
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
}

#[test]
fn saved_diffs_load_legacy_and_located_snapshots_and_allow_unsaved_sessions() {
    let home = TestDirectory::new(); let root = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&root).unwrap();
    let session = root.join("chat.jsonl"); let path = session.to_str().unwrap();
    assert!(load_local_git_diffs(&home.0, path).unwrap().is_empty());
    fs::write(&session, "session").unwrap();
    assert!(load_local_git_diffs(&home.0, path).unwrap().is_empty());
    let value = json!({"old":"legacy patch","new":{"patch":"located patch","repositoryRoot":"/repo"}});
    atomic_write_private(&session.with_extension("diffs.json"), value.to_string().as_bytes()).unwrap();
    let snapshots = load_local_git_diffs(&home.0, path).unwrap();
    assert_eq!(serde_json::to_value(snapshots).unwrap(), value);
    assert!(load_local_git_diffs(&home.0, home.0.join("outside.jsonl").to_str().unwrap()).is_err());
    assert!(load_local_git_diffs(&home.0, root.join("wrong.txt").to_str().unwrap()).is_err());
}

#[test]
fn saved_diff_loading_rejects_corruption_invalid_utf8_and_oversized_sidecars() {
    let home = TestDirectory::new(); let root = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&root).unwrap();
    let session = root.join("chat.jsonl"); fs::write(&session, "session").unwrap();
    let sidecar = session.with_extension("diffs.json"); let path = session.to_str().unwrap();
    fs::write(&sidecar, "not json").unwrap();
    assert!(load_local_git_diffs(&home.0, path).err().unwrap().contains("Could not parse saved diffs"));
    fs::write(&sidecar, [255]).unwrap();
    assert!(load_local_git_diffs(&home.0, path).err().unwrap().contains("Could not read saved diffs"));
    let file = fs::OpenOptions::new().write(true).open(&sidecar).unwrap(); file.set_len(MAX_GIT_DIFFS_BYTES as u64 + 1).unwrap();
    assert_eq!(load_local_git_diffs(&home.0, path).err().unwrap(), "Saved diffs exceed the 16 MiB limit");
}
#[test]
fn skill_rediscovery_preserves_preferences_manual_entries_and_refreshes_metadata() {
    let home = TestDirectory::new(); let root = home.0.join(".agents/skills");
    fs::create_dir_all(root.join("existing")).unwrap(); fs::create_dir_all(root.join("new")).unwrap();
    fs::write(root.join("existing/SKILL.md"), "---\nname: Alpha\ndescription: Updated metadata\n---\n").unwrap();
    fs::write(root.join("new/SKILL.md"), "---\nname: beta\n---\n").unwrap();
    let manual = json!({"name":"Manual","path":"/custom/skill","enabled":false});
    let mut settings = default_settings();
    settings.skills = vec![
        json!({"name":"Old metadata","path":"~/.agents/skills/existing","enabled":false}),
        json!({"name":"Deleted","path":"~/.agents/skills/deleted","enabled":true}),
        manual.clone(), json!({"name":"No path"}),
    ];
    merge_discovered_skills_at(&mut settings, &home.0);
    assert_eq!(settings.skills.len(), 4);
    assert_eq!(settings.skills.iter().map(|skill| skill["name"].as_str().unwrap()).collect::<Vec<_>>(), ["Alpha", "beta", "Manual", "No path"]);
    assert_eq!(settings.skills[0]["enabled"], false); assert_eq!(settings.skills[0]["description"], "Updated metadata");
    assert_eq!(settings.skills[1]["enabled"], true); assert_eq!(settings.skills[2], manual);
    let once = settings.skills.clone(); merge_discovered_skills_at(&mut settings, &home.0); assert_eq!(settings.skills, once);
    fs::remove_dir_all(root.join("existing")).unwrap(); merge_discovered_skills_at(&mut settings, &home.0);
    assert_eq!(settings.skills.len(), 3); assert!(!settings.skills.iter().any(|skill| skill["name"] == "Alpha"));
}

#[test]
fn explicit_invocation_skills_remain_available_and_pi_root_markdown_is_discovered() {
    let home = TestDirectory::new(); let root = home.0.join(".pi/agent/skills"); fs::create_dir_all(root.join("explicit")).unwrap();
    fs::write(root.join("explicit/SKILL.md"), "---\nname: Explicit\ndisable-model-invocation: true\n---\n").unwrap();
    fs::write(root.join("quick.md"), "Quick skill").unwrap();
    let mut settings = default_settings(); settings.skills = vec![json!({"path":"~/.pi/agent/skills/explicit","enabled":false})];
    merge_discovered_skills_at(&mut settings, &home.0);
    let explicit = settings.skills.iter().find(|skill| skill["name"] == "Explicit").unwrap();
    assert_eq!(explicit["userInvokedOnly"], true); assert_eq!(explicit["enabled"], true);
    assert!(settings.skills.iter().any(|skill| skill["name"] == "quick"));
}
#[test]
fn blank_session_cleanup_removes_only_matching_unused_sessions_and_sidecars() {
    let root = TestDirectory::new(); let path = root.0.join("date_chat.jsonl");
    let body = format!("{}\n", json!({"type":"session","id":"chat","cwd":"/repo"}));
    fs::write(&path, &body).unwrap(); fs::write(path.with_extension("diffs.json"), "{}").unwrap();
    cleanup_blank_session_at(BlankSessionCleanup { path: None, id: Some("chat".into()), host: None, submitted: false }, Some(&root.0));
    assert!(!path.exists()); assert!(!path.with_extension("diffs.json").exists());
    for (content, id, submitted) in [
        (body.clone(), "other", false),
        (body.clone(), "chat", true),
        (format!("{body}{}\n", json!({"type":"message","message":{"role":"user","content":"Keep"}})), "chat", false),
        (format!("{body}incomplete json"), "chat", false),
    ] {
        fs::write(&path, &content).unwrap();
        cleanup_blank_session_at(BlankSessionCleanup { path: Some(path.to_string_lossy().into_owned()), id: Some(id.into()), host: None, submitted }, Some(&root.0));
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }
}

#[test]
fn blank_session_cleanup_does_not_delete_files_outside_the_store() {
    let root = TestDirectory::new(); let outside = TestDirectory::new();
    let path = outside.0.join("chat.jsonl"); fs::write(&path, "{\"type\":\"session\",\"id\":\"chat\"}\n").unwrap();
    cleanup_blank_session_at(BlankSessionCleanup { path: Some(path.to_string_lossy().into_owned()), id: Some("chat".into()), host: None, submitted: false }, Some(&root.0));
    assert!(path.exists());
}
#[test]
fn snapshot_token_validation_rejects_malformed_tokens_before_accessing_storage() {
    for token in ["", "null", "{}", r#"{"root":42,"tree":"abc","repositoryRoot":"/repo"}"#] {
        assert_eq!(parse_local_snapshot_with(token, || panic!("invalid token accessed storage")).err().unwrap(), "Invalid Git snapshot token");
    }
    for tree in ["a".repeat(39), "a".repeat(65), "g".repeat(40), format!("{};", "a".repeat(39))] {
        let token = json!({"root":"/unused","tree":tree,"repositoryRoot":"/repo"}).to_string();
        assert_eq!(parse_local_snapshot_with(&token, || panic!("invalid tree accessed storage")).err().unwrap(), "Invalid Git snapshot tree");
    }
}

#[test]
fn snapshot_token_validation_checks_storage_errors_expiry_and_canonical_location() {
    let temporary = TestDirectory::new();
    let parent = temporary.0.join("snapshots"); fs::create_dir(&parent).unwrap();
    let root = parent.join("pi-desktop-diff-test"); fs::create_dir(&root).unwrap();
    for length in [40, 64] { for token_root in [&root, &root.join("..").join("pi-desktop-diff-test")] {
        let token = json!({"root":token_root,"tree":"A".repeat(length),"repository_root":"/repo"}).to_string();
        let parsed = parse_local_snapshot_with(&token, || Ok(parent.clone())).unwrap();
        assert_eq!(parsed.root, root.canonicalize().unwrap().to_string_lossy());
        assert_eq!(parsed.tree, "A".repeat(length)); assert_eq!(parsed.repository_root, "/repo");
        assert_eq!(parse_local_snapshot_with(&token, || Err("storage failed".into())).err().unwrap(), "storage failed");
        assert!(parse_local_snapshot_with(&token, || Ok(temporary.0.join("missing"))).is_err());
    } }
    let token = json!({"root":root,"tree":"a".repeat(40),"repositoryRoot":"/repo"}).to_string();
    fs::remove_dir(&root).unwrap();
    assert_eq!(parse_local_snapshot_with(&token, || Ok(parent.clone())).err().unwrap(), "Git snapshot expired");
    let outside = temporary.0.join("pi-desktop-diff-outside"); fs::create_dir(&outside).unwrap();
    let token = json!({"root":outside,"tree":"a".repeat(40),"repositoryRoot":"/repo"}).to_string();
    assert_eq!(parse_local_snapshot_with(&token, || Ok(parent)).err().unwrap(), "Invalid Git snapshot location");
    assert!(outside.exists());
}

#[test]
fn saved_settings_migrate_legacy_tools_without_overwriting_explicit_preferences() {
    let directory = TestDirectory::new(); let path = directory.0.join("settings.json");
    let mut settings = default_settings();
    settings.tools = vec![json!({"name":"exec_command","enabled":false}), json!({"name":"apply_patch","enabled":true}), json!({"name":"read","enabled":true}), json!({"name":"edit","enabled":false})];
    fs::write(&path, serde_json::to_vec(&settings).unwrap()).unwrap(); let before = fs::read(&path).unwrap();
    let migrated = read_settings_at(&path).unwrap();
    let enabled = |name: &str| migrated.tools.iter().find(|tool| tool["name"] == name).unwrap()["enabled"].as_bool().unwrap();
    assert!(enabled("read")); assert!(!enabled("edit")); assert!(enabled("write")); assert!(enabled("web_search"));
    for name in ["bash", "grep", "find", "ls"] { assert!(!enabled(name)); }
    assert!(!migrated.tools.iter().any(|tool| tool["name"] == "exec_command" || tool["name"] == "apply_patch"));
    assert_eq!(fs::read(&path).unwrap(), before, "loading must not rewrite saved settings");
    fs::write(&path, serde_json::to_vec(&migrated).unwrap()).unwrap();
    assert_eq!(read_settings_at(&path).unwrap().tools, migrated.tools, "migration must be idempotent");
}

#[test]
fn settings_loading_defaults_only_when_absent_and_rejects_corrupt_or_excessive_configuration() {
    let directory = TestDirectory::new(); let path = directory.0.join("settings.json");
    assert_eq!(read_settings_at(&path).unwrap().default_model, default_settings().default_model);
    assert!(!path.exists());
    fs::write(&path, "broken json").unwrap(); assert!(read_settings_at(&path).is_err());
    let mut settings = default_settings();
    settings.hosts = vec![RemoteHost { enabled: true, id: "remote".into(), name: "Remote".into(), target: "host".into(), pi_path: "pi".into() }; MAX_REMOTE_HOSTS + 1];
    fs::write(&path, serde_json::to_vec(&settings).unwrap()).unwrap();
    assert!(read_settings_at(&path).err().unwrap().contains("remote machines"));
}
#[test]
fn summary_ingestion_ignores_unrequested_paths_and_preserves_trusted_file_metadata() {
    let candidates = vec![("/requested.jsonl".into(), "trusted-fingerprint".into(), 123, 456), ("/defaults.jsonl".into(), "defaults".into(), 789, 12)];
    let host = RemoteHost { enabled: true, id: "remote".into(), name: "Server".into(), target: "unused.invalid".into(), pi_path: "pi".into() };
    let lines = [
        "invalid JSON".to_string(), "null".into(), "{}".into(), json!({"path":17}).to_string(),
        json!({"path":"/injected.jsonl","id":"injected"}).to_string(),
        json!({"path":"/requested.jsonl","id":"session","name":"Name","cwd":"/project/repo","preview":"hello","messageCount":3,"apiCost":0.25,"modifiedAt":999,"hostId":"untrusted","fingerprint":"untrusted"}).to_string(),
        json!({"path":"/defaults.jsonl","id":false,"cwd":null,"name":[],"preview":42,"messageCount":-1,"apiCost":"invalid"}).to_string(),
    ].join("\n");
    let results = read_session_summaries_with(&candidates, Some(&host), |_, batch| {
        assert_eq!(batch.len(), 2);
        let mut command = Command::new("node"); command.args(["-e", "process.stdout.write(process.argv[1])", &lines]); command
    }).unwrap();
    assert_eq!(results.len(), 2); assert!(!results.contains_key("/injected.jsonl"));
    let cached = &results["/requested.jsonl"]; let session = &cached.summary;
    assert_eq!(cached.fingerprint, "trusted-fingerprint"); assert_eq!(session.modified_at, 123);
    assert_eq!(session.host_id, "remote"); assert_eq!(session.host_name, "Server");
    assert_eq!(session.id, "session"); assert_eq!(session.name, "Name"); assert_eq!(session.preview, "hello");
    assert_eq!(session.project, "repo"); assert_eq!(session.message_count, 3); assert_eq!(session.api_cost, 0.25);
    let defaults = &results["/defaults.jsonl"].summary;
    assert_eq!(defaults.id, ""); assert_eq!(defaults.name, ""); assert_eq!(defaults.preview, ""); assert_eq!(defaults.project, "Workspace");
    assert_eq!(defaults.message_count, 0); assert_eq!(defaults.api_cost, 0.0); assert_eq!(defaults.modified_at, 789);
}

#[test]
fn summary_ingestion_obeys_count_and_quoted_argument_limits_and_propagates_scanner_failure() {
    for (candidates, expected) in [
        ((0..130).map(|index| (format!("/session-{index}.jsonl"), String::new(), 0, 0)).collect::<Vec<_>>(), vec![128, 2]),
        ((0..3).map(|index| (format!("/{}-{index}.jsonl", "'".repeat(2500)), String::new(), 0, 0)).collect::<Vec<_>>(), vec![1, 1, 1]),
    ] {
        let mut batches = Vec::new();
        let results = read_session_summaries_with(&candidates, None, |_, batch| {
            batches.push(batch.len());
            let body = batch.iter().map(|item| json!({"path":item.0,"id":item.0}).to_string()).collect::<Vec<_>>().join("\n");
            let mut command = Command::new("node"); command.args(["-e", "process.stdout.write(process.argv[1])", &body]); command
        }).unwrap();
        assert_eq!(batches, expected); assert_eq!(results.len(), candidates.len());
        assert!(results.values().all(|cached| cached.summary.host_id == "local" && cached.summary.host_name == "Local"));
    }
    let candidates = vec![("/session.jsonl".into(), String::new(), 0, 0)];
    assert_eq!(read_session_summaries_with(&candidates, None, |_, _| {
        let mut command = Command::new("sh"); command.args(["-c", "printf 'scanner failed' >&2; exit 2"]); command
    }).err().unwrap(), "scanner failed");
    assert!(read_session_summaries_with(&candidates, None, |_, _| Command::new("/missing/piop-scanner-test")).is_err());
    assert!(read_session_summaries_with(&[], None, |_, _| panic!("empty scan launched")).unwrap().is_empty());
}
#[test]
fn session_aggregation_keeps_healthy_hosts_and_assigns_groups_before_sorting_by_recency() {
    let mut local = test_session("local", "shared", "/local"); local.modified_at = 20;
    let hosts = ["remote", "offline", "empty"].into_iter().map(|id| RemoteHost { enabled: true,
        id:id.into(), name:id.into(), target:"unused.invalid".into(), pi_path:"pi".into(),
    }).collect();
    let visited = Mutex::new(Vec::new());
    let sessions = collect_host_sessions(vec![local], hosts, |host| {
        visited.lock().unwrap().push(host.id.clone());
        match host.id.as_str() {
            "offline" => Err("host unavailable".into()),
            "empty" => Ok(Vec::new()),
            _ => {
                let mut recent = test_session("remote", "shared", "/remote"); recent.modified_at = 30;
                let mut old = test_session("remote", "older", "/older"); old.modified_at = 10;
                Ok(vec![old, recent])
            },
        }
    }, |sessions| {
        assert_eq!(sessions.len(), 3, "assignment must see sessions from every successful host");
        for session in sessions { session.group_id = Some(format!("group-{}", session.host_id)); }
        Ok(())
    }).unwrap();
    let mut visited = visited.into_inner().unwrap(); visited.sort();
    assert_eq!(visited, vec!["empty", "offline", "remote"]);
    assert_eq!(sessions.iter().map(|session| (session.host_id.as_str(), session.id.as_str(), session.modified_at)).collect::<Vec<_>>(),
        vec![("remote", "shared", 30), ("local", "shared", 20), ("remote", "older", 10)]);
    assert_eq!(sessions[0].group_id.as_deref(), Some("group-remote"));
    assert_eq!(sessions[1].group_id.as_deref(), Some("group-local"));
}

#[test]
fn session_aggregation_handles_no_hosts_and_propagates_assignment_failures() {
    let sessions = collect_host_sessions(Vec::new(), Vec::new(), |_| panic!("unexpected host lookup"), |sessions| {
        assert!(sessions.is_empty()); Ok(())
    }).unwrap();
    assert!(sessions.is_empty());
    let error = collect_host_sessions(vec![test_session("local", "id", "/session")], Vec::new(),
        |_| panic!("unexpected host lookup"),
        |sessions| { assert_eq!(sessions.len(), 1); Err("group storage unavailable".into()) }).err().unwrap();
    assert_eq!(error, "group storage unavailable");
}

#[test]
fn storage_reports_keep_local_first_sort_remotes_and_retain_partial_failures() {
    let remotes = [("z", "Zulu"), ("a", "alpha"), ("b", "Bravo")].into_iter().map(|(id, name)| RemoteHost { enabled: true,
        id:id.into(), name:name.into(), target:format!("{id}.invalid"), pi_path:"pi".into(),
    }).collect();
    let report = collect_storage_report(Err("local disk unavailable".into()), remotes, |host| {
        if host.id == "b" { return Err("SSH unavailable".into()); }
        Ok(HostStorage { host_id:host.id.clone(), host_name:host.name.clone(), categories:Vec::new(), archives:Vec::new(), warnings:vec!["partial scan".into()], error:None })
    });
    assert_eq!(report.hosts.iter().map(|host| host.host_id.as_str()).collect::<Vec<_>>(), vec!["local", "a", "b", "z"]);
    assert_eq!(report.hosts[0].host_name, "Local");
    assert_eq!(report.hosts[0].error.as_deref(), Some("local disk unavailable"));
    assert_eq!(report.hosts[2].error.as_deref(), Some("SSH unavailable"));
    assert!(report.hosts[2].categories.is_empty()); assert!(report.hosts[2].archives.is_empty());
    for index in [1, 3] {
        assert!(report.hosts[index].error.is_none());
        assert_eq!(report.hosts[index].warnings, vec!["partial scan"]);
    }
    let local = HostStorage { host_id:"local".into(), host_name:"Local".into(), categories:Vec::new(), archives:Vec::new(), warnings:vec!["local warning".into()], error:None };
    let only_local = collect_storage_report(Ok(local), Vec::new(), |_| panic!("no remote hosts"));
    assert_eq!(only_local.hosts.len(), 1);
    assert_eq!(only_local.hosts[0].warnings, vec!["local warning"]);
}

#[test]
fn storage_report_limits_parallel_inspections_and_processes_every_host_once() {
    let remotes = (0..9).map(|id| RemoteHost { enabled: true, id:id.to_string(), name:format!("Host {id}"), target:"unused.invalid".into(), pi_path:"pi".into() }).collect();
    let (started, starts) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let gate = release.clone();
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let maximum = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = maximum.clone();
    let worker = thread::spawn(move || collect_storage_report(Err("local error".into()), remotes, |host| {
        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
        observed.fetch_max(count, Ordering::SeqCst);
        started.send(host.id.clone()).unwrap();
        let (lock, condition) = &*gate;
        let ready = lock.lock().unwrap();
        let (_ready, _) = condition.wait_timeout_while(ready, Duration::from_secs(3), |ready| !*ready).unwrap();
        active.fetch_sub(1, Ordering::SeqCst);
        Err(format!("unavailable:{}", host.id))
    }));
    let mut inspected = Vec::new();
    for _ in 0..4 { inspected.push(starts.recv_timeout(Duration::from_secs(2)).unwrap()); }
    assert!(matches!(starts.recv_timeout(Duration::from_millis(50)), Err(mpsc::RecvTimeoutError::Timeout)));
    { let (lock, condition) = &*release; *lock.lock().unwrap() = true; condition.notify_all(); }
    let report = worker.join().unwrap();
    inspected.extend(starts.try_iter()); inspected.sort();
    assert_eq!(inspected, (0..9).map(|id| id.to_string()).collect::<Vec<_>>());
    assert_eq!(maximum.load(Ordering::SeqCst), 4);
    assert_eq!(report.hosts.len(), 10);
    for host in &report.hosts[1..] { assert_eq!(host.error.as_deref(), Some(format!("unavailable:{}", host.host_id).as_str())); }
}

#[test]
fn deletion_removes_recorded_git_checkpoints_but_preserves_unrelated_refs_and_files() {
    for mismatched_ref in [false, true] {
        let home = TestDirectory::new(); let repository = TestDirectory::new();
        test_git(&repository.0, &["init", "--initial-branch=main"]);
        fs::write(repository.0.join("tracked.txt"), "original\n").unwrap();
        test_git(&repository.0, &["add", "."]); test_git(&repository.0, &["commit", "-m", "Initial"]);
        let output = Command::new("git").arg("-C").arg(&repository.0).args(["rev-parse", "HEAD"]).output().unwrap();
        assert!(output.status.success()); let commit = String::from_utf8(output.stdout).unwrap().trim().to_owned();
        let owned_ref = "refs/pi-session-snapshots/chats/one/checkpoint";
        let unrelated_ref = "refs/pi-session-snapshots/chats/other/checkpoint";
        test_git(&repository.0, &["update-ref", owned_ref, &commit]);
        test_git(&repository.0, &["update-ref", unrelated_ref, &commit]);
        if mismatched_ref {
            test_git(&repository.0, &["commit", "--allow-empty", "-m", "Different checkpoint"]);
            test_git(&repository.0, &["update-ref", owned_ref, "HEAD"]);
        }
        fs::write(repository.0.join("tracked.txt"), "uncommitted work\n").unwrap();
        let root = home.0.join(".piop/sessions"); fs::create_dir_all(&root).unwrap();
        let session = root.join("one.jsonl");
        let header = json!({"type":"session","id":"one","cwd":repository.0});
        let checkpoint = json!({"type":"custom","customType":"pi-project-files-watch-snapshot","data":{"repositoryRoot":repository.0,"ref":owned_ref,"commit":commit}});
        let content = format!("{header}\n{checkpoint}\n"); fs::write(&session, &content).unwrap();
        let sidecar = session.with_extension("diffs.json"); fs::write(&sidecar, "{}").unwrap();
        let result = delete_session_files(&PiRuntime::default(), session.to_str().unwrap(), "local", None, &root, false);
        let owned = Command::new("git").arg("-C").arg(&repository.0).args(["show-ref", "--verify", owned_ref]).output().unwrap();
        if mismatched_ref {
            assert!(result.unwrap_err().contains("no longer points to its recorded commit"));
            assert!(owned.status.success());
            assert_eq!(fs::read_to_string(&session).unwrap(), content);
            assert_eq!(fs::read_to_string(&sidecar).unwrap(), "{}");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        } else {
            result.unwrap(); assert!(!owned.status.success());
            assert!(!session.exists()); assert!(!sidecar.exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        }
        let other = Command::new("git").arg("-C").arg(&repository.0).args(["rev-parse", unrelated_ref]).output().unwrap();
        assert!(other.status.success()); assert_eq!(String::from_utf8(other.stdout).unwrap().trim(), commit);
        assert_eq!(fs::read_to_string(repository.0.join("tracked.txt")).unwrap(), "uncommitted work\n");
    }
}

#[test]
fn remote_session_path_resolution_confines_each_storage_area_and_preserves_literal_names() {
    let home = TestDirectory::new();
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0).current_dir(&home.0); command };
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, "precious").unwrap();
    for archived in [false, true] {
        let area = if archived { "archived" } else { "sessions" };
        let expected = if archived { "Only archived conversation files in this Piop profile can be deleted" } else { "Only session files in this Piop profile can be opened" };
        let root = home.0.join(STORAGE_DIRECTORY).join(area); fs::create_dir_all(root.join("nested")).unwrap();
        let path = root.join("nested/session ' $(touch injected) 日本語\nline.jsonl"); fs::write(&path, "session").unwrap();
        assert_eq!(remote_session_file(path.to_str().unwrap(), archived, shell).unwrap(), path.canonicalize().unwrap().to_str().unwrap());
        let wrong_extension = root.join("wrong.json"); fs::write(&wrong_extension, "keep").unwrap();
        let directory = root.join("directory.jsonl"); fs::create_dir(&directory).unwrap();
        for invalid in [&outside, &wrong_extension, &directory, &root.join("missing.jsonl")] {
            assert!(remote_session_file(invalid.to_str().unwrap(), archived, shell).unwrap_err().contains(expected));
        }
        assert!(remote_session_file(path.to_str().unwrap(), !archived, shell).is_err());
        #[cfg(unix)] {
            let escape = root.join("escape.jsonl"); std::os::unix::fs::symlink(&outside, &escape).unwrap();
            assert!(remote_session_file(escape.to_str().unwrap(), archived, shell).is_err());
            let alias = root.join("alias.jsonl"); std::os::unix::fs::symlink(&path, &alias).unwrap();
            assert_eq!(remote_session_file(alias.to_str().unwrap(), archived, shell).unwrap(), path.canonicalize().unwrap().to_str().unwrap());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "session");
    }
    assert_eq!(fs::read_to_string(outside).unwrap(), "precious");
    assert!(!home.0.join("injected").exists());
}

#[test]
fn remote_session_path_resolution_reports_launch_errors_and_enforces_output_limit() {
    for archived in [false, true] {
        assert!(remote_session_file("unused", archived, |_| Command::new("/missing/piop-session-path-test")).is_err());
        let context = if archived { "Could not locate archived Piop conversation" } else { "Could not locate Piop session" };
        assert!(remote_session_file("unused", archived, |_| {
            let mut command = Command::new("node"); command.args(["-e", &format!("process.stdout.write('x'.repeat({}))", MAX_GIT_PATH_LIST_BYTES + 1)]); command
        }).unwrap_err().contains(context));
    }
}

#[test]
fn remote_relocation_changes_only_header_and_preserves_permissions_and_newlines() {
    let home = TestDirectory::new(); let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let project = home.0.join("project ' $(touch injected) 日本語"); fs::create_dir(&project).unwrap();
    let path = sessions.join("session ' 日本語.jsonl");
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0).current_dir(&home.0); command };
    for body in ["", "\n", "\n{\"type\":\"message\",\"text\":\"hello 日本語\"}\n"] {
        fs::write(&path, format!("{{\"type\":\"session\",\"id\":\"original\",\"cwd\":\"/old\",\"custom\":true}}{body}")).unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap(); }
        relocate_remote_session(path.to_str().unwrap(), &format!("  {}  ", project.display()), "fixture", shell).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let (first, rest) = content.split_once('\n').unwrap_or((&content, ""));
        let header: Value = serde_json::from_str(first).unwrap();
        assert_eq!(header, json!({"type":"session","id":"original","cwd":project,"custom":true}));
        assert_eq!(rest, body.strip_prefix('\n').unwrap_or(""));
        assert_eq!(content.contains('\n'), !body.is_empty());
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640); }
        assert_eq!(fs::read_dir(&sessions).unwrap().count(), 1);
    }
    assert!(!home.0.join("injected").exists());
}

#[test]
fn remote_relocation_rejects_invalid_inputs_without_modifying_files() {
    let home = TestDirectory::new(); let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("session.jsonl");
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0); command };
    for original in ["bad JSON\nunchanged", "null\n", "{\"type\":\"message\"}\n"] {
        fs::write(&path, original).unwrap();
        assert!(relocate_remote_session(path.to_str().unwrap(), home.0.to_str().unwrap(), "fixture", shell).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&sessions).unwrap().count(), 1);
    }
    let original = "{\"type\":\"session\",\"cwd\":\"/old\"}\n"; fs::write(&path, original).unwrap();
    assert!(relocate_remote_session(path.to_str().unwrap(), "/missing/piop-project", "fixture", shell).unwrap_err().contains("Project directory does not exist"));
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, original).unwrap();
    assert!(relocate_remote_session(outside.to_str().unwrap(), home.0.to_str().unwrap(), "fixture", shell).unwrap_err().contains("Refusing to relocate"));
    #[cfg(unix)] {
        let alias = sessions.join("alias.jsonl"); std::os::unix::fs::symlink(&outside, &alias).unwrap();
        assert!(relocate_remote_session(alias.to_str().unwrap(), home.0.to_str().unwrap(), "fixture", shell).unwrap_err().contains("Refusing to relocate"));
    }
    assert_eq!(fs::read_to_string(&outside).unwrap(), original); assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(relocate_remote_session("unused", "unused", "fixture", |_| Command::new("/missing/piop-relocation-test")).is_err());
    assert_eq!(relocate_remote_session("unused", "unused", "fixture", |_| { let mut command = Command::new("sh"); command.args(["-c", "exit 1"]); command }).unwrap_err(), "Could not relocate conversation on fixture");
}

#[test]
fn relocating_a_session_preserves_messages_metadata_and_diff_history() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions/project");
    let project = home.0.join("new project 日本語");
    fs::create_dir_all(&sessions).unwrap();
    fs::create_dir_all(&project).unwrap();
    let path = sessions.join("session.jsonl");
    let tail = "{\"type\":\"message\",\"text\":\"hello 🌍\"}\n\n{\"custom\": true}\n";
    let header = json!({"type":"session","id":"stable-id","cwd":"/old","version":3,"custom":{"keep":true}});
    fs::write(&path, format!("{header}\n{tail}")).unwrap();
    fs::write(path.with_extension("diffs.json"), "unchanged diffs").unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    relocate_local_session(&home.0, path.to_str().unwrap(), &format!("  {}  ", project.display())).unwrap();
    let updated = fs::read_to_string(&path).unwrap();
    let (first, rest) = updated.split_once('\n').unwrap();
    let mut expected = header;
    expected["cwd"] = json!(project.to_str().unwrap());
    assert_eq!(serde_json::from_str::<Value>(first).unwrap(), expected);
    assert_eq!(rest, tail);
    assert_eq!(fs::read_to_string(path.with_extension("diffs.json")).unwrap(), "unchanged diffs");
    assert_eq!(fs::read_dir(&sessions).unwrap().count(), 2, "temporary file must be committed");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
    }
}

#[test]
fn invalid_relocations_leave_the_original_session_untouched() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("session.jsonl");
    for content in [b"invalid json".as_slice(), b"{\"type\":\"message\"}", b"[]", b"\xff"] {
        fs::write(&path, content).unwrap();
        assert!(relocate_local_session(&home.0, path.to_str().unwrap(), home.0.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&path).unwrap(), content);
        assert_eq!(fs::read_dir(&sessions).unwrap().count(), 1);
    }
    fs::write(&path, "{\"type\":\"session\"}").unwrap();
    for replacement in [home.0.join("missing"), path.clone()] {
        assert!(relocate_local_session(&home.0, path.to_str().unwrap(), replacement.to_str().unwrap()).unwrap_err().contains("Project directory does not exist"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"type\":\"session\"}");
    }
    let outside = home.0.join("outside.jsonl");
    fs::write(&outside, "{\"type\":\"session\"}").unwrap();
    assert!(relocate_local_session(&home.0, outside.to_str().unwrap(), home.0.to_str().unwrap()).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "{\"type\":\"session\"}");
}

#[test]
fn remote_archive_moves_session_and_sidecar_without_replacing_earlier_archives() {
    let home = TestDirectory::new(); let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions/nested ' 日本語"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("chat ' $(touch injected).jsonl"); let sidecar = source.with_extension("diffs.json");
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0).current_dir(&home.0); command };
    for index in 0..2 {
        fs::write(&source, format!("session {index}")).unwrap();
        fs::write(&sidecar, format!("diff {index}")).unwrap();
        archive_remote_session(source.to_str().unwrap(), shell).unwrap();
        assert!(!source.exists()); assert!(!sidecar.exists());
    }
    let archived = home.0.join(STORAGE_DIRECTORY).join("archived");
    let mut contents = Vec::new();
    for entry in fs::read_dir(&archived).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "jsonl") {
            let session = fs::read_to_string(&path).unwrap();
            assert_eq!(fs::read_to_string(path.with_extension("diffs.json")).unwrap(), session.replace("session", "diff"));
            contents.push(session);
        }
    }
    contents.sort(); assert_eq!(contents, ["session 0", "session 1"]);
    assert_eq!(fs::read_dir(&archived).unwrap().count(), 4);
    assert!(!home.0.join("injected").exists());
    fs::write(&source, "no diffs").unwrap(); archive_remote_session(source.to_str().unwrap(), shell).unwrap();
    assert_eq!(fs::read_dir(&archived).unwrap().count(), 5);
}

#[test]
fn remote_archive_rolls_back_diffs_when_session_move_fails_and_rejects_outside_paths() {
    let home = TestDirectory::new(); let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("chat.jsonl"); let sidecar = source.with_extension("diffs.json");
    fs::write(&source, "session").unwrap(); fs::write(&sidecar, "diff").unwrap();
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0); command };
    let error = archive_remote_session(source.to_str().unwrap(), |script| {
        let wrapped = format!("mv() {{ if [ \"$2\" = {} ]; then printf 'session move failed' >&2; return 1; fi; command mv \"$@\"; }}; {script}", shell_quote(source.to_str().unwrap()));
        shell(wrapped)
    }).unwrap_err();
    assert_eq!(error, "session move failed");
    assert_eq!(fs::read_to_string(&source).unwrap(), "session"); assert_eq!(fs::read_to_string(&sidecar).unwrap(), "diff");
    assert_eq!(fs::read_dir(home.0.join(STORAGE_DIRECTORY).join("archived")).unwrap().count(), 0);
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, "precious").unwrap();
    assert!(archive_remote_session(outside.to_str().unwrap(), shell).unwrap_err().contains("Refusing to archive"));
    #[cfg(unix)] {
        let alias = sessions.join("alias.jsonl"); std::os::unix::fs::symlink(&outside, &alias).unwrap();
        assert!(archive_remote_session(alias.to_str().unwrap(), shell).unwrap_err().contains("Refusing to archive"));
    }
    assert_eq!(fs::read_to_string(&outside).unwrap(), "precious");
    assert!(archive_remote_session("/", |_| panic!("invalid path launched")).is_err());
    assert!(archive_remote_session(source.to_str().unwrap(), |_| Command::new("/missing/piop-archive-test")).is_err());
}

#[test]
fn local_archiving_moves_conversation_and_diffs_without_overwriting_existing_conversations() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions/project");
    fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("conversation.jsonl");
    let diffs = source.with_extension("diffs.json");
    fs::write(&source, "first conversation").unwrap();
    fs::write(&diffs, "first diffs").unwrap();
    archive_local_session(&home.0, source.to_str().unwrap()).unwrap();
    let archive = home.0.join(STORAGE_DIRECTORY).join("archived");
    assert!(!source.exists());
    assert!(!diffs.exists());
    assert_eq!(fs::read_to_string(archive.join("conversation.jsonl")).unwrap(), "first conversation");
    assert_eq!(fs::read_to_string(archive.join("conversation.diffs.json")).unwrap(), "first diffs");
    fs::write(&source, "second conversation").unwrap();
    fs::write(&diffs, "second diffs").unwrap();
    archive_local_session(&home.0, source.to_str().unwrap()).unwrap();
    let conversations: Vec<_> = fs::read_dir(&archive).unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl")).collect();
    assert_eq!(conversations.len(), 2);
    let second = conversations.iter().find(|path| path.file_name().unwrap() != "conversation.jsonl").unwrap();
    assert_eq!(fs::read_to_string(second).unwrap(), "second conversation");
    assert_eq!(fs::read_to_string(second.with_extension("diffs.json")).unwrap(), "second diffs");
    assert_eq!(fs::read_to_string(archive.join("conversation.jsonl")).unwrap(), "first conversation");
    assert_eq!(fs::read_to_string(archive.join("conversation.diffs.json")).unwrap(), "first diffs");
    let plain = sessions.join("plain.jsonl");
    fs::write(&plain, "no diffs").unwrap();
    archive_local_session(&home.0, plain.to_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(archive.join("plain.jsonl")).unwrap(), "no diffs");
    assert!(!archive.join("plain.diffs.json").exists());
}

#[test]
fn local_archiving_preserves_sources_when_directory_or_diff_move_fails() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("conversation.jsonl");
    let diffs = source.with_extension("diffs.json");
    fs::write(&source, "conversation").unwrap();
    fs::write(&diffs, "diffs").unwrap();
    let archive = home.0.join(STORAGE_DIRECTORY).join("archived");
    fs::write(&archive, "blocking file").unwrap();
    assert!(archive_local_session(&home.0, source.to_str().unwrap()).unwrap_err().contains("Could not create archive directory"));
    fs::remove_file(&archive).unwrap();
    fs::create_dir_all(archive.join("conversation.diffs.json")).unwrap();
    assert!(archive_local_session(&home.0, source.to_str().unwrap()).unwrap_err().contains("Could not archive session diffs"));
    assert_eq!(fs::read_to_string(&source).unwrap(), "conversation");
    assert_eq!(fs::read_to_string(&diffs).unwrap(), "diffs");
    assert!(!archive.join("conversation.jsonl").exists());
    let outside = home.0.join("outside.jsonl");
    fs::write(&outside, "outside").unwrap();
    assert!(archive_local_session(&home.0, outside.to_str().unwrap()).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
}
