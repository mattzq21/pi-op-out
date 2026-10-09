#[test]
fn usage_query_initializes_the_server_before_reading_rate_limits() {
    let directory = TestDirectory::new(); let transcript = directory.0.join("packets.jsonl");
    let script = r#"const fs=require('fs'); const readline=require('readline');
if(process.argv[2]!=='app-server') process.exit(9);
readline.createInterface({input:process.stdin}).on('line',line=>{
 fs.appendFileSync(process.argv[1],line+'\n'); const packet=JSON.parse(line);
 if(packet.method==='initialize') { console.log('startup noise'); console.log(JSON.stringify({id:1,result:{}})); }
 if(packet.method==='account/rateLimits/read') console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:20,resetsAt:100},secondary:{usedPercent:75,resetsAt:200}}}}));
});"#;
    let usage = query_codex_usage(Command::new("node").args(["-e", script, transcript.to_str().unwrap()])).unwrap();
    assert_eq!(usage.remaining_percent, 25); assert_eq!(usage.reset_at, Some(200));
    let packets: Vec<Value> = fs::read_to_string(&transcript).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(packets.len(), 3);
    assert_eq!(packets[0], json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"piop","title":"piop","version":env!("CARGO_PKG_VERSION")},"capabilities":null}}));
    assert_eq!(packets[1], json!({"method":"initialized"}));
    assert_eq!(packets[2], json!({"method":"account/rateLimits/read","id":2}));
}

#[cfg(unix)]
#[test]
fn unchanged_private_writes_preserve_the_file_and_repair_permissions() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let directory = TestDirectory::new();
    let path = directory.0.join("nested/config.json");
    atomic_write_private(&path, b"original\0bytes").unwrap();
    let original_inode = fs::metadata(&path).unwrap().ino();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    atomic_write_private(&path, b"original\0bytes").unwrap();
    assert_eq!(fs::metadata(&path).unwrap().ino(), original_inode, "unchanged configuration must not be replaced");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    atomic_write_private(&path, b"replacement").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    assert_ne!(fs::metadata(&path).unwrap().ino(), original_inode, "changed configuration should be atomically replaced");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn concurrent_private_writes_never_expose_partial_configuration() {
    let directory = TestDirectory::new();
    let path = directory.0.join("config.json");
    let payloads: Vec<Vec<u8>> = (0..8).map(|index| vec![65u8 + index; 64 * 1024 + usize::from(index)]).collect();
    atomic_write_private(&path, &payloads[0]).unwrap();
    let barrier = std::sync::Barrier::new(9);
    let completed = std::sync::atomic::AtomicUsize::new(0);
    thread::scope(|scope| {
        for payload in &payloads {
            let path = &path; let barrier = &barrier; let completed = &completed;
            scope.spawn(move || {
                barrier.wait();
                let result = (0..4).try_for_each(|_| atomic_write_private(path, payload));
                completed.fetch_add(1, Ordering::SeqCst);
                result.unwrap();
            });
        }
        barrier.wait();
        while completed.load(Ordering::SeqCst) != payloads.len() {
            let observed = fs::read(&path).unwrap();
            assert!(payloads.contains(&observed), "reader observed a partial or mixed configuration");
            thread::yield_now();
        }
    });
    assert!(payloads.contains(&fs::read(&path).unwrap()));
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1, "concurrent writes must leave no temporary files");
}

#[test]
fn invalid_private_write_destinations_leave_existing_contents_intact() {
    let directory = TestDirectory::new();
    let parent_file = directory.0.join("file");
    fs::write(&parent_file, "keep").unwrap();
    assert!(atomic_write_private(&parent_file.join("child"), b"new").is_err());
    assert_eq!(fs::read_to_string(&parent_file).unwrap(), "keep");
    assert_eq!(atomic_write_private(Path::new("/"), b"new").unwrap_err(), "Configuration file has no parent directory");
    let existing_dir = directory.0.join("existing");
    fs::create_dir(&existing_dir).unwrap();
    fs::write(existing_dir.join("child"), "keep child").unwrap();
    #[cfg(unix)] let original_mode = {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(&existing_dir).unwrap().permissions().mode()
    };
    assert!(atomic_write_private(&existing_dir, b"new").unwrap_err().contains("Configuration path is a directory"));
    assert_eq!(fs::read_to_string(existing_dir.join("child")).unwrap(), "keep child");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&existing_dir).unwrap().permissions().mode(), original_mode);
    }
}

#[test]
fn bundled_extension_installers_refresh_private_files_at_the_expected_paths() {
    type Installer = fn() -> Result<PathBuf, String>;
    let installers: [(Installer, &str, &str); 4] = [
        (prepare_session_broker, "session-broker.ts", include_str!("../../resources/session-broker.ts")),
        (prepare_trace_reader, "piop-trace-reader.ts", include_str!("../../resources/trace-reader.ts")),
        (prepare_openai_cache_fork_extension, "piop-openai-cache-fork.ts", include_str!("../../../extensions/piop-openai-cache-fork/index.ts")),
        (prepare_codex_web_search_extension, "piop-codex-web-search.ts", include_str!("../../../extensions/piop-codex-web-search/index.ts")),
    ];
    for (install, relative, expected) in installers {
        let home = TestDirectory::new();
        let _home = HomeOverride::take(&home.0);
        let target = generated_extension_root().unwrap().join(relative);
        let path = install().unwrap();
        assert_eq!(path, target);
        assert_eq!(fs::read_to_string(&target).unwrap(), expected);
        let other = target.with_file_name("user-file"); fs::write(&other, "keep").unwrap();
        fs::write(&target, "stale bundle").unwrap();
        assert_eq!(install().unwrap(), target);
        assert_eq!(fs::read_to_string(&target).unwrap(), expected);
        assert_eq!(fs::read_to_string(&other).unwrap(), "keep");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(target.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let expected_files = if relative == "session-broker.ts" {
            assert_eq!(fs::read_to_string(target.with_file_name("ask-user.ts")).unwrap(), include_str!("../../resources/ask-user.ts"));
            4
        } else { 2 };
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), expected_files);
        fs::remove_file(&target).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "original directory").unwrap();
        assert!(install().is_err());
        assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "original directory");
    }
}

#[test]
fn development_extensions_are_scoped_to_the_daemon_directory() {
    if !DEVELOPMENT { return; }
    let home = TestDirectory::new(); let _home = HomeOverride::take(&home.0);
    let path = prepare_mcp_bridge().unwrap();
    assert!(path.starts_with(daemon_endpoint::directory().unwrap()));
    let expected = fs::read(&path).unwrap();
    fs::write(home.0.join(STORAGE_DIRECTORY).join("piop-mcp-bridge.ts"), "other development build").unwrap();
    assert_eq!(fs::read(path).unwrap(), expected);
}

#[test]
fn extension_preparation_reports_obstructions_without_removing_legacy_configuration() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let legacy = home.0.join(".pi/agent/extensions/pi-define-agents");
    fs::create_dir_all(legacy.join("config.json")).unwrap();
    fs::write(legacy.join("index.ts"), "original").unwrap();
    #[cfg(not(debug_assertions))]
    assert!(prepare_defined_agents_extension().is_err());
    #[cfg(debug_assertions)]
    {
        assert!(prepare_defined_agents_extension().is_ok(), "development builds skip the legacy configuration import and legacy cleanup");
    }
    assert_eq!(fs::read_to_string(legacy.join("index.ts")).unwrap(), "original");
}

#[test]
fn defined_agent_preparation_migrates_configuration_once_and_preserves_user_changes() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let legacy = home.0.join(".pi/agent/extensions/pi-define-agents");
    fs::create_dir_all(&legacy).unwrap();
    let original = b"{\"agents\":[{\"name\":\"custom\"}]}\n";
    fs::write(legacy.join("config.json"), original).unwrap();
    fs::write(legacy.join("index.ts"), "old extension").unwrap();
    fs::write(legacy.join("notes.txt"), "keep").unwrap();
    let entry = prepare_defined_agents_extension().unwrap();
    assert_eq!(entry, generated_extension_root().unwrap().join("piop-define-agents/index.ts"));
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../../extensions/piop-define-agents/index.ts"));
    let config = entry.with_file_name("config.json");
    assert!(!config.exists(), "legacy configuration migration is disabled in development builds");
    assert_eq!(fs::read(legacy.join("config.json")).unwrap(), original);
    assert_eq!(fs::read_to_string(legacy.join("notes.txt")).unwrap(), "keep");
    fs::write(&entry, "outdated extension").unwrap();
    prepare_defined_agents_extension().unwrap();
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../../extensions/piop-define-agents/index.ts"));
    assert!(!config.exists(), "second install must not import legacy configuration in development builds");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&entry).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(entry.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let fresh = TestDirectory::new();
    drop(_home);
    let _fresh = HomeOverride::take(&fresh.0);
    let entry = prepare_defined_agents_extension().unwrap();
    assert!(!entry.with_file_name("config.json").exists(), "fresh installation must not invent user configuration");
}

#[test]
fn prepared_runtime_configuration_tracks_settings_and_removes_stale_values() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let mut settings = default_settings();
    settings.tools = vec![json!({"name":"read","enabled":true}), json!({"name":"bash","enabled":false})];
    settings.skills = vec![json!({"path":"/skill with spaces/SKILL.md","enabled":true}), json!({"path":"/disabled","enabled":false})];
    for enabled in [true, false] {
        settings.context_window_cap = if enabled { 12345 } else { 2000 };
        settings.context_window_cap_enabled = enabled;
        if !enabled { settings.skills.clear(); settings.tools.clear(); }
        let bridge = prepare_mcp_bridge().unwrap();
        let runtime = prepare_runtime_settings(&settings).unwrap();
        let context = prepare_context_window_cap_extension(&settings).unwrap();
        assert_eq!(fs::read_to_string(&bridge).unwrap(), include_str!("../../resources/mcp-bridge.bundle.mjs"));
        assert!(!bridge.with_file_name("mcp-servers.json").exists());
        assert_eq!(fs::read_to_string(&runtime).unwrap(), include_str!("../../../extensions/piop-runtime-settings/index.ts"));
        assert_eq!(fs::read_to_string(&context).unwrap(), include_str!("../../../extensions/piop-context-window-cap/index.ts"));
        let runtime_config = runtime.with_file_name("runtime-settings.json");
        let runtime_value: Value = serde_json::from_slice(&fs::read(&runtime_config).unwrap()).unwrap();
        assert!(runtime_value.get("mcpServers").is_none());
        assert_eq!(runtime_value["tools"], if enabled { json!(["read"]) } else { json!([]) });
        assert_eq!(runtime_value["skills"], if enabled { json!(["/skill with spaces/SKILL.md"]) } else { json!([]) });
        assert_eq!(runtime_value["contextWindowCap"], settings.context_window_cap);
        assert_eq!(runtime_value["contextWindowCapEnabled"], enabled);
        let context_config = context.with_file_name("config.json");
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(&context_config).unwrap()).unwrap(), json!({"contextWindowCap":settings.context_window_cap,"enabled":enabled}));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            for file in [&bridge, &runtime, &runtime_config, &context, &context_config] {
                assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
    }
}

#[test]
fn configuration_preparation_reports_failed_writes_and_cleans_temporary_files() {
    let settings = default_settings();
    for (relative, kind) in [("piop-mcp-bridge.ts", 0), ("runtime-settings.json", 1), ("piop-context-window-cap/config.json", 2)] {
        let home = TestDirectory::new();
        let _home = HomeOverride::take(&home.0);
        let obstruction = generated_extension_root().unwrap().join(relative);
        fs::create_dir_all(&obstruction).unwrap();
        fs::write(obstruction.join("keep"), "original").unwrap();
        let result = match kind {
            0 => prepare_mcp_bridge().map(|_| ()),
            1 => prepare_runtime_settings(&settings).map(|_| ()),
            _ => prepare_context_window_cap_extension(&settings).map(|_| ()),
        };
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(obstruction.join("keep")).unwrap(), "original");
        let files: Vec<_> = fs::read_dir(obstruction.parent().unwrap()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        let expected_files = match kind { 0 => 1, 1 => 4, _ => 2 };
        assert_eq!(files.len(), expected_files, "failed writes must not leave temporary files: {files:?}");
        if kind == 1 {
            assert!(files.contains(&std::ffi::OsString::from("provider-accounts.mjs")));
            assert!(files.contains(&std::ffi::OsString::from("runtime-bridge.cjs")));
        }
    }
}
