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
    let error = run_limited(Command::new("node").args(["-e", "process.stdout.write('12345')"]), 4, "Process capture").err().unwrap();
    assert!(error.starts_with("Process capture: output exceeded"));
    let output = run_limited(Command::new("node").args(["-e", "process.stderr.write('prefix'+ 'x'.repeat(200000));process.stdout.write('done')"]), 4, "large diagnostics").unwrap();
    assert!(output.status.success()); assert_eq!(output.stdout, b"done");
    assert_eq!(output.stderr.len(), 64 * 1024); assert!(output.stderr.starts_with(b"prefix"));
    let root = TestDirectory::new();
    let missing = run_limited(&mut Command::new(root.0.join("missing-executable")), 4, "Start helper").err().unwrap();
    assert!(missing.starts_with("Start helper:"));
}

#[test]
fn runtime_settings_include_only_enabled_named_tools_and_valid_skill_paths() {
    let mut settings = default_settings();
    settings.tools = vec![json!({"name":"read","enabled":true}), json!({"name":"bash","enabled":false}), json!({"name":"write"}), json!({"name":42,"enabled":true}), json!({"name":"edit","enabled":"true"})];
    settings.skills = vec![json!({"path":"/skills/active","enabled":true}), json!({"path":"/skills/off","enabled":false}), json!({"path":42,"enabled":true}), json!({"path":"/skills/unset"})];
    settings.context_window_cap = 12345; settings.context_window_cap_enabled = false;
    assert_eq!(runtime_settings(&settings), json!({
        "defaultModel":settings.default_model, "registeredTools":["read", "bash", "write", "edit"],
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
        modified_at: 0, preview: String::new(),
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
        let agent = AgentAddress { host_id: host.into(), session_id: id.map(str::to_owned), session_path: path.map(str::to_owned), working: false, messageable };
        assert_eq!(agent_is_active(&session, &agent), expected, "host={host} id={id:?} path={path:?} messageable={messageable}");
    }
}
