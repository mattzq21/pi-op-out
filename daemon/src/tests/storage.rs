#[test]
fn storage_inventory_query_counts_real_files_and_marks_malformed_archives_undeletable() {
    let home = TestDirectory::new(); let root = home.0.join(".piop");
    for directory in ["sessions", "archived", "tmp/chat"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    let active = "{\"type\":\"session\",\"id\":\"active\"}\n";
    fs::write(root.join("sessions/active.jsonl"), active).unwrap();
    fs::write(root.join("sessions/ignored.txt"), "not counted").unwrap();
    fs::write(root.join("archived/broken.jsonl"), "broken").unwrap();
    fs::write(root.join("tmp/chat/file"), "temporary").unwrap();
    let script = format!("require('node:os').homedir = () => {};\n{}", serde_json::to_string(home.0.to_str().unwrap()).unwrap(), include_str!("../../resources/storage-inventory.bundle.mjs"));
    let mut command = Command::new("node"); command.args(["-e", &script]);
    let report = query_storage_inventory(&mut command, None).unwrap();
    assert_eq!(report.host_id, "local"); assert!(report.error.is_none());
    let category = |id: &str| report.categories.iter().find(|category| category.id == id).unwrap();
    fn allocated_bytes(path: &Path) -> u64 {
        let metadata = fs::symlink_metadata(path).unwrap();
        #[cfg(unix)]
        let own = { use std::os::unix::fs::MetadataExt; metadata.blocks() * 512 };
        #[cfg(not(unix))]
        let own = metadata.len();
        own + if metadata.is_dir() { fs::read_dir(path).unwrap().map(|entry| allocated_bytes(&entry.unwrap().path())).sum::<u64>() } else { 0 }
    }
    assert_eq!(category("active-conversations").byte_size, allocated_bytes(&root.join("sessions")));
    assert_eq!(category("active-conversations").item_count, 1);
    assert_eq!(category("archived-conversations").byte_size, allocated_bytes(&root.join("archived")));
    assert_eq!(category("temporary-chats").byte_size, allocated_bytes(&root.join("tmp")));
    assert_eq!(category("temporary-chats").item_count, 1);
    assert!(category("project-checkpoints").estimated);
    assert_eq!(report.archives.len(), 1);
    assert_eq!(report.archives[0].id, "broken");
    assert!(!report.archives[0].deletable);
    assert!(report.archives[0].delete_error.as_deref().unwrap().contains("malformed"));
}

#[test]
fn storage_inventory_query_propagates_scanner_failure_and_invalid_response() {
    let host = RemoteHost { enabled: true, id:"remote".into(), name:"Server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
    for (script, expected) in [
        ("process.exitCode=3", "Could not inspect storage on Server"),
        ("process.stderr.write('disk failed');process.exitCode=4", "disk failed"),
        ("process.stdout.write('{}')", "Could not read storage inventory from Server:"),
    ] {
        let mut command = Command::new("node"); command.args(["-e", script]);
        let error = query_storage_inventory(&mut command, Some(&host)).unwrap_err();
        assert!(error.starts_with(expected), "{error}");
    }
}
#[cfg(unix)]
#[test]
fn storage_inventory_preserves_categories_archives_warnings_and_host_identity() {
    use std::os::unix::process::ExitStatusExt;
    let host = RemoteHost { enabled: true, id: "remote".into(), name: "Remote server".into(), target: "unused".into(), pi_path: "pi".into() };
    let value = json!({"categories":[{"id":"sessions","byteSize":123,"itemCount":2}],"archives":[{"id":"archived","path":"/archive.jsonl","name":"Old chat","cwd":"/repo","modifiedAt":100,"byteSize":42,"deletable":false,"deleteError":"In use"}],"warnings":["Partial scan"]});
    for remote in [None, Some(&host)] {
        let output = LimitedOutput { status: ExitStatus::from_raw(0), stdout: serde_json::to_vec(&value).unwrap(), stderr: vec![] };
        let report = parse_storage_inventory(output, remote).unwrap();
        assert_eq!(report.host_id, remote.map(|host| host.id.as_str()).unwrap_or("local"));
        assert_eq!(report.host_name, remote.map(|host| host.name.as_str()).unwrap_or("Local"));
        assert_eq!(report.categories[0].byte_size, 123); assert_eq!(report.categories[0].item_count, 2); assert!(!report.categories[0].estimated);
        assert_eq!(report.archives[0].delete_error.as_deref(), Some("In use")); assert!(!report.archives[0].deletable);
        assert_eq!(report.warnings, ["Partial scan"]); assert!(report.error.is_none());
    }
}

#[cfg(unix)]
#[test]
fn storage_inventory_failures_include_context_and_do_not_look_like_empty_successes() {
    use std::os::unix::process::ExitStatusExt;
    for (status, stdout, stderr, expected) in [
        (1, "{}", " denied \n", "denied"),
        (1, "{}", "", "Could not inspect storage on Local"),
        (0, "not json", "", "Could not read storage inventory from Local"),
        (0, "{}", "", "Could not read storage inventory from Local"),
    ] {
        let output = LimitedOutput { status: ExitStatus::from_raw(status << 8), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() };
        assert!(parse_storage_inventory(output, None).unwrap_err().starts_with(expected));
    }
    let failure = failed_storage("remote".into(), "Remote server".into(), "offline".into());
    assert_eq!(failure.host_id, "remote"); assert_eq!(failure.error.as_deref(), Some("offline"));
    assert!(failure.categories.is_empty()); assert!(failure.archives.is_empty()); assert!(failure.warnings.is_empty());
}
#[test]
fn session_summary_batches_preserve_metadata_and_host_identity() {
    let root = TestDirectory::new();
    let mut candidates = Vec::new();
    for number in 0..129 {
        let path = root.0.join(format!("chat {number}.jsonl"));
        let entries = [
            json!({"type":"session","id":format!("id-{number}"),"cwd":"/projects/example"}),
            json!({"type":"session_info","name":format!("Chat {number}")}),
            json!({"type":"message","message":{"role":"user","content":"Question"}}),
            json!({"type":"message","message":{"role":"assistant","content":"Answer 🦆","usage":{"cost":{"total":0.25}}}}),
        ];
        let body = entries.iter().map(|entry| format!("{entry}\n")).collect::<String>();
        fs::write(&path, &body).unwrap();
        candidates.push((path.to_string_lossy().into_owned(), format!("fingerprint-{number}"), 100 + number, body.len() as u64));
    }
    let summaries = read_session_summaries(&candidates, None).unwrap();
    assert_eq!(summaries.len(), 129, "include sessions on both sides of the 128-file batch boundary");
    for (number, (path, fingerprint, modified, _)) in candidates.iter().enumerate() {
        let cached = &summaries[path];
        assert_eq!(&cached.fingerprint, fingerprint);
        assert_eq!(cached.summary.id, format!("id-{number}"));
        assert_eq!(cached.summary.name, format!("Chat {number}"));
        assert_eq!(cached.summary.project, "example");
        assert_eq!(cached.summary.modified_at, *modified);
        assert_eq!(cached.summary.message_count, 2);
        assert_eq!(cached.summary.api_cost, 0.25);
        assert_eq!(cached.summary.preview, "Answer 🦆");
        assert_eq!(cached.summary.host_id, "local");
        assert_eq!(cached.summary.host_name, "Local");
    }
}

#[test]
fn session_summary_loading_skips_unreadable_and_invalid_files_without_losing_valid_sessions() {
    let root = TestDirectory::new();
    let mut candidates = Vec::new();
    for (name, body) in [
        ("empty", ""), ("broken", "not json\n"),
        ("wrong-header", "{\"type\":\"message\"}\n"),
        ("valid", "{\"type\":\"session\",\"id\":\"valid\",\"cwd\":\"/repo\"}\nmalformed line\n"),
    ] {
        let path = root.0.join(format!("{name}.jsonl")); fs::write(&path, body).unwrap();
        candidates.push((path.to_string_lossy().into_owned(), name.into(), 1, body.len() as u64));
    }
    candidates.push((root.0.join("missing.jsonl").to_string_lossy().into_owned(), "missing".into(), 1, 0));
    let summaries = read_session_summaries(&candidates, None).unwrap();
    assert_eq!(summaries.len(), 1);
    let summary = &summaries[&candidates[3].0].summary;
    assert_eq!(summary.id, "valid"); assert_eq!(summary.name, "Untitled session");
    assert_eq!(summary.message_count, 0); assert_eq!(summary.api_cost, 0.0);
    assert!(read_session_summaries(&[], None).unwrap().is_empty());
}

#[test]
fn session_deletion_removes_trace_in_both_storage_areas() {
    let home = TestDirectory::new(); let runtime = PiRuntime::default();
    for archived in [false, true] {
        let root = home.0.join(if archived { ".piop/archived" } else { ".piop/sessions" }); fs::create_dir_all(&root).unwrap();
        let path = root.join("conversation.jsonl");
        fs::write(&path, json!({"type":"session","id":"one","cwd":home.0.join("missing-project")}).to_string()).unwrap();
        let other = root.join("other.jsonl"); fs::write(&other, "keep").unwrap();
        delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, archived).unwrap();
        assert_eq!(fs::read_to_string(&other).unwrap(), "keep");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }
}

#[test]
fn session_deletion_checks_active_path_and_identity_and_preserves_invalid_traces() {
    let home = TestDirectory::new(); let root = home.0.join(".piop/sessions"); fs::create_dir_all(&root).unwrap();
    let path = root.join("conversation.jsonl");
    let content = json!({"type":"session","id":"one","cwd":home.0.join("missing-project")}).to_string(); fs::write(&path, &content).unwrap();
    let runtime = PiRuntime::default();
    for use_path in [true, false] {
        runtime.active_agents.lock().unwrap().insert("active".into(), AgentAddress {
            host_id: "local".into(), session_id: Some(if use_path { "different" } else { "one" }.into()),
            session_path: use_path.then(|| path.to_string_lossy().into_owned()), worktree: None, working: false, messageable: false,
        });
        let expected_error = if use_path { "Close the session before deleting it" } else { "Deletion failed: Close the session before deleting it\nDeletion was rolled back." };
        assert_eq!(delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, false).unwrap_err(), expected_error);
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }
    runtime.active_agents.lock().unwrap().get_mut("active").unwrap().host_id = "remote".into();
    fs::write(&path, "invalid json").unwrap();
    assert!(delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, false).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "invalid json");
    fs::write(&path, &content).unwrap();
    delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, false).unwrap();
    assert!(!path.exists());
}

#[test]
fn session_deletion_only_blocks_owned_matching_sessions_on_the_same_host() {
    let blocks_deletion = |messageable: bool, same_host: bool, same_path: bool, same_id: bool| !messageable && same_host && (same_path || same_id);
    let home = TestDirectory::new(); let root = home.0.join("sessions"); fs::create_dir(&root).unwrap();
    let path = root.join("conversation.jsonl");
    let content = json!({"type":"session","id":"one","cwd":home.0.join("missing-project")}).to_string();
    for messageable in [false, true] { for same_host in [false, true] { for same_path in [false, true] { for same_id in [false, true] {
        fs::write(&path, &content).unwrap();
        let runtime = PiRuntime::default();
        runtime.active_agents.lock().unwrap().insert("active".into(), AgentAddress {
            host_id: if same_host { "local" } else { "remote" }.into(),
            session_id: Some(if same_id { "one" } else { "other" }.into()),
            session_path: Some(if same_path { path.clone() } else { root.join("other.jsonl") }.to_string_lossy().into_owned()),
            worktree: None, working: false, messageable,
        });
        let result = delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, false);
        let blocked = blocks_deletion(messageable, same_host, same_path, same_id);
        assert_eq!(result.is_err(), blocked, "viewer={messageable}, same host={same_host}, same path={same_path}, same id={same_id}: {result:?}");
        if blocked {
            let expected_error = if same_path { "Close the session before deleting it" } else { "Deletion failed: Close the session before deleting it\nDeletion was rolled back." };
            assert_eq!(result.unwrap_err(), expected_error);
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        } else { assert!(!path.exists()); }
    } } } }
}

#[test]
fn session_deletion_tolerates_login_output_but_bounds_it_and_preserves_errors() {
    let command = |script: &str| { let mut command = Command::new("node"); command.args(["-e", script]); command };
    run_session_deletion(&mut command("process.stdout.write('Login banner\\n'.repeat(400))")).unwrap();
    assert_eq!(run_session_deletion(&mut command("process.stdout.write('Login banner\\n'.repeat(400));process.stderr.write(' permission denied \\n');process.exitCode=1")).unwrap_err(), "permission denied");
    assert_eq!(run_session_deletion(&mut command("process.exitCode=1")).unwrap_err(), "Could not delete session");
    assert!(run_session_deletion(&mut command("process.stdout.write('x'.repeat(1024 * 1024))")).unwrap_err().starts_with("Could not delete session: output exceeded"));
}

#[test]
fn rpc_responses_skip_notifications_and_other_ids_and_surface_errors() {
    let (sender, receiver) = mpsc::channel();
    for line in ["not json", "{\"method\":\"notification\"}", "{\"id\":2,\"result\":false}", "{\"id\":1,\"result\":{\"ok\":true}}"] {
        sender.send(line.into()).unwrap();
    }
    assert_eq!(codex_response(&receiver, 1, Instant::now() + Duration::from_secs(1)).unwrap(), json!({"ok":true}));
    sender.send("{\"id\":1,\"error\":\"denied\"}".into()).unwrap();
    assert!(codex_response(&receiver, 1, Instant::now() + Duration::from_secs(1)).unwrap_err().contains("denied"));
    sender.send("{\"id\":1}".into()).unwrap();
    assert_eq!(codex_response(&receiver, 1, Instant::now() + Duration::from_secs(1)).unwrap_err(), "Codex returned no usage data");
    assert_eq!(codex_response(&receiver, 1, Instant::now()).unwrap_err(), "Codex usage request timed out");
    drop(sender);
    assert_eq!(codex_response(&receiver, 1, Instant::now() + Duration::from_secs(1)).unwrap_err(), "Codex usage request timed out");
}
