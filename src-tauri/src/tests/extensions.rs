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

#[test]
fn worktree_agent_lookup_includes_only_other_working_agents_on_the_same_host_and_root() {
    let runtime = PiRuntime::default();
    for (id, host, root, working) in [
        ("caller", "local", Some("/project"), true),
        ("peer", "local", Some("/project"), true),
        ("idle", "local", Some("/project"), false),
        ("remote", "remote", Some("/project"), true),
        ("different", "local", Some("/other"), true),
        ("no-root", "local", None, true),
    ] {
        runtime.active_agents.lock().unwrap().insert(id.into(), AgentAddress {
            host_id: host.into(), session_id: Some(format!("session-{id}")), session_path: None,
            worktree: root.map(str::to_owned), presence_id: Some(id.into()), working, messageable: true,
        });
    }
    assert_eq!(worktree_agents(&runtime, br#"{"id":"caller"}"#).unwrap(), json!([{"sessionId":"session-peer"}]));
    assert_eq!(worktree_agents(&runtime, br#"{"id":"peer"}"#).unwrap(), json!([{"sessionId":"session-caller"}]));
    assert_eq!(worktree_agents(&runtime, br#"{"id":"remote"}"#).unwrap(), json!([]));
    runtime.active_agents.lock().unwrap().get_mut("peer").unwrap().working = false;
    assert_eq!(worktree_agents(&runtime, br#"{"id":"caller"}"#).unwrap(), json!([]));
    assert_eq!(runtime.active_agents.lock().unwrap().len(), 6);
}

#[test]
fn worktree_agent_lookup_reports_invalid_requests_and_unidentified_callers() {
    let runtime = PiRuntime::default();
    assert_eq!(worktree_agents(&runtime, b"not-json").unwrap_err(), "Invalid worktree request");
    for body in [json!({}), json!({"id":42}), json!({"id":null}), json!([])] {
        assert_eq!(worktree_agents(&runtime, body.to_string().as_bytes()).unwrap_err(), "Agent identity is required");
    }
    assert_eq!(worktree_agents(&runtime, br#"{"id":"missing"}"#).unwrap_err(), "Could not identify this agent; try again");
    runtime.active_agents.lock().unwrap().insert("caller".into(), AgentAddress {
        host_id: "local".into(), session_id: None, session_path: None, worktree: None,
        presence_id: Some("caller".into()), working: false, messageable: false,
    });
    assert_eq!(worktree_agents(&runtime, br#"{"id":"caller"}"#).unwrap_err(), "Could not identify this worktree");
}

#[test]
fn remote_snapshot_operations_reject_invalid_tokens_before_starting_ssh() {
    let host = RemoteHost { id: "remote".into(), name: "Remote".into(), target: "unused.invalid".into(), pi_path: "pi".into() };
    let valid = json!({"root":"/home/user/.piop/git-snapshots/pi-desktop-diff-one","tree":"a".repeat(40),"repositoryRoot":"/project"});
    assert!(valid_remote_snapshot(&serde_json::from_value(valid.clone()).unwrap()));
    let mut invalid_tokens = vec!["invalid json".to_string(), "{}".into()];
    for root in ["relative/pi-desktop-diff-one", "/tmp/../pi-desktop-diff-one", "/tmp/unrelated", "/"] {
        let mut token = valid.clone(); token["root"] = json!(root); invalid_tokens.push(token.to_string());
    }
    for tree in ["a".repeat(39), "a".repeat(65), "g".repeat(40)] {
        let mut token = valid.clone(); token["tree"] = json!(tree); invalid_tokens.push(token.to_string());
    }
    for token in invalid_tokens {
        assert!(discard_git_tree_at_host(&token, Some(&host)).unwrap_err().starts_with("Invalid remote Git snapshot"));
        assert!(load_git_diff_at_host("/project", &token, Some(&host)).err().unwrap().starts_with("Invalid remote Git snapshot"));
        assert!(load_git_diff_between_at_host("/project", &token, &valid.to_string(), Some(&host)).err().unwrap().starts_with("Invalid remote Git snapshot"));
        assert!(load_git_diff_between_at_host("/project", &valid.to_string(), &token, Some(&host)).err().unwrap().starts_with("Invalid remote Git snapshot"));
    }
}

#[test]
fn remote_capture_protocol_validates_output_and_distinguishes_unsupported_from_failure() {
    let valid = json!({"root":"/home/remote/.piop/git-snapshots/pi-desktop-diff-valid", "tree":"a".repeat(40), "repository_root":"/project"});
    let emit = |value: &Value| {
        let mut command = Command::new("sh"); command.args(["-c", "printf %s \"$1\"", "fixture", &value.to_string()]); command
    };
    let result = query_remote_git_tree(&mut emit(&valid), "remote fixture").unwrap().unwrap();
    assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), valid);
    for code in [3, 4, 6] {
        let mut command = Command::new("sh"); command.args(["-c", &format!("printf malformed; exit {code}")]);
        assert!(query_remote_git_tree(&mut command, "remote fixture").unwrap().is_none());
    }
    let mut failed = Command::new("sh"); failed.args(["-c", "printf \u{27} snapshot refused \u{27} >&2; exit 5"]);
    assert_eq!(query_remote_git_tree(&mut failed, "remote fixture").unwrap_err(), "snapshot refused");
    for invalid in [json!(null), json!({}), json!({"root":"relative", "tree":"a".repeat(40), "repository_root":"/project"}), json!({"root":valid["root"], "tree":"x".repeat(40), "repository_root":"/project"}), json!({"root":valid["root"], "tree":valid["tree"], "repository_root":"relative"})] {
        assert!(query_remote_git_tree(&mut emit(&invalid), "remote fixture").unwrap_err().starts_with("Remote Git snapshot was invalid"));
    }
    let mut malformed = Command::new("sh"); malformed.args(["-c", "printf not-json"]);
    assert!(query_remote_git_tree(&mut malformed, "remote fixture").unwrap_err().starts_with("Remote Git snapshot was invalid"));
    let mut oversized = Command::new("node"); oversized.args(["-e", "process.stdout.write(\u{27}x\u{27}.repeat(65537))"]);
    assert!(query_remote_git_tree(&mut oversized, "remote fixture").unwrap_err().contains("Could not capture Git snapshot on remote fixture"));
    let mut missing = Command::new("/missing/piop-capture-test");
    assert!(query_remote_git_tree(&mut missing, "remote fixture").is_err());
}

#[test]
fn remote_capture_protocol_accepts_real_script_output_without_modifying_repository_index() {
    let home = TestDirectory::new(); let repository = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    fs::write(repository.0.join("file"), "committed\n").unwrap();
    test_git(&repository.0, &["add", "file"]); test_git(&repository.0, &["commit", "-m", "Initial"]);
    fs::write(repository.0.join("file"), "unstaged\n").unwrap();
    let index = fs::read(repository.0.join(".git/index")).unwrap();
    let script = format!("require(\u{27}node:os\u{27}).homedir = () => process.argv[1];\n{}", include_str!("../../resources/capture-git-tree.cjs"));
    let mut command = Command::new("node"); command.arg("-e").arg(script).arg(&home.0).current_dir(&repository.0).env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null");
    let token = query_remote_git_tree(&mut command, "isolated host").unwrap().unwrap();
    let snapshot: GitSnapshotToken = serde_json::from_str(&token).unwrap();
    assert_eq!(Path::new(&snapshot.repository_root), repository.0.canonicalize().unwrap());
    assert!(Path::new(&snapshot.root).starts_with(home.0.join(STORAGE_DIRECTORY).join("git-snapshots")));
    assert_eq!(fs::read(repository.0.join(".git/index")).unwrap(), index);
    let output = Command::new("git").args(["show", &format!("{}:file", snapshot.tree)]).current_dir(&repository.0).env("GIT_OBJECT_DIRECTORY", Path::new(&snapshot.root).join("objects")).output().unwrap();
    assert!(output.status.success()); assert_eq!(output.stdout, b"unstaged\n");
}

#[test]
fn remote_snapshot_patch_and_discard_use_only_owned_storage() {
    let home = TestDirectory::new(); let repository = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    fs::write(repository.0.join("file"), "before\n").unwrap();
    test_git(&repository.0, &["add", "file"]); test_git(&repository.0, &["commit", "-m", "Initial"]);
    let capture = || {
        let script = format!("require(\u{27}node:os\u{27}).homedir = () => process.argv[1];\n{}", include_str!("../../resources/capture-git-tree.cjs"));
        let mut command = Command::new("node"); command.arg("-e").arg(script).arg(&home.0).current_dir(&repository.0).env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY);
        query_remote_git_tree(&mut command, "fixture").unwrap().unwrap()
    };
    let shell = |script: String| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home.0).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null"); command
    };
    let before = capture();
    assert!(load_remote_git_diff_between(&before, &before, "fixture", shell).unwrap().is_none());
    fs::write(repository.0.join("file"), "after \u{65e5}\u{672c}\u{8a9e}\n").unwrap();
    let after = capture();
    let snapshot = load_remote_git_diff_between(&before, &after, "fixture", shell).unwrap().unwrap();
    match snapshot {
        GitDiffSnapshot::Located { patch, repository_root, tool_paths } => {
            assert!(patch.contains("-before\n+after \u{65e5}\u{672c}\u{8a9e}\n"), "{patch}");
            assert_eq!(Path::new(&repository_root), repository.0.canonicalize().unwrap());
            assert!(tool_paths.is_empty());
        }
        _ => panic!("remote patch lost its repository location"),
    }
    let outside = home.0.join("pi-desktop-diff-outside"); fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious"), "keep").unwrap();
    let mut escaped: Value = serde_json::from_str(&before).unwrap(); escaped["root"] = json!(outside);
    assert!(discard_remote_git_tree(&escaped.to_string(), "fixture", shell).is_err());
    assert!(load_remote_git_diff_between(&escaped.to_string(), &after, "fixture", shell).is_err());
    #[cfg(unix)] {
        let alias = home.0.join(STORAGE_DIRECTORY).join("git-snapshots/pi-desktop-diff-alias");
        std::os::unix::fs::symlink(&outside, &alias).unwrap(); escaped["root"] = json!(alias);
        assert!(discard_remote_git_tree(&escaped.to_string(), "fixture", shell).is_err());
        assert!(load_remote_git_diff_between(&before, &escaped.to_string(), "fixture", shell).is_err());
    }
    assert_eq!(fs::read_to_string(outside.join("precious")).unwrap(), "keep");
    for token in [&before, &after] {
        let snapshot: GitSnapshotToken = serde_json::from_str(token).unwrap();
        discard_remote_git_tree(token, "fixture", shell).unwrap();
        assert!(!Path::new(&snapshot.root).exists());
    }
    assert_eq!(fs::read_to_string(repository.0.join("file")).unwrap(), "after \u{65e5}\u{672c}\u{8a9e}\n");
}

#[test]
fn remote_snapshot_process_failures_propagate_and_invalid_tokens_never_launch() {
    let token = json!({"root":"/tmp/pi-desktop-diff-test", "tree":"a".repeat(40), "repository_root":"/project"}).to_string();
    for invalid in ["bad JSON", "{}", "{\"root\":\"relative\",\"tree\":\"bad\"}"] {
        assert!(discard_remote_git_tree(invalid, "fixture", |_| panic!("invalid deletion launched")).is_err());
        assert!(load_remote_git_diff_between(invalid, &token, "fixture", |_| panic!("invalid base launched")).is_err());
        assert!(load_remote_git_diff_between(&token, invalid, "fixture", |_| panic!("invalid current launched")).is_err());
    }
    let fail = |_: String| { let mut command = Command::new("sh"); command.args(["-c", "printf \u{27}denied\u{27} >&2; exit 9"]); command };
    assert_eq!(discard_remote_git_tree(&token, "fixture", fail).unwrap_err(), "denied");
    assert_eq!(load_remote_git_diff_between(&token, &token, "fixture", fail).err().unwrap(), "denied");
    assert!(discard_remote_git_tree(&token, "fixture", |_| Command::new("/missing/piop-test")).unwrap_err().contains("Could not discard Git snapshot on fixture"));
    assert!(load_remote_git_diff_between(&token, &token, "fixture", |_| Command::new("/missing/piop-test")).is_err());
    assert!(load_remote_git_diff_between(&token, &token, "fixture", |_| {
        let mut command = Command::new("node"); command.args(["-e", &format!("process.stdout.write(\u{27}x\u{27}.repeat({}))", MAX_GIT_PATCH_BYTES + 1)]); command
    }).err().unwrap().contains("Git patch on fixture is too large"));
}

#[test]
fn malformed_snapshot_tokens_are_rejected_before_accessing_snapshot_storage() {
    for token in ["", "not json", "null", "{}", "{\"root\":42,\"tree\":\"abc\"}"] {
        assert_eq!(parse_local_snapshot(token).err().unwrap(), "Invalid Git snapshot token");
    }
    for tree in ["a".repeat(39), "a".repeat(65), "g".repeat(40), format!("{};", "a".repeat(39))] {
        let token = json!({"root":"/not-accessed","tree":tree}).to_string();
        assert_eq!(parse_local_snapshot(&token).err().unwrap(), "Invalid Git snapshot tree");
    }
}

#[test]
fn snapshot_comparison_detects_renames_and_reports_unavailable_objects() {
    let repository = TestDirectory::new(); let snapshots = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    fs::write(repository.0.join("before.txt"), "unchanged content\n").unwrap();
    test_git(&repository.0, &["add", "."]); test_git(&repository.0, &["commit", "-m", "Initial"]);
    test_git(&repository.0, &["config", "diff.external", "this-command-must-not-run"]);
    test_git(&repository.0, &["config", "color.ui", "always"]);
    let (root, objects) = git_root_and_objects(repository.0.to_str().unwrap()).unwrap().unwrap();
    let capture = || serde_json::from_str::<GitSnapshotToken>(&capture_local_git_tree(&root, &objects, &snapshots.0).unwrap()).unwrap();
    let base = capture();
    fs::rename(repository.0.join("before.txt"), repository.0.join("after.txt")).unwrap();
    let mut current = capture();
    let result = local_git_diff_between(root.to_str().unwrap(), &base, &current).unwrap().unwrap();
    let GitDiffSnapshot::Located { patch, repository_root, .. } = result else { panic!("expected located patch") };
    assert!(patch.contains("rename from before.txt\n"));
    assert!(patch.contains("rename to after.txt\n"));
    assert!(!patch.contains('\u{1b}'));
    assert_eq!(repository_root, root.to_string_lossy());
    current.tree = "0".repeat(40);
    assert!(local_git_diff_between(root.to_str().unwrap(), &base, &current).is_err());
    current.repository_root = repository.0.join("missing").to_string_lossy().into_owned();
    assert!(local_git_diff_between(root.to_str().unwrap(), &base, &current).is_err());
    assert_eq!(fs::read_to_string(repository.0.join("after.txt")).unwrap(), "unchanged content\n");
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
fn registered_cancellation_reaches_a_running_setup_process() {
    let runtime = PiRuntime::default(); let directory = TestDirectory::new();
    let id = register_worktree_setup(&runtime).unwrap();
    let signal = runtime.worktree_setups.lock().unwrap()[&id].clone();
    let ready = directory.0.join("ready"); let received = directory.0.join("received");
    let worker_ready = ready.clone(); let worker_received = received.clone();
    let worker = thread::spawn(move || {
        run_setup_process(Command::new("node").args(["-e", "const fs=require(\u{27}fs\u{27});fs.writeFileSync(process.argv[1],\u{27}ready\u{27});process.stdin.once(\u{27}data\u{27},data=>{fs.writeFileSync(process.argv[2],data);process.exit(0)});", worker_ready.to_str().unwrap(), worker_received.to_str().unwrap()]), &signal, "Setup", "DONE".into(), "User cancelled setup", Some(Duration::from_secs(10)))
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
    signal_worktree_setup_cancellation(&runtime, &id).unwrap();
    let result = worker.join().unwrap();
    assert!(ready.exists(), "setup process did not become ready");
    assert_eq!(result.unwrap_err(), "User cancelled setup");
    assert_eq!(fs::read_to_string(&received).unwrap(), "cancel\n");
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
            3
        } else { 2 };
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), expected_files);
        fs::remove_file(&target).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "original directory").unwrap();
        assert!(install().is_err());
        assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "original directory");
    }
}

#[test]
fn development_extensions_are_scoped_to_the_daemon_worktree() {
    if !DEVELOPMENT { return; }
    let home = TestDirectory::new(); let _home = HomeOverride::take(&home.0);
    let path = prepare_mcp_bridge().unwrap();
    assert!(path.starts_with(daemon_endpoint::directory().unwrap()));
    let expected = fs::read(&path).unwrap();
    fs::write(home.0.join(STORAGE_DIRECTORY).join("piop-mcp-bridge.ts"), "other worktree build").unwrap();
    assert_eq!(fs::read(path).unwrap(), expected);
}


#[test]
fn side_conversation_preparation_removes_only_the_legacy_extension_after_installing() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let entry = generated_extension_root().unwrap().join("piop-btw.ts");
    let legacy = home.0.join(".pi/agent/extensions/pi-desktop-btw.ts");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, "old btw").unwrap();
    let other = legacy.with_file_name("user-extension.ts");
    fs::write(&other, "keep").unwrap();
    assert_eq!(prepare_btw_extension().unwrap(), entry);
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../resources/btw.ts"));
    assert_eq!(legacy.exists(), DEVELOPMENT, "legacy cleanup is disabled in development builds");
    assert_eq!(fs::read_to_string(&other).unwrap(), "keep");
    assert_eq!(prepare_btw_extension().unwrap(), entry);
    fs::remove_file(&entry).unwrap();
    fs::create_dir(&entry).unwrap();
    fs::write(&legacy, "preserve until install succeeds").unwrap();
    assert!(prepare_btw_extension().is_err());
    assert_eq!(fs::read_to_string(&legacy).unwrap(), "preserve until install succeeds");
}

#[test]
fn diff_watch_preparation_replaces_legacy_assets_and_refreshes_all_bundled_files() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let legacy = home.0.join(STORAGE_DIRECTORY).join("pi-git-change-context");
    fs::create_dir_all(legacy.join("nested")).unwrap();
    fs::write(legacy.join("nested/stale.ts"), "stale").unwrap();
    let entry = prepare_diff_watch_extension().unwrap();
    assert!(!legacy.exists());
    assert_eq!(entry, generated_extension_root().unwrap().join("piop-diff-watch/index.ts"));
    for _ in 0..2 {
        assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../../extensions/piop-diff-watch/index.ts"));
        prepare_diff_watch_extension().unwrap();
    }
    assert_eq!(fs::read_dir(entry.parent().unwrap()).unwrap().count(), 1, "no temporary files should remain");
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
    drop(_home);
    let blocked = TestDirectory::new();
    let _blocked = HomeOverride::take(&blocked.0);
    fs::create_dir_all(blocked.0.join(STORAGE_DIRECTORY)).unwrap();
    let legacy_diff = blocked.0.join(STORAGE_DIRECTORY).join("pi-git-change-context");
    fs::write(&legacy_diff, "unexpected file").unwrap();
    assert!(prepare_diff_watch_extension().unwrap_err().contains("Could not remove legacy diff watch extension"));
    assert_eq!(fs::read_to_string(&legacy_diff).unwrap(), "unexpected file");
    assert!(!blocked.0.join(STORAGE_DIRECTORY).join("piop-diff-watch").exists());
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
fn temporary_startup_creates_one_fork_and_reuses_its_saved_identity() {
    let home = TestDirectory::new(); let temporary = TestDirectory::new(); let runtime = PiRuntime::default();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("original.jsonl"); let original = "{\"type\":\"session\",\"id\":\"source\"}\n{\"type\":\"message\",\"text\":\"history\"}\n";
    fs::write(&source, original).unwrap();
    let path = prepare_ephemeral_path(&runtime, "view", true, None, source.to_str(), |actual| {
        assert_eq!(actual, source.to_str().unwrap()); create_local_ephemeral_fork(&home.0, &temporary.0, actual, None)
    }).unwrap().unwrap();
    let copied = fs::read_to_string(&path).unwrap();
    let saved = runtime.ephemeral_sessions.lock().unwrap().get("view").cloned();
    let reused = prepare_ephemeral_path(&runtime, "view", true, saved, Some("ignored-new-source"), |_| panic!("saved fork recreated")).unwrap();
    assert_eq!(reused.as_deref(), Some(path.as_str()));
    assert_eq!(fs::read_to_string(&path).unwrap(), copied); assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 1);
    let session = runtime.ephemeral_sessions.lock().unwrap().remove("view").unwrap(); remove_ephemeral_session(session);
    assert!(!Path::new(&path).exists());
}

#[test]
fn temporary_snapshot_reconnects_to_the_latest_branch_and_cleans_every_owned_file() {
    let directory = TestDirectory::new(); let runtime = PiRuntime::default();
    let first = directory.0.join("first.jsonl"); let second = directory.0.join("second.jsonl");
    fs::write(&first, "{}").unwrap(); fs::write(&second, "{}").unwrap();
    runtime.ephemeral_sessions.lock().unwrap().insert("stable".into(), EphemeralSession::Local(first.clone()));
    runtime.ephemeral_keys.lock().unwrap().insert("view".into(), "stable".into());
    update_runtime_snapshot(&runtime, "view", &json!({"sessionFile":second,"sessionId":"branch"})).unwrap();
    assert_eq!(runtime.ephemeral_sessions.lock().unwrap()["stable"].path(), second.to_string_lossy());
    detach_pi(&runtime, "view", false).unwrap();
    assert!(!first.exists()); assert!(!second.exists());
    assert!(runtime.ephemeral_sessions.lock().unwrap().is_empty());
}

#[cfg(not(feature = "desktop"))]
#[test]
fn rejected_temporary_startup_rolls_back_the_prepared_fork() {
    let home = TestDirectory::new(); let _home = HomeOverride::take(&home.0);
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("source.jsonl");
    fs::write(&source, format!("{}\n", json!({"type":"session","id":"source","cwd":home.0}))).unwrap();
    let app = AppHandle::new();
    let options = StartPiOptions { runtime_id: "view".into(), cwd: None, session_path: None, session_id: None, fork_path: Some(source.to_string_lossy().into_owned()), fork_leaf_id: None, no_session: Some(true), host_id: None, presence: Some(json!({"readOnly":true})), client_id: "client".into() };
    let error = start_pi_for_owner(app.clone(), "owner".into(), app.state(), app.state(), options).unwrap_err();
    assert!(error.contains("read-only view requires"));
    let runtime = app.state::<PiRuntime>();
    assert!(runtime.ephemeral_sessions.lock().unwrap().is_empty());
    assert!(runtime.ephemeral_keys.lock().unwrap().is_empty());
    assert!(source.exists());
}

#[test]
fn temporary_startup_preserves_remote_cleanup_metadata_and_isolates_failures() {
    let runtime = PiRuntime::default();
    let host = RemoteHost { id: "remote".into(), name: "Server".into(), target: "user@example.com".into(), pi_path: "pi".into() };
    let saved = EphemeralSession::Remote { host, path: "/tmp/existing-fork.jsonl".into() };
    assert_eq!(prepare_ephemeral_path(&runtime, "remote-view", true, Some(saved), None, |_| panic!("saved remote fork recreated")).unwrap().as_deref(), Some("/tmp/existing-fork.jsonl"));
    for (ephemeral, source) in [(false, None), (false, Some("/source")), (true, None)] {
        assert!(prepare_ephemeral_path(&runtime, "empty", ephemeral, None, source, |_| panic!("unneeded fork created")).unwrap().is_none());
        assert!(!runtime.ephemeral_sessions.lock().unwrap().contains_key("empty"));
    }
    assert_eq!(prepare_ephemeral_path(&runtime, "failed", true, None, Some("/source"), |_| Err("fork failed".into())).unwrap_err(), "fork failed");
    let sessions = runtime.ephemeral_sessions.lock().unwrap();
    assert_eq!(sessions.len(), 1);
    match &sessions["remote-view"] {
        EphemeralSession::Remote { host, path } => { assert_eq!(host.target, "user@example.com"); assert_eq!(host.id, "remote"); assert_eq!(path, "/tmp/existing-fork.jsonl"); }
        _ => panic!("remote cleanup metadata replaced"),
    }
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
        let expected_files = match kind { 0 => 1, 1 => 3, _ => 2 };
        assert_eq!(files.len(), expected_files, "failed writes must not leave temporary files: {files:?}");
        if kind == 1 { assert!(files.contains(&std::ffi::OsString::from("provider-accounts.mjs"))); }
    }
}
