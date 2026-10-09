#[test]
fn settings_save_validation_preserves_existing_file_and_never_resolves_storage_for_invalid_input() {
    let temporary = TestDirectory::new(); let path = temporary.0.join("settings.json");
    fs::write(&path, "existing configuration").unwrap();
    let runtime = PiRuntime::default();
    for invalid in ["cap", "shortcut", "host"] {
        let mut settings = default_settings();
        match invalid {
            "cap" => settings.context_window_cap = 999,
            "shortcut" => { settings.keybindings.insert("focusComposer".into(), "Ctrl+G".into()); },
            _ => settings.hosts.push(RemoteHost { enabled: true, id:"remote".into(), name:"Local".into(), target:"unused.invalid".into(), pi_path:"pi".into() }),
        }
        let result = save_settings_with(&runtime, settings, Some("remote".into()),
            || panic!("invalid settings must not access storage"),
            |_| panic!("invalid settings must not invalidate connections"),
            |_| panic!("invalid settings must not synchronize"));
        assert!(result.is_err(), "{invalid}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing configuration");
        assert_eq!(runtime.agent_config_revision.load(Ordering::SeqCst), 0);
        assert!(runtime.agent_config_revisions.lock().unwrap().is_empty());
    }
}

#[test]
fn settings_save_migrates_retired_shortcuts_before_validation_and_persistence() {
    let temporary = TestDirectory::new(); let path = temporary.0.join("settings.json");
    let runtime = PiRuntime::default(); let mut settings = default_settings();
    settings.keybindings.insert("retiredAction".into(), "Ctrl+G".into());
    settings.keybindings.insert("focusComposer".into(), "Ctrl+L".into());
    let result = save_settings_with(&runtime, settings, None, || Ok(path.clone()),
        |settings| {
            assert!(!settings.keybindings.contains_key("retiredAction"));
            assert_eq!(settings.keybindings["focusComposer"], "Ctrl+E"); Ok(())
        },
        |settings| { assert_eq!(settings.keybindings["focusComposer"], "Ctrl+E"); Ok(()) }).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved, result["settings"]);
    assert!(saved["keybindings"].get("retiredAction").is_none());
    assert_eq!(saved["keybindings"]["focusComposer"], "Ctrl+E");
}

#[test]
fn saving_settings_persists_before_synchronizing_and_assigns_monotonic_host_revisions() {
    let temporary = TestDirectory::new(); let path = temporary.0.join("settings.json");
    let runtime = PiRuntime::default();
    for (host, revision) in [(Some("remote"), Some(1)), (None, None), (Some("local"), Some(2)), (Some("remote"), Some(3))] {
        let settings = default_settings();
        let expected = serde_json::to_value(&settings).unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        let change = save_settings_with(&runtime, settings, host.map(str::to_owned), || Ok(path.clone()),
            |settings| {
                assert_eq!(serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(), serde_json::to_value(settings).unwrap());
                assert!(runtime.lifecycle.try_lock().is_err());
                calls.borrow_mut().push("invalidate"); Ok(())
            },
            |_| {
                if let Some(host) = host { assert_eq!(runtime.agent_config_revisions.lock().unwrap()[host], revision.unwrap()); }
                calls.borrow_mut().push("synchronize"); Ok(())
            }).unwrap();
        assert_eq!(*calls.borrow(), vec!["invalidate", "synchronize"]);
        assert_eq!(change["settings"], expected);
        if let Some(host) = host { assert_eq!(change["agentConfigChange"], json!({"hostId":host,"revision":revision.unwrap()})); }
        else { assert!(change.get("agentConfigChange").is_none()); }
    }
    assert_eq!(runtime.agent_config_revisions.lock().unwrap()["local"], 2);
    assert_eq!(runtime.agent_config_revisions.lock().unwrap()["remote"], 3);
}

#[test]
fn settings_save_failures_stop_later_stages_and_preserve_revision_order() {
    for failure in ["path", "write", "invalidate", "synchronize"] {
        let temporary = TestDirectory::new(); let path = temporary.0.join("settings.json");
        let runtime = PiRuntime::default();
        if failure == "write" { fs::create_dir(&path).unwrap(); }
        let calls = std::cell::RefCell::new(Vec::new());
        let result = save_settings_with(&runtime, default_settings(), Some("remote".into()),
            || if failure == "path" { Err("path failed".into()) } else { Ok(path.clone()) },
            |_| { calls.borrow_mut().push("invalidate"); if failure == "invalidate" { Err("invalidate failed".into()) } else { Ok(()) } },
            |_| { calls.borrow_mut().push("synchronize"); Err("synchronize failed".into()) });
        assert!(result.is_err());
        let expected = match failure { "path" | "write" => vec![], "invalidate" => vec!["invalidate"], _ => vec!["invalidate","synchronize"] };
        assert_eq!(*calls.borrow(), expected);
        assert_eq!(runtime.agent_config_revision.load(Ordering::SeqCst), if failure == "synchronize" { 1 } else { 0 });
        assert!(runtime.lifecycle.try_lock().is_ok());
    }
}

#[test]
fn settings_save_validation_enforces_machine_identity_names_and_connection_syntax() {
    let host = RemoteHost { enabled: true, id: "remote".into(), name: "Server".into(), target: "user@host".into(), pi_path: "pi".into() };
    let mut settings = default_settings(); settings.hosts = vec![host.clone()];
    assert!(validate_settings_for_save(&settings).is_ok());
    for (id, name, target, executable, expected) in [
        (" ", "Server", "host", "pi", "unique id"),
        ("remote", " ", "host", "pi", "needs a name"),
        ("remote", " LoCaL ", "host", "pi", "already in use"),
        ("remote", "Server", "host;id", "pi", "SSH target"),
        ("remote", "Server", "host", "pi --flag", "Pi executable"),
    ] {
        settings.hosts = vec![RemoteHost { enabled: true, id: id.into(), name: name.into(), target: target.into(), pi_path: executable.into() }];
        assert!(validate_settings_for_save(&settings).unwrap_err().contains(expected));
    }
    settings.hosts = vec![host.clone(), RemoteHost { enabled: true, name: "Other".into(), ..host.clone() }];
    assert!(validate_settings_for_save(&settings).unwrap_err().contains("unique id"));
    settings.hosts = vec![host.clone(), RemoteHost { enabled: true, id: "other".into(), name: " SERVER ".into(), ..host.clone() }];
    assert!(validate_settings_for_save(&settings).unwrap_err().contains("already in use"));
    settings.hosts = vec![host; MAX_REMOTE_HOSTS + 1];
    assert!(validate_settings_for_save(&settings).unwrap_err().contains("At most"));
}

#[test]
fn settings_save_validation_enforces_context_and_delegates_other_configuration_checks() {
    let mut settings = default_settings();
    settings.context_window_cap = 999;
    assert!(validate_settings_for_save(&settings).unwrap_err().contains("at least 1000"));
    settings.context_window_cap = 1000; assert!(validate_settings_for_save(&settings).is_ok());
    settings.keybindings.insert("newConversation".into(), "Ctrl+G".into());
    assert!(validate_settings_for_save(&settings).is_err()); settings.keybindings = default_keybindings();
}

#[test]
fn settings_migration_moves_exact_legacy_bytes_and_preserves_existing_settings() {
    let home = TestDirectory::new(); let legacy_dir = TestDirectory::new();
    let legacy = legacy_dir.0.join("settings.json");
    let content = b"{\n  \"custom\": \"value\", \"version\": 1\n}\n"; fs::write(&legacy, content).unwrap();
    let path = settings_path_at(&home.0, false, || Ok(legacy.clone())).unwrap();
    assert_eq!(path, home.0.join(STORAGE_DIRECTORY).join("settings.json"));
    assert_eq!(fs::read(&path).unwrap(), content); assert!(!legacy.exists());
    fs::write(&legacy, "old configuration").unwrap();
    assert_eq!(settings_path_at(&home.0, false, || panic!("existing settings must not need legacy path lookup")).unwrap(), path);
    assert_eq!(fs::read_to_string(&legacy).unwrap(), "old configuration");
    assert_eq!(fs::read(&path).unwrap(), content);
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}

#[test]
fn settings_migration_handles_absent_legacy_and_reports_unreadable_sources() {
    let home = TestDirectory::new(); let legacy_dir = TestDirectory::new();
    let legacy = legacy_dir.0.join("settings.json");
    let path = settings_path_at(&home.0, false, || Ok(legacy.clone())).unwrap();
    assert!(!path.exists()); assert!(path.parent().unwrap().is_dir());
    assert_eq!(settings_path_at(&home.0, false, || Err("path unavailable".into())).unwrap_err(), "path unavailable");
    fs::create_dir(&legacy).unwrap(); fs::write(legacy.join("keep"), "original").unwrap();
    assert!(settings_path_at(&home.0, false, || Ok(legacy.clone())).unwrap_err().starts_with("Could not migrate settings:"));
    assert!(!path.exists()); assert_eq!(fs::read_to_string(legacy.join("keep")).unwrap(), "original");
}

#[cfg(unix)]
#[test]
fn settings_path_rejects_directory_obstructions_without_changing_their_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let home = TestDirectory::new(); let path = home.0.join(STORAGE_DIRECTORY).join("settings.json");
    fs::create_dir_all(&path).unwrap(); fs::write(path.join("keep"), "original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    let result = settings_path_at(&home.0, false, || panic!("existing path must not trigger migration"));
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(result.is_err(), "a directory cannot be used as settings.json");
    assert_eq!(mode, 0o750);
    assert_eq!(fs::read_to_string(path.join("keep")).unwrap(), "original");
}

#[test]
fn project_inspection_updates_directory_existence_without_reindexing_the_session() {
    let root = TestDirectory::new(); let index = SessionIndexRuntime::default();
    let sessions_dir = root.0.join("sessions"); fs::create_dir(&sessions_dir).unwrap();
    let project = root.0.join("missing project"); let path = sessions_dir.join("chat.jsonl");
    fs::write(&path, format!("{}\n", json!({"type":"session","id":"chat","cwd":project}))).unwrap();
    let missing = list_local_sessions(&index, &sessions_dir).unwrap();
    assert!(!missing[0].cwd_exists);
    let fingerprint = index.local.lock().unwrap()[&path].fingerprint.clone();
    fs::create_dir(&project).unwrap();
    let restored = list_local_sessions(&index, &sessions_dir).unwrap();
    assert!(restored[0].cwd_exists);
    assert_eq!(index.local.lock().unwrap()[&path].fingerprint, fingerprint);
    fs::remove_dir(&project).unwrap();
    assert!(!list_local_sessions(&index, &sessions_dir).unwrap()[0].cwd_exists);
}
