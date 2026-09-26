#[test]
fn git_project_detection_distinguishes_main_worktrees_and_plain_directories() {
    let root = TestDirectory::new(); let settings = default_settings();
    let repository = root.0.join("main project"); fs::create_dir(&repository).unwrap();
    assert!(matches!(inspect_git_project_kind(&settings, repository.to_str().unwrap(), "local").unwrap(), ProjectKind::NoRepo));
    test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial test commit"]);
    assert!(matches!(inspect_git_project_kind(&settings, repository.to_str().unwrap(), "local").unwrap(), ProjectKind::Main));
    let worktree = root.0.join("linked project");
    test_git(&repository, &["worktree", "add", "-b", "test-linked", worktree.to_str().unwrap()]);
    assert!(matches!(inspect_git_project_kind(&settings, worktree.to_str().unwrap(), "local").unwrap(), ProjectKind::Worktree));
    let nested = worktree.join("nested"); fs::create_dir(&nested).unwrap();
    assert!(matches!(inspect_git_project_kind(&settings, nested.to_str().unwrap(), "local").unwrap(), ProjectKind::Worktree));
    assert!(inspect_git_project_kind(&settings, root.0.join("missing").to_str().unwrap(), "local").unwrap_err().contains("Project directory does not exist"));
    let (main_root, main_objects) = git_root_and_objects(repository.to_str().unwrap()).unwrap().unwrap();
    let (linked_root, linked_objects) = git_root_and_objects(nested.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(main_root, repository.canonicalize().unwrap());
    assert_eq!(linked_root, worktree.canonicalize().unwrap());
    assert_eq!(main_objects, linked_objects, "linked worktrees share the object database");
    assert!(git_root_and_objects(root.0.to_str().unwrap()).unwrap().is_none());
    assert!(git_root_and_objects(root.0.join("missing").to_str().unwrap()).unwrap_err().contains("Could not open project directory"));
    let bare = root.0.join("bare"); fs::create_dir(&bare).unwrap(); test_git(&bare, &["init", "--bare"]);
    assert!(matches!(inspect_git_project_kind(&settings, bare.to_str().unwrap(), "local").unwrap(), ProjectKind::Main));
    let file = root.0.join("file"); fs::write(&file, "not a directory").unwrap();
    assert!(inspect_git_project_kind(&settings, file.to_str().unwrap(), "local").unwrap_err().contains("Project directory does not exist"));
}
#[test]
fn git_capture_limits_accept_exact_file_and_total_boundaries() {
    let root = TestDirectory::new(); test_git(&root.0, &["init", "--initial-branch=main"]);
    let bounded = || local_git_input_is_bounded(root.0.to_str().unwrap(), &root.0).unwrap();
    assert!(bounded());
    let first = fs::File::create(root.0.join("first.bin")).unwrap(); first.set_len(MAX_GIT_FILE_BYTES).unwrap();
    assert!(bounded(), "the per-file boundary is inclusive");
    first.set_len(MAX_GIT_FILE_BYTES + 1).unwrap(); assert!(!bounded());
    first.set_len(MAX_GIT_FILE_BYTES).unwrap();
    let second = fs::File::create(root.0.join("second.bin")).unwrap(); second.set_len(MAX_GIT_SNAPSHOT_BYTES - MAX_GIT_FILE_BYTES).unwrap();
    assert!(bounded(), "the total snapshot boundary is inclusive");
    fs::write(root.0.join("third.bin"), [1]).unwrap(); assert!(!bounded(), "combined files must respect the total limit");
    fs::remove_file(root.0.join("third.bin")).unwrap(); assert!(bounded());
}

#[test]
fn git_capture_counts_staged_and_unstaged_paths_once_and_ignores_excluded_files() {
    let root = TestDirectory::new(); test_git(&root.0, &["init", "--initial-branch=main"]);
    fs::write(root.0.join(".gitignore"), "ignored.bin\n").unwrap();
    fs::write(root.0.join("tracked.bin"), "initial").unwrap();
    test_git(&root.0, &["add", ".gitignore", "tracked.bin"]);
    test_git(&root.0, &["commit", "-m", "Seed tracked files"]);
    let ignored = fs::File::create(root.0.join("ignored.bin")).unwrap(); ignored.set_len(MAX_GIT_FILE_BYTES + 1).unwrap();
    let bounded = || local_git_input_is_bounded(root.0.to_str().unwrap(), &root.0).unwrap();
    assert!(bounded(), "ignored files are outside the capture");
    fs::write(root.0.join("tracked.bin"), "staged modification").unwrap(); test_git(&root.0, &["add", "tracked.bin"]);
    let tracked = fs::OpenOptions::new().write(true).open(root.0.join("tracked.bin")).unwrap(); tracked.set_len(MAX_GIT_FILE_BYTES).unwrap();
    let extra = fs::File::create(root.0.join("extra.bin")).unwrap(); extra.set_len(1).unwrap();
    assert!(bounded(), "a path listed as both staged and modified must count once");
    tracked.set_len(MAX_GIT_FILE_BYTES + 1).unwrap(); assert!(!bounded(), "tracked modifications must also be bounded");
    fs::remove_file(root.0.join("tracked.bin")).unwrap(); assert!(bounded(), "deleted paths have no content to capture");
    let plain = root.0.join("plain"); fs::create_dir(&plain).unwrap();
    let outside = TestDirectory::new();
    assert!(local_git_input_is_bounded(outside.0.to_str().unwrap(), &outside.0).is_err());
}

#[test]
fn limited_process_output_accepts_exact_limits_and_preserves_failure_status() {
    let output = run_limited(Command::new("node").args(["-e", "process.stdout.write(Buffer.from([0,255,10,65]));process.stderr.write('diagnostic');process.exitCode=7"]), 4, "test command").unwrap();
    assert_eq!(output.stdout, [0, 255, 10, 65]);
    assert_eq!(output.stderr, b"diagnostic"); assert_eq!(output.status.code(), Some(7));
    let empty = run_limited(Command::new("node").args(["-e", ""]), 0, "empty command").unwrap();
    assert!(empty.status.success()); assert!(empty.stdout.is_empty()); assert!(empty.stderr.is_empty());
}

#[test]
fn limited_process_output_rejects_overflow_and_retains_bounded_diagnostics() {
    let error = run_limited(Command::new("node").args(["-e", "process.stdout.write('12345')"]), 4, "Git capture").err().unwrap();
    assert!(error.starts_with("Git capture: output exceeded"));
    let output = run_limited(Command::new("node").args(["-e", "process.stderr.write('prefix'+ 'x'.repeat(200000));process.stdout.write('done')"]), 4, "large diagnostics").unwrap();
    assert!(output.status.success()); assert_eq!(output.stdout, b"done");
    assert_eq!(output.stderr.len(), 64 * 1024); assert!(output.stderr.starts_with(b"prefix"));
    let root = TestDirectory::new();
    let missing = run_limited(&mut Command::new(root.0.join("missing-executable")), 4, "Start helper").err().unwrap();
    assert!(missing.starts_with("Start helper:"));
}

#[test]
fn setup_process_uses_completion_protocol_and_ignores_login_noise() {
    let script = "const fs=require('fs');fs.writeSync(2,'setup details');fs.writeSync(1,'login banner\\n'+ 'x'.repeat(400)+'\\nDONE invalid\\nOTHER 99\\nDONE 7\\n');";
    let (status, stderr) = run_setup_process(Command::new("node").args(["-e", script]), &AtomicBool::new(false), "Setup", "DONE".into(), "Cancelled", None).unwrap();
    assert_eq!(status, 7); assert_eq!(stderr, b"setup details");
    let (status, stderr) = run_setup_process(Command::new("node").args(["-e", "process.stderr.write('failed');process.exitCode=3"]), &AtomicBool::new(false), "Setup", "DONE".into(), "Cancelled", None).unwrap();
    assert_eq!(status, 3); assert_eq!(stderr, b"failed");
}

#[test]
fn setup_cancellation_and_timeout_send_the_stop_request_and_report_the_reason() {
    let script = "process.stdin.once('data', chunk=>{process.exitCode=chunk.toString()==='cancel\\n'?0:2;process.stdin.destroy()});";
    for (cancelled, timeout, expected) in [
        (true, None, "Environment setup cancelled"),
        (false, Some(Duration::ZERO), "Environment setup timed out after 5 minutes"),
    ] {
        let error = run_setup_process(Command::new("node").args(["-e", script]), &AtomicBool::new(cancelled), "Environment setup", "DONE".into(), "Environment setup cancelled", timeout).unwrap_err();
        assert_eq!(error, expected);
    }
}

#[test]
fn setup_process_bounds_diagnostics_and_reports_spawn_failures() {
    let (status, stderr) = run_setup_process(Command::new("node").args(["-e", "process.stderr.write('prefix'+'x'.repeat(200000))"]), &AtomicBool::new(false), "Setup", "DONE".into(), "Cancelled", None).unwrap();
    assert_eq!(status, 0); assert_eq!(stderr.len(), 64 * 1024); assert!(stderr.starts_with(b"prefix"));
    let root = TestDirectory::new();
    let error = run_setup_process(&mut Command::new(root.0.join("missing")), &AtomicBool::new(false), "Start setup", "DONE".into(), "Cancelled", None).unwrap_err();
    assert!(error.starts_with("Start setup:"));
}

#[test]
fn untracked_copy_preserves_nested_files_without_copying_repository_metadata() {
    let source = TestDirectory::new(); let target = TestDirectory::new();
    fs::create_dir_all(source.0.join("nested/deeper")).unwrap();
    fs::write(source.0.join("nested/deeper/binary"), [0, 255, 128]).unwrap();
    fs::create_dir(source.0.join("nested/.git")).unwrap();
    fs::write(source.0.join("nested/.git/config"), "source-only metadata").unwrap();
    copy_untracked_file(&source.0, &target.0, Path::new("nested")).unwrap();
    assert_eq!(fs::read(target.0.join("nested/deeper/binary")).unwrap(), [0, 255, 128]);
    assert!(!target.0.join("nested/.git").exists());
    assert_eq!(fs::read_to_string(source.0.join("nested/.git/config")).unwrap(), "source-only metadata");
    for invalid in ["../escape", "/absolute", "nested/../../escape"] {
        assert_eq!(copy_untracked_file(&source.0, &target.0, Path::new(invalid)).unwrap_err(), "Git returned an invalid untracked path");
    }
    assert!(copy_untracked_file(&source.0, &target.0, Path::new("missing")).unwrap_err().contains("Could not inspect untracked file"));
}

#[cfg(unix)]
#[test]
fn untracked_copy_preserves_symlinks_and_non_utf8_path_bytes() {
    use std::os::unix::{fs::symlink, ffi::OsStrExt};
    let source = TestDirectory::new(); let target = TestDirectory::new();
    symlink("../outside", source.0.join("link")).unwrap();
    copy_untracked_file(&source.0, &target.0, Path::new("link")).unwrap();
    assert_eq!(fs::read_link(target.0.join("link")).unwrap(), PathBuf::from("../outside"));
    assert!(fs::symlink_metadata(target.0.join("link")).unwrap().file_type().is_symlink());
    let relative = git_relative_path(b"name-\xff");
    assert_eq!(relative.as_os_str().as_bytes(), b"name-\xff");
    fs::write(source.0.join(&relative), b"payload").unwrap();
    copy_untracked_file(&source.0, &target.0, &relative).unwrap();
    assert_eq!(fs::read(target.0.join(relative)).unwrap(), b"payload");
}

#[test]
fn created_worktree_cleanup_removes_its_registration_and_branch_only() {
    let root = TestDirectory::new(); let source = root.0.join("source"); fs::create_dir(&source).unwrap();
    test_git(&source, &["init", "--initial-branch=main"]); test_git(&source, &["commit", "--allow-empty", "-m", "Initial"]);
    let target = root.0.join("linked worktree");
    assert!(!local_branch_exists(&source, "feature").unwrap()); assert!(!local_worktree_is_registered(&source, &target).unwrap());
    test_git(&source, &["worktree", "add", "-b", "feature", target.to_str().unwrap()]);
    assert!(local_branch_exists(&source, "feature").unwrap()); assert!(local_worktree_is_registered(&source, &target).unwrap());
    fs::write(target.join("partial-setup"), "temporary").unwrap();
    remove_created_worktree(&source, &target, "feature");
    assert!(!target.exists()); assert!(!local_branch_exists(&source, "feature").unwrap());
    assert!(!local_worktree_is_registered(&source, &target).unwrap());
    assert!(local_branch_exists(&source, "main").unwrap()); assert!(local_worktree_is_registered(&source, &source).unwrap());
}

#[test]
fn runtime_settings_include_only_enabled_named_tools_and_valid_skill_paths() {
    let mut settings = default_settings();
    settings.tools = vec![json!({"name":"read","enabled":true}), json!({"name":"bash","enabled":false}), json!({"name":"write"}), json!({"name":42,"enabled":true}), json!({"name":"edit","enabled":"true"})];
    settings.skills = vec![json!({"path":"/skills/active","enabled":true}), json!({"path":"/skills/off","enabled":false}), json!({"path":42,"enabled":true}), json!({"path":"/skills/unset"})];
    settings.context_window_cap = 12345; settings.context_window_cap_enabled = false;
    assert_eq!(runtime_settings(&settings), json!({
        "tools":["read"], "skills":["/skills/active"], "explicitOnlySkills":[],
        "contextWindowCap":12345, "contextWindowCapEnabled":false
    }));
    assert_eq!(settings.tools.len(), 5, "conversion must not mutate saved settings");
}

#[test]
fn skill_invocation_policy_respects_yaml_scope_comments_and_quoted_booleans() {
    let directory = TestDirectory::new();
    assert!(!codex_disables_implicit_invocation(&directory.0));
    fs::create_dir(directory.0.join("agents")).unwrap();
    let path = directory.0.join("agents/openai.yaml");
    for (content, expected) in [
        ("policy:\n  allow_implicit_invocation: false\n", true),
        ("# heading\npolicy:\n\n  # comment\n  allow_implicit_invocation: 'FALSE' # disabled\n", true),
        ("policy:\n  allow_implicit_invocation: \"false\"\n", true),
        ("policy:\n  allow_implicit_invocation: true\n", false),
        ("allow_implicit_invocation: false\n", false),
        ("policy:\n  other: false\ninterface:\n  allow_implicit_invocation: false\n", false),
        ("policy:\n  malformed line\n  other: false\n", false),
    ] {
        fs::write(&path, content).unwrap();
        assert_eq!(codex_disables_implicit_invocation(&directory.0), expected, "{content}");
    }
}

#[test]
fn skill_discovery_uses_metadata_and_stops_at_parent_skill_boundaries() {
    let root = TestDirectory::new();
    for path in ["parent/nested", "fallback", ".hidden", "node_modules/package", "codex/agents"] {
        fs::create_dir_all(root.0.join(path)).unwrap();
    }
    fs::write(root.0.join("parent/SKILL.md"), "---\nname: Named skill\ndescription: Useful description\ndisable-model-invocation: true\n---\nBody").unwrap();
    for path in ["parent/nested", "fallback", ".hidden", "node_modules/package", "codex"] {
        fs::write(root.0.join(path).join("SKILL.md"), "Body without metadata").unwrap();
    }
    fs::write(root.0.join("codex/agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n").unwrap();
    let discovered = discover_skills_in(&root.0, false);
    assert_eq!(discovered.len(), 3);
    let named = discovered.iter().find(|skill| skill["name"] == "Named skill").unwrap();
    assert_eq!(named["description"], "Useful description"); assert_eq!(named["userInvokedOnly"], true);
    assert_eq!(named["path"], root.0.join("parent").to_string_lossy().as_ref());
    let fallback = discovered.iter().find(|skill| skill["name"] == "fallback").unwrap();
    assert_eq!(fallback["description"], "Pi skill"); assert_eq!(fallback["userInvokedOnly"], false);
    assert_eq!(discovered.iter().find(|skill| skill["name"] == "codex").unwrap()["userInvokedOnly"], true);
    for skill in discovered { assert_eq!(skill["enabled"], true); assert_eq!(skill["discovered"], true); }
    assert!(discover_skills_in(&root.0.join("missing"), true).is_empty());
}

#[test]
fn root_markdown_skills_are_opt_in_and_use_file_stems_as_fallbacks() {
    let root = TestDirectory::new();
    fs::write(root.0.join("notes.md"), "Plain skill").unwrap();
    fs::write(root.0.join("named.md"), "---\nname: Explicit\ndescription: File skill\ndisable-model-invocation: TRUE\n---\n").unwrap();
    fs::write(root.0.join("ignored.txt"), "Not a skill").unwrap();
    fs::create_dir(root.0.join("directory.md")).unwrap();
    assert!(discover_skills_in(&root.0, false).is_empty());
    let discovered = discover_skills_in(&root.0, true);
    assert_eq!(discovered.len(), 2);
    let plain = discovered.iter().find(|skill| skill["name"] == "notes").unwrap();
    assert_eq!(plain["path"], root.0.join("notes.md").to_string_lossy().as_ref());
    assert_eq!(plain["description"], "Pi skill"); assert_eq!(plain["userInvokedOnly"], false);
    let named = discovered.iter().find(|skill| skill["name"] == "Explicit").unwrap();
    assert_eq!(named["description"], "File skill"); assert_eq!(named["userInvokedOnly"], true);
    fs::write(root.0.join("SKILL.md"), "---\nname: Root\n---\n").unwrap();
    assert_eq!(discover_skills_in(&root.0, true).iter().filter(|skill| skill["name"] == "Root").count(), 1);
}

#[test]
fn broker_claims_are_scoped_by_host_and_released_by_their_owner() {
    let broker = BrokerRuntime::default();
    let first = claim_agent(&broker, "local", "session").unwrap();
    assert_eq!(claim_agent(&broker, "local", "session").err().unwrap(), "Agent local/session is already responding");
    let remote = claim_agent(&broker, "remote", "session").unwrap();
    let second = claim_agent(&broker, "local", "other").unwrap();
    assert_eq!(broker.busy.lock().unwrap().len(), 3);
    drop(first);
    let replacement = claim_agent(&broker, "local", "session").unwrap();
    assert!(claim_agent(&broker, "remote", "session").is_err(), "releasing one agent must preserve other claims");
    drop((replacement, remote, second)); assert!(broker.busy.lock().unwrap().is_empty());
}

#[test]
fn concurrent_broker_requests_can_claim_an_agent_only_once() {
    let broker = BrokerRuntime::default();
    let ready = Arc::new(std::sync::Barrier::new(9));
    let claimed = Arc::new(std::sync::Barrier::new(9));
    let release = Arc::new(std::sync::Barrier::new(9));
    let workers = (0..8).map(|_| {
        let broker = broker.clone(); let ready = ready.clone(); let claimed = claimed.clone(); let release = release.clone();
        thread::spawn(move || {
            ready.wait(); let claim = claim_agent(&broker, "local", "shared");
            claimed.wait(); release.wait(); claim.is_ok()
        })
    }).collect::<Vec<_>>();
    ready.wait(); claimed.wait();
    assert_eq!(broker.busy.lock().unwrap().len(), 1);
    release.wait();
    assert_eq!(workers.into_iter().map(|worker| usize::from(worker.join().unwrap())).sum::<usize>(), 1);
    assert!(broker.busy.lock().unwrap().is_empty());
    assert!(claim_agent(&broker, "local", "shared").is_ok());
}

#[test]
fn broker_environment_requires_a_ready_listener_and_returns_its_credentials() {
    let broker = BrokerRuntime::default();
    assert_eq!(broker_environment(&broker).unwrap_err(), "Session broker is not ready");
    *broker.port.lock().unwrap() = 12345;
    let (port, token) = broker_environment(&broker).unwrap();
    assert_eq!(port, 12345); assert_eq!(token, broker.token); assert!(Uuid::parse_str(&token).is_ok());
    *broker.port.lock().unwrap() = 0;
    assert!(broker_environment(&broker).is_err());
}

#[test]
fn worktree_removal_inspection_rejects_main_dirty_and_locked_checkouts() {
    let root = TestDirectory::new(); let source = root.0.join("source"); fs::create_dir(&source).unwrap();
    test_git(&source, &["init", "--initial-branch=main"]); test_git(&source, &["commit", "--allow-empty", "-m", "Initial"]);
    let settings = default_settings();
    assert!(inspect_worktree_removal(&settings, source.to_str().unwrap(), "local").err().unwrap().contains("main checkout cannot be deleted"));
    assert!(inspect_worktree_removal(&settings, root.0.to_str().unwrap(), "local").err().unwrap().contains("not a Git repository"));
    let target = root.0.join("linked"); test_git(&source, &["worktree", "add", "-b", "feature", target.to_str().unwrap()]);
    let inspect = || inspect_worktree_removal(&settings, target.to_str().unwrap(), "local");
    let details = inspect().unwrap();
    assert_eq!(details.path, target.canonicalize().unwrap().to_string_lossy());
    assert_eq!(details.source, source.canonicalize().unwrap().to_string_lossy()); assert_eq!(details.branch.as_deref(), Some("feature"));
    fs::write(target.join("unsaved"), "keep me").unwrap();
    assert!(inspect().err().unwrap().contains("uncommitted or untracked changes"));
    assert_eq!(fs::read_to_string(target.join("unsaved")).unwrap(), "keep me");
    fs::remove_file(target.join("unsaved")).unwrap();
    test_git(&source, &["worktree", "lock", "--reason", "Important work", target.to_str().unwrap()]);
    assert!(inspect().err().unwrap().contains("Worktree is locked: Important work"));
    test_git(&source, &["worktree", "unlock", target.to_str().unwrap()]);
    test_git(&target, &["checkout", "--detach"]);
    assert!(inspect().unwrap().branch.is_none());
}

#[test]
fn canonical_worktree_roots_preserve_input_order_across_batches_and_missing_paths() {
    let root = TestDirectory::new(); let source = root.0.join("repo"); fs::create_dir(&source).unwrap();
    test_git(&source, &["init", "--initial-branch=main"]);
    let nested = source.join("nested"); fs::create_dir(&nested).unwrap();
    let settings = default_settings();
    let mut paths = vec![nested.to_string_lossy().into_owned(); 129];
    paths.insert(1, root.0.join("missing").to_string_lossy().into_owned());
    paths.push(root.0.to_string_lossy().into_owned());
    let resolved = canonical_worktree_roots(&settings, "local", &paths).unwrap();
    assert_eq!(resolved.len(), paths.len());
    let expected = source.canonicalize().unwrap().to_string_lossy().into_owned();
    for (index, value) in resolved.iter().enumerate() {
        if index == 1 || index == paths.len() - 1 { assert_eq!(value, &None); }
        else { assert_eq!(value.as_deref(), Some(expected.as_str())); }
    }
    assert!(canonical_worktree_roots(&settings, "local", &[]).unwrap().is_empty());
}

fn test_tcp_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (server, _) = listener.accept().unwrap();
    for stream in [&client, &server] {
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
    }
    (client, server)
}

#[test]
fn broker_header_reader_enforces_a_cumulative_byte_budget() {
    let (mut client, server) = test_tcp_pair();
    client.write_all(b"GET / HTTP/1.1\r\nX: yes\r\n\r\nbody").unwrap();
    let mut reader = BufReader::new(server); let mut remaining = b"GET / HTTP/1.1\r\nX: yes\r\n\r\n".len();
    assert_eq!(read_broker_line(&mut reader, &mut remaining).unwrap(), "GET / HTTP/1.1\r\n");
    assert_eq!(read_broker_line(&mut reader, &mut remaining).unwrap(), "X: yes\r\n");
    assert_eq!(read_broker_line(&mut reader, &mut remaining).unwrap(), "\r\n");
    assert_eq!(remaining, 0);
    assert_eq!(read_broker_line(&mut reader, &mut remaining).unwrap_err(), "Request headers are too large");
    let mut body = [0; 4]; reader.read_exact(&mut body).unwrap(); assert_eq!(&body, b"body");
}

#[test]
fn broker_header_reader_rejects_oversized_and_invalid_utf8_lines() {
    for (bytes, budget, expected) in [(b"long header\n".as_slice(), 4, Some("Request headers are too large")), (b"\xff\n".as_slice(), 4, None)] {
        let (mut client, server) = test_tcp_pair(); client.write_all(bytes).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut remaining = budget;
        let error = read_broker_line(&mut BufReader::new(server), &mut remaining).unwrap_err();
        if let Some(expected) = expected { assert_eq!(error, expected); }
        assert_eq!(remaining, budget, "rejected lines do not consume a successful header budget");
    }
    let (client, server) = test_tcp_pair(); client.shutdown(std::net::Shutdown::Write).unwrap();
    let mut remaining = 10;
    assert_eq!(read_broker_line(&mut BufReader::new(server), &mut remaining).unwrap(), ""); assert_eq!(remaining, 10);
}

#[test]
fn broker_responses_frame_json_with_its_utf8_byte_length() {
    let (mut client, server) = test_tcp_pair(); let body = json!({"message":"café 🦆","ok":true});
    broker_response(server, "200 OK", body.clone());
    let mut response = String::new(); client.read_to_string(&mut response).unwrap();
    let (headers, payload) = response.split_once("\r\n\r\n").unwrap();
    assert!(headers.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(headers.contains("Content-Type: application/json")); assert!(headers.contains("Connection: close"));
    assert!(headers.contains(&format!("Content-Length: {}", payload.len())));
    assert_eq!(serde_json::from_str::<Value>(payload).unwrap(), body);
}

pub(super) fn test_session(host: &str, id: &str, path: &str) -> SessionSummary {
    SessionSummary {
        id: id.into(), group_id: None, subagent_parent_id: None, path: path.into(), name: "Conversation".into(),
        project: "Project".into(), cwd: "/project".into(), cwd_exists: true,
        project_kind: None, project_root: None, branch: None, modified_at: 0, preview: String::new(),
        message_count: 0, last_message_at: 0, api_cost: 0.0, host_id: host.into(), host_name: host.into(),
    }
}

#[test]
fn agent_lookup_requires_both_host_and_session_identity() {
    let sessions = vec![test_session("remote", "shared", "/remote.jsonl"), test_session("local", "shared", "/local.jsonl"), test_session("local", "other", "/other.jsonl")];
    assert_eq!(resolve_agent(&sessions, "local", "shared").unwrap().path, "/local.jsonl");
    assert_eq!(resolve_agent(&sessions, "remote", "shared").unwrap().path, "/remote.jsonl");
    assert_eq!(resolve_agent(&sessions, "local", "other").unwrap().path, "/other.jsonl");
    for (host, id) in [("unknown", "shared"), ("remote", "other"), ("local", "missing")] {
        assert_eq!(resolve_agent(&sessions, host, id).unwrap_err(), format!("Agent {host}/{id} was not found"));
    }
    assert!(resolve_agent(&[], "local", "shared").is_err());
}

#[test]
fn active_agent_matching_accepts_id_or_path_but_excludes_other_hosts_and_messageable_agents() {
    let session = test_session("local", "chat", "/chat.jsonl");
    for (host, id, path, messageable, expected) in [
        ("local", Some("chat"), None, false, true),
        ("local", None, Some("/chat.jsonl"), false, true),
        ("local", Some("other"), Some("/chat.jsonl"), false, true),
        ("remote", Some("chat"), Some("/chat.jsonl"), false, false),
        ("local", Some("chat"), Some("/chat.jsonl"), true, false),
        ("local", Some("other"), Some("/other.jsonl"), false, false),
        ("local", None, None, false, false),
    ] {
        let agent = AgentAddress { host_id: host.into(), session_id: id.map(str::to_owned), session_path: path.map(str::to_owned), worktree: None, presence_id: None, working: false, messageable };
        assert_eq!(agent_is_active(&session, &agent), expected, "host={host} id={id:?} path={path:?} messageable={messageable}");
    }
}

#[test]
fn worktree_output_requires_complete_success_data_and_preserves_git_errors() {
    use std::os::unix::process::ExitStatusExt;
    let output = |code, stdout: &str, stderr: &str| LimitedOutput {
        status: ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec(),
    };
    let worktree = parse_worktree_output(output(0, "feature\n/project with spaces\n", "warning"), "Create worktree").unwrap();
    assert_eq!(worktree.branch, "feature"); assert_eq!(worktree.path, "/project with spaces");
    for stdout in ["", "feature\n", "\n/project\n", "feature\n\n"] {
        assert_eq!(parse_worktree_output(output(0, stdout, ""), "Create worktree").err().unwrap(), "Create worktree: Git returned an incomplete result");
    }
    assert_eq!(parse_worktree_output(output(1, "feature\n/project\n", "  branch already exists\n"), "Create worktree").err().unwrap(), "branch already exists");
    assert_eq!(parse_worktree_output(output(1, "", " \n"), "Create worktree").err().unwrap(), "Create worktree");
}

#[test]
fn saved_diff_schema_preserves_tool_path_mappings_and_rejects_incomplete_records() {
    let value = json!({"message":{"patch":"diff contents","repositoryRoot":"/repo","toolPaths":[{"toolCallId":"tool-1","path":"src/file.rs","absolutePath":"/repo/src/file.rs","canonicalPath":"/real/repo/src/file.rs"}]}});
    let snapshots: GitDiffSnapshots = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(snapshots).unwrap(), value);
    for invalid in [
        json!({"message":42}), json!({"message":{"patch":"diff"}}),
        json!({"message":{"patch":"diff","repositoryRoot":"/repo","toolPaths":[{"path":"file"}]}}),
        json!({"message":{"patch":"diff","repositoryRoot":"/repo","toolPaths":null}}),
    ] { assert!(serde_json::from_value::<GitDiffSnapshots>(invalid).is_err()); }
}

fn setup_script(name: &str, path: &Path, code: &str, cleanup: &str) -> WorktreeSetupScript {
    WorktreeSetupScript { id: name.into(), name: name.into(), script: code.into(), enabled: true, cleanup_script: Some(cleanup.into()), project_path: Some(path.to_string_lossy().into_owned()), host_id: None }
}
#[test]
#[cfg(unix)]
fn worktree_patch_is_private_and_never_overwrites_an_existing_file() {
    use std::os::unix::fs::PermissionsExt;
    let root = TestDirectory::new();
    let path = root.0.join("changes.patch");
    write_worktree_patch(&path, b"private changes").unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
    assert!(write_worktree_patch(&path, b"replacement").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"private changes");
}
