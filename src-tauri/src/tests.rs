use super::*;

#[test]
fn shell_quoting_preserves_empty_strings_quotes_and_shell_metacharacters() {
    assert_eq!(shell_quote(""), "''");
    assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    assert_eq!(shell_quote("$(echo secret); `id`\nnext"), "'$(echo secret); `id`\nnext'");
}

#[test]
fn remote_hosts_accept_plain_connection_details_and_reject_shell_syntax() {
    let mut host = RemoteHost { id: "remote".into(), name: "Server".into(), target: "user@example.com".into(), pi_path: "pi".into() };
    for target in ["example.com", "user@server-1", "user@[2001:db8::1]", "local_alias"] {
        host.target = target.into();
        for executable in ["pi", "~/bin/pi", "/opt/pi/bin/pi", "./node_modules/.bin/pi"] {
            host.pi_path = executable.into(); assert!(validate_remote_host(&host).is_ok());
        }
    }
    host.pi_path = "pi".into();
    for target in ["", "host name", "host;id", "$(id)", "host\nother", "host'", "hébergeur"] {
        host.target = target.into();
        assert!(validate_remote_host(&host).unwrap_err().contains("SSH target"), "{target}");
    }
    host.target = "user@example.com".into();
    for executable in ["", "pi --flag", "/path with spaces/pi", "pi;id", "$(id)", "pi\nother", "pi'"] {
        host.pi_path = executable.into();
        assert!(validate_remote_host(&host).unwrap_err().contains("Pi executable"), "{executable}");
    }
    let mut settings = default_settings(); settings.hosts.push(host);
    assert!(remote_host(&settings, "remote").is_err(), "lookup must validate stored hosts");
    settings.hosts[0].pi_path = "pi".into();
    assert_eq!(remote_host(&settings, "remote").unwrap().target, "user@example.com");
    assert_eq!(remote_host(&settings, "missing").unwrap_err(), "Unknown machine: missing");
}

#[test]
fn remote_paths_distinguish_home_expansion_from_literal_directory_names() {
    for path in [None, Some(""), Some("  "), Some(" ~ ")] {
        assert_eq!(remote_directory_path(path), "\"$HOME\"");
    }
    assert_eq!(remote_directory_path(Some(" ~/project name ")), "$HOME/'project name'");
    assert_eq!(remote_directory_path(Some("/project's files")), "'/project'\\''s files'");
    assert_eq!(remote_directory_path(Some("$(id);`whoami`")), "'$(id);`whoami`'");
    assert_eq!(remote_directory_path(Some("~another/project")), "'~another/project'");
    assert_eq!(remote_pi_path("pi"), "\"$(bash -lc 'command -v pi')\"");
    assert_eq!(remote_pi_path("~/bin/pi"), "$HOME/bin/pi");
    assert_eq!(remote_pi_path("/opt/pi"), "'/opt/pi'");
    assert_eq!(remote_login_command("printf '%s' value"), "bash -lc 'printf '\\''%s'\\'' value'");
}

#[test]
fn terminal_decoding_preserves_unicode_at_every_chunk_boundary() {
    let text = "ASCII\r\n café 日本語 🦆\u{1b}[32mgreen\u{1b}[0m";
    for split in 0..=text.len() {
        let mut pending = Vec::new();
        let mut output = decode_terminal_bytes(&mut pending, &text.as_bytes()[..split], false);
        output.push_str(&decode_terminal_bytes(&mut pending, &text.as_bytes()[split..], true));
        assert_eq!(output, text, "split at byte {split}");
        assert!(pending.is_empty());
    }
    let mut pending = Vec::new();
    let mut output = String::new();
    for byte in text.bytes() { output.push_str(&decode_terminal_bytes(&mut pending, &[byte], false)); }
    output.push_str(&decode_terminal_bytes(&mut pending, &[], true));
    assert_eq!(output, text);
    assert!(pending.is_empty());
}

#[test]
fn terminal_decoding_replaces_invalid_bytes_and_flushes_incomplete_eof() {
    let mut pending = Vec::new();
    assert_eq!(decode_terminal_bytes(&mut pending, b"ok\xff\xfeafter\xe2\x82", false), "ok��after");
    assert_eq!(pending, [0xe2, 0x82]);
    assert_eq!(decode_terminal_bytes(&mut pending, &[], true), "�");
    assert!(pending.is_empty());
    assert_eq!(decode_terminal_bytes(&mut pending, b"next", true), "next");
    assert_eq!(decode_terminal_bytes(&mut pending, b"\xe2", false), "");
    assert_eq!(decode_terminal_bytes(&mut pending, b"X", false), "�X");
    assert!(pending.is_empty());
}

#[test]
fn usage_chooses_the_most_consumed_window_and_prefers_the_codex_bucket() {
    let response = json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":12,"resetsAt":100},"secondary":{"usedPercent":80.4,"resetsAt":200}}},"rateLimits":{"primary":{"usedPercent":99}}});
    let usage = codex_usage_values(&response).unwrap();
    assert_eq!(usage.remaining_percent, 20);
    assert_eq!(usage.reset_at, Some(200));
    for (used, expected) in [(-2, 100), (150, 0), (0, 100)] {
        let usage = codex_usage_values(&json!({"rateLimits":{"primary":{"usedPercent":used}}})).unwrap();
        assert_eq!(usage.remaining_percent, expected);
        assert_eq!(usage.reset_at, None);
    }
    for value in [json!(null), json!({}), json!({"rateLimits":{}}), json!({"rateLimits":{"primary":{"usedPercent":"bad"}}})] {
        assert!(codex_usage_values(&value).is_none());
    }
}
#[test]
fn remote_session_metadata_preserves_paths_and_subsecond_cache_fingerprints() {
    let records = [
        ("/sessions/a b's\n日本語.jsonl", "1750000000.123456789", "42"),
        ("/sessions/second.jsonl", "1750000000.987654321", "0"),
        ("/sessions/large.jsonl", "1750000001", "18446744073709551615"),
    ];
    let bytes = records.iter().map(|(path, modified, size)| format!("{path}\0{modified}\0{size}\0")).collect::<String>();
    let parsed = parse_remote_session_metadata(bytes.as_bytes());
    assert_eq!(parsed, vec![
        (records[0].0.into(), "1750000000.123456789:42".into(), 1750000000, 42),
        (records[1].0.into(), "1750000000.987654321:0".into(), 1750000000, 0),
        (records[2].0.into(), "1750000001:18446744073709551615".into(), 1750000001, u64::MAX),
    ]);
    assert_ne!(parsed[0].1, parsed[1].1, "subsecond updates must invalidate cached summaries");
}

#[test]
fn remote_session_metadata_skips_bad_records_without_losing_later_valid_records() {
    let mut input = Vec::new();
    for (modified, size) in [("bad", "1"), ("1.0", "bad"), ("-1", "2"), ("1", "18446744073709551616")] {
        input.extend_from_slice(format!("/bad.jsonl\0{modified}\0{size}\0").as_bytes());
    }
    input.extend_from_slice(b"/valid.jsonl\0\x31.25\0\x32\0/incomplete\0timestamp");
    assert_eq!(parse_remote_session_metadata(&input), vec![("/valid.jsonl".into(), "1.25:2".into(), 1, 2)]);
    for bytes in [b"".as_slice(), b"path", b"path\0timestamp"] { assert!(parse_remote_session_metadata(bytes).is_empty()); }
}
#[test]
fn remote_session_index_reuses_unchanged_entries_refreshes_changed_files_and_prunes_deleted_files() {
    let index = SessionIndexRuntime::default();
    let host = RemoteHost { id:"remote".into(), name:"Renamed server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
    let old = |path: &str| CachedSession { fingerprint:"1.0:10".into(), summary:test_session("remote", path, path) };
    index.remote.lock().unwrap().insert("remote".into(), HashMap::from([
        ("/same".into(), old("/same")), ("/changed".into(), old("/changed")), ("/deleted".into(), old("/deleted")),
    ]));
    index.remote.lock().unwrap().insert("other".into(), HashMap::from([("/other".into(), old("/other"))]));
    let metadata = b"/same\x001.0\x0010\x00/changed\x002.0\x0020\x00/new\x003.0\x0030\x00/invalid\x004.0\x0040\x00";
    let sessions = update_remote_session_index(&index, &host, metadata, |changed| {
        assert_eq!(changed.iter().map(|entry| entry.0.as_str()).collect::<Vec<_>>(), vec!["/changed", "/new", "/invalid"]);
        Ok(changed.iter().filter(|entry| entry.0 != "/invalid").map(|(path, fingerprint, modified, _)| {
            let mut summary = test_session("remote", path, path); summary.modified_at = *modified;
            (path.clone(), CachedSession { fingerprint:fingerprint.clone(), summary })
        }).collect())
    }, |sessions| {
        assert_eq!(sessions.len(), 3);
        for session in sessions { session.cwd_exists = false; }
        Ok(())
    }).unwrap();
    assert_eq!(sessions.iter().map(|session| session.path.as_str()).collect::<Vec<_>>(), vec!["/same", "/changed", "/new"]);
    assert!(sessions.iter().all(|session| session.host_name == "Renamed server" && !session.cwd_exists));
    let cache = index.remote.lock().unwrap();
    assert_eq!(cache["remote"].len(), 3);
    assert_eq!(cache["remote"]["/changed"].fingerprint, "2.0:20");
    assert_eq!(cache["remote"]["/new"].summary.modified_at, 3);
    assert!(cache["other"].contains_key("/other"));
}

#[test]
fn remote_session_index_preserves_previous_cache_when_reading_or_inspection_fails() {
    for failure in ["read", "inspect"] {
        let index = SessionIndexRuntime::default();
        let host = RemoteHost { id:"remote".into(), name:"Server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
        index.remote.lock().unwrap().insert("remote".into(), HashMap::from([("/old".into(), CachedSession {
            fingerprint:"1:10".into(), summary:test_session("remote", "old", "/old"),
        })]));
        let result = update_remote_session_index(&index, &host, b"/new\x002\x0020\x00", |_| {
            if failure == "read" { Err("read failed".into()) } else { Ok(HashMap::new()) }
        }, |_| {
            assert_eq!(failure, "inspect");
            Err("inspect failed".into())
        });
        assert_eq!(result.err().unwrap(), format!("{failure} failed"));
        let cache = index.remote.lock().unwrap();
        assert_eq!(cache["remote"].len(), 1);
        assert_eq!(cache["remote"]["/old"].fingerprint, "1:10");
    }
}
#[cfg(unix)]
#[test]
fn terminal_lifecycle_delivers_queued_input_and_resized_dimensions_to_the_shell() {
    let runtime = TestTerminals(TerminalRuntime::default());
    let (sender, events) = mpsc::channel();
    start_terminal_with(&runtime.0, "interactive".into(), "session".into(), "/tmp".into(), 0, 0, "local".into(), "window".into(),
        || {
            let mut command = CommandBuilder::new("sh");
            command.args(["-c", "stty -echo; printf 'READY'; IFS= read -r line; printf 'received:%s\\n' \"$line\"; stty size"]);
            Ok(command)
        }, move |packet| { let _ = sender.send(packet); }).unwrap();
    let mut output = String::new();
    while !output.contains("READY") {
        let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(packet["type"], "terminal_output");
        output.push_str(packet["data"].as_str().unwrap());
    }
    {
        let processes = runtime.0.processes.lock().unwrap();
        let process = &processes["interactive"];
        let size = process.master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (1, 1));
        assert_eq!(process.window_label, "window"); assert_eq!(process.session_key, "session");
    }
    resize_terminal_pty(&runtime.0, "interactive", 100, 40).unwrap();
    write_terminal_input(&runtime.0, "interactive", "hello λ\n".into()).unwrap();
    loop {
        let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
        if packet["type"] == "terminal_exit" { break; }
        output.push_str(packet["data"].as_str().unwrap());
    }
    assert!(output.contains("received:hello λ"), "{output}");
    assert!(output.contains("40 100"), "{output}");
    assert!(runtime.0.processes.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn stopping_a_started_terminal_emits_exit_and_preserves_other_processes() {
    let runtime = TestTerminals(TerminalRuntime::default());
    let _other_input = runtime.add("other");
    let (sender, events) = mpsc::channel();
    start_terminal_with(&runtime.0, "stop-me".into(), "another-session".into(), "/tmp".into(), 80, 24, "local".into(), "window".into(),
        || { let mut command = CommandBuilder::new("sh"); command.args(["-c", "printf READY; exec sleep 60"]); Ok(command) },
        move |packet| { let _ = sender.send(packet); }).unwrap();
    let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(packet["type"], "terminal_output");
    stop_terminals(&runtime.0, &["stop-me".into()]).unwrap();
    loop {
        let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
        if packet["type"] == "terminal_exit" { assert_eq!(packet["terminalId"], "stop-me"); break; }
    }
    let processes = runtime.0.processes.lock().unwrap();
    assert_eq!(processes.len(), 1); assert!(processes.contains_key("other"));
}

#[cfg(unix)]
#[test]
fn terminal_startup_streams_shell_output_and_removes_finished_process() {
    let runtime = TestTerminals(TerminalRuntime::default());
    let (sender, events) = mpsc::channel();
    start_terminal_with(&runtime.0, "terminal".into(), "session".into(), "/tmp".into(), 0, 0, "local".into(), "window".into(),
        || { let mut command = CommandBuilder::new("sh"); command.args(["-c", "printf 'hello λ'; exit 0"]); Ok(command) },
        move |packet| { let _ = sender.send(packet); }).unwrap();
    let mut output = String::new();
    loop {
        let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(packet["terminalId"], "terminal");
        if packet["type"] == "terminal_exit" { break; }
        assert_eq!(packet["type"], "terminal_output");
        output.push_str(packet["data"].as_str().unwrap());
    }
    assert_eq!(output, "hello λ");
    assert!(runtime.0.processes.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn terminal_startup_rejects_limits_and_launch_failures_without_registering_new_processes() {
    let runtime = TestTerminals(TerminalRuntime::default());
    for id in 0..MAX_TERMINALS { runtime.add(&format!("terminal-{id}")); }
    start_terminal_with(&runtime.0, "terminal-0".into(), "session".into(), "/tmp".into(), 80, 24, "local".into(), "main".into(),
        || panic!("duplicate must not launch"), |_| panic!("duplicate emitted")).unwrap();
    let error = start_terminal_with(&runtime.0, "extra".into(), "session".into(), "/tmp".into(), 80, 24, "local".into(), "window".into(),
        || panic!("limit must prevent launch"), |_| panic!("limit emitted")).unwrap_err();
    assert!(error.contains("At most"));
    for failure in ["build", "spawn"] {
        let temporary = TestDirectory::new();
        let error = start_terminal_with(&runtime.0, "other".into(), "other-session".into(), "/tmp".into(), 80, 24, "local".into(), "window".into(),
            || if failure == "build" { Err("invalid directory".into()) } else { Ok(CommandBuilder::new(temporary.0.join("missing"))) },
            |_| panic!("failed launch emitted")).unwrap_err();
        assert!(error.contains(if failure == "build" { "invalid directory" } else { "Could not start terminal shell" }));
        assert!(!runtime.0.processes.lock().unwrap().contains_key("other"));
    }
    assert_eq!(runtime.0.processes.lock().unwrap().len(), MAX_TERMINALS);
}
#[cfg(unix)]
struct TestTerminals(TerminalRuntime);

#[cfg(unix)]
impl TestTerminals {
    fn add(&self, id: &str) -> mpsc::Receiver<String> {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("sh");
        command.args(["-c", "exec sleep 60"]);
        let child = pair.slave.spawn_command(command).unwrap();
        let (writer, receiver) = mpsc::sync_channel(1);
        self.0.processes.lock().unwrap().insert(id.into(), TerminalProcess {
            session_key: "session".into(), cwd: "/tmp".into(), host_id: "local".into(), window_label: "main".into(),
            master: pair.master, child, writer,
        });
        receiver
    }
}

#[cfg(unix)]
impl Drop for TestTerminals {
    fn drop(&mut self) {
        let ids = self.0.processes.lock().unwrap().keys().cloned().collect::<Vec<_>>();
        let _ = stop_terminals(&self.0, &ids);
    }
}
#[cfg(unix)]
#[test]
fn terminal_input_enforces_byte_limits_and_reports_full_or_closed_queues() {
    let terminals = TestTerminals(TerminalRuntime::default());
    let receiver = terminals.add("one");
    let data = "🌍".repeat(256 * 1024);
    write_terminal_input(&terminals.0, "one", data.clone()).unwrap();
    assert!(write_terminal_input(&terminals.0, "one", "next".into()).unwrap_err().contains("Terminal input is busy"));
    assert_eq!(receiver.recv_timeout(Duration::from_secs(2)).unwrap(), data);
    assert!(write_terminal_input(&terminals.0, "one", format!("{data}x")).unwrap_err().contains("exceeds 1 MiB"));
    assert!(receiver.try_recv().is_err());
    write_terminal_input(&terminals.0, "one", "line\n\u{3}".into()).unwrap();
    assert_eq!(receiver.recv_timeout(Duration::from_secs(2)).unwrap(), "line\n\u{3}");
    drop(receiver);
    assert!(write_terminal_input(&terminals.0, "one", "next".into()).unwrap_err().contains("Terminal input is busy"));
    assert_eq!(write_terminal_input(&terminals.0, "missing", "text".into()).unwrap_err(), "Terminal is not running");
}

#[cfg(unix)]
#[test]
fn terminal_resize_clamps_dimensions_and_cleanup_targets_only_requested_processes() {
    let terminals = TestTerminals(TerminalRuntime::default());
    let first = terminals.add("first");
    let second = terminals.add("second");
    for (cols, rows, expected_cols, expected_rows) in [(0, 0, 1, 1), (132, 43, 132, 43)] {
        resize_terminal_pty(&terminals.0, "first", cols, rows).unwrap();
        let processes = terminals.0.processes.lock().unwrap();
        let size = processes["first"].master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (expected_cols, expected_rows));
        assert_eq!(processes["second"].master.get_size().unwrap().cols, 80);
    }
    assert_eq!(resize_terminal_pty(&terminals.0, "missing", 80, 24).unwrap_err(), "Terminal is not running");
    stop_terminals(&terminals.0, &["missing".into(), "first".into(), "first".into()]).unwrap();
    assert!(matches!(first.try_recv(), Err(mpsc::TryRecvError::Disconnected)));
    assert_eq!(terminals.0.processes.lock().unwrap().len(), 1);
    write_terminal_input(&terminals.0, "second", "still available".into()).unwrap();
    assert_eq!(second.recv_timeout(Duration::from_secs(2)).unwrap(), "still available");
    stop_terminals(&terminals.0, &["second".into()]).unwrap();
    assert!(terminals.0.processes.lock().unwrap().is_empty());
}
#[test]
fn terminal_output_stream_preserves_split_unicode_and_flushes_incomplete_bytes_on_eof_or_error() {
    struct Chunks { chunks: std::collections::VecDeque<Vec<u8>>, fail: bool }
    impl Read for Chunks {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if let Some(chunk) = self.chunks.pop_front() {
                buffer[..chunk.len()].copy_from_slice(&chunk); return Ok(chunk.len());
            }
            if self.fail { Err(std::io::Error::other("terminal closed")) } else { Ok(0) }
        }
    }
    for fail in [false, true] {
        let mut reader = Chunks { chunks: vec![b"hello ".to_vec(), vec![0xf0], vec![0x9f, 0x98], vec![0x80, b'!'], vec![0xe2, 0x82]].into(), fail };
        let mut packets = Vec::new();
        stream_terminal_output(&mut reader, "terminal", |packet| packets.push(packet));
        assert_eq!(packets, vec![
            json!({"type":"terminal_output","terminalId":"terminal","data":"hello "}),
            json!({"type":"terminal_output","terminalId":"terminal","data":"😀!"}),
            json!({"type":"terminal_output","terminalId":"terminal","data":"�"}),
        ]);
    }
    let mut empty = std::io::Cursor::new(Vec::<u8>::new());
    stream_terminal_output(&mut empty, "empty", |_| panic!("empty terminal emitted output"));
}

#[test]
fn terminal_output_stream_preserves_large_output_across_read_buffer_boundaries() {
    let text = "line λ 😀\r\n".repeat(3000);
    let mut reader = std::io::Cursor::new(text.as_bytes());
    let mut output = String::new(); let mut packets = 0;
    stream_terminal_output(&mut reader, "large", |packet| {
        assert_eq!(packet["terminalId"], "large"); assert_eq!(packet["type"], "terminal_output");
        output.push_str(packet["data"].as_str().unwrap()); packets += 1;
    });
    assert_eq!(output, text);
    assert!(packets > 1);
}
#[test]
fn terminal_input_queue_handles_short_writes_and_flushes_each_message_in_order() {
    #[derive(Default)]
    struct ShortWriter { bytes: Vec<u8>, flushes: Vec<Vec<u8>> }
    impl Write for ShortWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let length = bytes.len().min(2); self.bytes.extend_from_slice(&bytes[..length]); Ok(length)
        }
        fn flush(&mut self) -> std::io::Result<()> { self.flushes.push(self.bytes.clone()); Ok(()) }
    }
    let (sender, receiver) = mpsc::channel();
    for message in ["hello λ", "\n", "", "exit\r"] { sender.send(message.into()).unwrap(); }
    drop(sender);
    let mut writer = ShortWriter::default();
    write_terminal_queue(&mut writer, receiver);
    assert_eq!(writer.bytes, "hello λ\nexit\r".as_bytes());
    assert_eq!(writer.flushes, vec![
        "hello λ".as_bytes().to_vec(), "hello λ\n".as_bytes().to_vec(),
        "hello λ\n".as_bytes().to_vec(), "hello λ\nexit\r".as_bytes().to_vec(),
    ]);
}

#[test]
fn terminal_input_queue_stops_on_write_or_flush_failure_and_closes_the_receiver() {
    struct FailingWriter { fail_flush: bool, writes: usize, flushes: usize }
    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            if self.fail_flush { Ok(bytes.len()) } else { Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed")) }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1; Err(std::io::Error::other("flush failed"))
        }
    }
    for fail_flush in [false, true] {
        let (sender, receiver) = mpsc::channel();
        sender.send("first".into()).unwrap(); sender.send("must not write".into()).unwrap();
        let mut writer = FailingWriter { fail_flush, writes:0, flushes:0 };
        write_terminal_queue(&mut writer, receiver);
        assert_eq!(writer.writes, 1);
        assert_eq!(writer.flushes, usize::from(fail_flush));
        assert!(sender.send("later".into()).is_err());
    }
}

#[test]
fn git_branch_reporting_handles_unborn_detached_and_linked_worktrees() {
    let temporary = TestDirectory::new();
    let repository = temporary.0.join("project's files");
    fs::create_dir(&repository).unwrap();
    assert_eq!(git_branch_at(repository.to_str().unwrap(), None).unwrap(), None);
    assert_eq!(git_branch_at(repository.join("missing").to_str().unwrap(), None).unwrap(), None);
    test_git(&repository, &["init", "--initial-branch=main"]);
    assert_eq!(git_branch_at(repository.to_str().unwrap(), None).unwrap(), None);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    assert_eq!(git_branch_at(repository.to_str().unwrap(), None).unwrap().as_deref(), Some("main"));
    let nested = repository.join("nested"); fs::create_dir(&nested).unwrap();
    assert_eq!(git_branch_at(nested.to_str().unwrap(), None).unwrap().as_deref(), Some("main"));
    let linked = temporary.0.join("linked");
    test_git(&repository, &["worktree", "add", "-b", "feature/topic", linked.to_str().unwrap()]);
    assert_eq!(git_branch_at(linked.to_str().unwrap(), None).unwrap().as_deref(), Some("feature/topic"));
    test_git(&linked, &["checkout", "--detach"]);
    assert_eq!(git_branch_at(linked.to_str().unwrap(), None).unwrap().as_deref(), Some("HEAD"));
    assert_eq!(git_branch_at(repository.to_str().unwrap(), None).unwrap().as_deref(), Some("main"));
}

#[test]
fn hook_list_query_runs_the_bundled_scanner_and_preserves_hook_entry_paths() {
    let home = TestDirectory::new(); let hooks = home.0.join(".piop/hooks");
    let script = format!("require('node:os').homedir = () => {};\n{}", serde_json::to_string(home.0.to_str().unwrap()).unwrap(), include_str!("../resources/list-hooks.cjs"));
    let run = || { let mut command = Command::new("node"); command.args(["-e", &script]); query_hook_list(&mut command) };
    assert_eq!(run().unwrap(), json!({"directory":hooks,"exists":false,"hooks":[]}));
    fs::create_dir_all(hooks.join("bundle")).unwrap();
    for name in ["z.ts", "a.mjs", ".hidden.ts", "types.d.ts", "notes.txt", "bundle/index.js", "bundle/index.ts"] {
        fs::write(hooks.join(name), "throw new Error('must not execute hooks');").unwrap();
    }
    assert_eq!(run().unwrap(), json!({"directory":hooks,"exists":true,"hooks":[
        {"name":"a.mjs","path":hooks.join("a.mjs"),"entry":"a.mjs"},
        {"name":"bundle","path":hooks.join("bundle/index.ts"),"entry":"bundle/index.ts"},
        {"name":"z.ts","path":hooks.join("z.ts"),"entry":"z.ts"},
    ]}));
}

#[test]
fn hook_list_query_rejects_failed_malformed_and_oversized_responses() {
    for (script, expected) in [
        ("process.stderr.write(' scanner failed \\n'); process.exitCode=7", "Could not list hooks: scanner failed"),
        ("process.stdout.write('not JSON')", "Could not read hook list:"),
        ("process.stdout.write('x'.repeat(4*1024*1024+1))", "Could not list hooks"),
    ] {
        let mut command = Command::new("node"); command.args(["-e", script]);
        let error = query_hook_list(&mut command).unwrap_err();
        assert!(error.starts_with(expected), "{error}");
    }
    let temporary = TestDirectory::new();
    assert!(query_hook_list(&mut Command::new(temporary.0.join("missing"))).is_err());
}
#[test]
fn storage_inventory_query_counts_real_files_and_marks_malformed_archives_undeletable() {
    let home = TestDirectory::new(); let root = home.0.join(".piop");
    for directory in ["sessions", "archived", "git-snapshots/pi-desktop-diff-one", "tmp/chat"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    let active = "{\"type\":\"session\",\"id\":\"active\"}\n";
    fs::write(root.join("sessions/active.jsonl"), active).unwrap();
    fs::write(root.join("sessions/active.diffs.json"), "{}").unwrap();
    fs::write(root.join("sessions/ignored.txt"), "not counted").unwrap();
    fs::write(root.join("archived/broken.jsonl"), "broken").unwrap();
    fs::write(root.join("archived/broken.diffs.json"), "{}").unwrap();
    fs::write(root.join("git-snapshots/pi-desktop-diff-one/object"), "object").unwrap();
    fs::write(root.join("tmp/chat/file"), "temporary").unwrap();
    let script = format!("require('node:os').homedir = () => {};\n{}", serde_json::to_string(home.0.to_str().unwrap()).unwrap(), include_str!("../resources/storage-inventory.cjs"));
    let mut command = Command::new("node"); command.args(["-e", &script]);
    let report = query_storage_inventory(&mut command, None).unwrap();
    assert_eq!(report.host_id, "local"); assert!(report.error.is_none());
    let category = |id: &str| report.categories.iter().find(|category| category.id == id).unwrap();
    assert_eq!(category("active-conversations").byte_size, active.len() as u64 + 2);
    assert_eq!(category("active-conversations").item_count, 1);
    assert_eq!(category("archived-conversations").byte_size, 8);
    assert_eq!(category("git-diff-snapshots").byte_size, 6);
    assert_eq!(category("git-diff-snapshots").item_count, 1);
    assert_eq!(category("temporary-chats").byte_size, 9);
    assert_eq!(category("temporary-chats").item_count, 1);
    assert!(category("project-checkpoints").estimated);
    assert_eq!(report.archives.len(), 1);
    assert_eq!(report.archives[0].id, "broken");
    assert!(!report.archives[0].deletable);
    assert!(report.archives[0].delete_error.as_deref().unwrap().contains("malformed"));
}

#[test]
fn storage_inventory_query_propagates_scanner_failure_and_invalid_response() {
    let host = RemoteHost { id:"remote".into(), name:"Server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
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
    let host = RemoteHost { id: "remote".into(), name: "Remote server".into(), target: "unused".into(), pi_path: "pi".into() };
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
fn session_deletion_removes_trace_and_sidecar_in_both_storage_areas() {
    let home = TestDirectory::new(); let runtime = PiRuntime::default();
    for archived in [false, true] {
        let root = home.0.join(if archived { ".piop/archived" } else { ".piop/sessions" }); fs::create_dir_all(&root).unwrap();
        let path = root.join("conversation.jsonl");
        fs::write(&path, json!({"type":"session","id":"one","cwd":home.0.join("missing-project")}).to_string()).unwrap();
        fs::write(path.with_extension("diffs.json"), "{}").unwrap();
        let other = root.join("other.jsonl"); fs::write(&other, "keep").unwrap();
        delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, archived).unwrap();
        assert!(!path.exists()); assert!(!path.with_extension("diffs.json").exists());
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
            session_path: use_path.then(|| path.to_string_lossy().into_owned()), worktree: None, presence_id: None, working: false, messageable: false,
        });
        assert_eq!(delete_session_files(&runtime, path.to_str().unwrap(), "local", None, &root, false).unwrap_err(), "Close the session before deleting it");
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

#[test]
fn shortcuts_canonicalize_modifiers_and_reject_plain_typing() {
    assert_eq!(canonical_shortcut(" Shift + CTRL + n ").unwrap(), Some("ctrl+shift+n".into()));
    assert_eq!(canonical_shortcut("Ctrl+Ctrl+N").unwrap(), Some("ctrl+n".into()));
    assert_eq!(canonical_shortcut("Ctrl+F2").unwrap(), Some("ctrl+f2".into()));
    assert_eq!(canonical_shortcut("Ctrl++").unwrap(), Some("ctrl++".into()));
    assert_eq!(canonical_shortcut(" ").unwrap(), None);
    for invalid in ["Ctrl", "n", "Shift+é", "🦆", "F2", " + "] { assert!(canonical_shortcut(invalid).is_err(), "{invalid}"); }
}

#[test]
fn keybinding_validation_rejects_duplicates_and_reserved_search_shortcuts() {
    let mut settings = default_settings();
    assert!(validate_keybindings(&settings).is_ok());
    for shortcut in ["Ctrl+G", "META+g", "Mod+G", "ctrl+b"] {
        settings.keybindings.insert("newConversation".into(), shortcut.into());
        assert!(validate_keybindings(&settings).is_err(), "{shortcut}");
    }
    settings.keybindings.insert("newConversation".into(), "".into());
    assert!(validate_keybindings(&settings).is_ok());
    settings.keybindings.insert("retired".into(), "Ctrl+G".into());
    settings.keybindings.insert("focusComposer".into(), "Ctrl+L".into());
    migrate_keybindings(&mut settings);
    assert!(!settings.keybindings.contains_key("retired"));
    assert_eq!(settings.keybindings["focusComposer"], "Ctrl+E");
    settings.keybindings.insert("focusComposer".into(), "Alt+E".into());
    migrate_keybindings(&mut settings);
    assert_eq!(settings.keybindings["focusComposer"], "Alt+E");
}

fn dictionaries(values: Value, active: &[&str]) -> AppSettings {
    let mut settings = default_settings();
    settings.dictionaries = serde_json::from_value(values).unwrap();
    settings.active_dictionary_ids = active.iter().map(|id| (*id).to_owned()).collect();
    settings
}

#[test]
fn dictionary_validation_limits_collision_checks_to_active_dictionaries() {
    let entries = json!([{"id":"one","name":"One","entries":[{"word":" cat ","replacement":"dog"},{"word":" ","replacement":"blank"}]},{"id":"two","name":"Two","entries":[{"word":"cat","replacement":"kitten"}]}]);
    assert!(validate_dictionaries(&dictionaries(entries.clone(), &["one"])).is_ok());
    assert!(validate_dictionaries(&dictionaries(entries.clone(), &["one", "two"])).unwrap_err().contains("cat"));
    assert!(validate_dictionaries(&dictionaries(entries.clone(), &["missing"])).unwrap_err().contains("not found"));
    assert!(validate_dictionaries(&dictionaries(entries, &["one", "one"])).unwrap_err().contains("only be active once"));
    for ids in [["", "two"], ["same", "same"]] {
        let settings = dictionaries(json!([{"id":ids[0],"name":"One","entries":[]},{"id":ids[1],"name":"Two","entries":[]}]), &[]);
        assert!(validate_dictionaries(&settings).unwrap_err().contains("unique id"));
    }
}

#[test]
fn mcp_validation_accepts_supported_transports_and_string_headers() {
    let mut settings = default_settings();
    for headers in [json!(null), json!(""), json!({"Authorization":"Bearer token"}), json!("{\"X-Test\":\"yes\"}")] {
        settings.mcp_servers = vec![json!({"id":"stdio","name":"Local","command":"node","startupTimeoutSec":1}), json!({"id":"http","name":"Remote","transport":"http","url":"https://example.com/mcp","headers":headers,"startupTimeoutSec":600})];
        assert!(validate_mcp_servers(&settings).is_ok());
    }
}

#[test]
fn mcp_validation_rejects_invalid_identity_timeouts_urls_and_headers() {
    let mut settings = default_settings();
    let valid = json!({"id":"server","name":"Server","command":"node"});
    for (key, values) in [
        ("id", vec![json!(" "), json!(null)]),
        ("name", vec![json!(" "), json!(null)]),
        ("command", vec![json!(""), json!(null)]),
        ("transport", vec![json!("unsupported")]),
        ("startupTimeoutSec", vec![json!(0), json!(601), json!(1.5), json!("30"), json!(null)]),
    ] {
        for value in values { let mut server = valid.clone(); server[key] = value; settings.mcp_servers = vec![server]; assert!(validate_mcp_servers(&settings).is_err(), "{key}"); }
    }
    for url in ["invalid", "file:///tmp/a"] {
        settings.mcp_servers = vec![json!({"id":"server","name":"Server","transport":"http","url":url})];
        assert!(validate_mcp_servers(&settings).is_err());
    }
    for headers in [json!(42), json!([]), json!("not json"), json!("[]"), json!({"X":42})] {
        settings.mcp_servers = vec![json!({"id":"server","name":"Server","transport":"http","url":"http://localhost/mcp","headers":headers})];
        assert!(validate_mcp_servers(&settings).is_err());
    }
    settings.mcp_servers = vec![valid.clone(), valid.clone()];
    assert!(validate_mcp_servers(&settings).unwrap_err().contains("unique id"));
    settings.mcp_servers = vec![valid; MAX_MCP_SERVERS + 1];
    assert!(validate_mcp_servers(&settings).unwrap_err().contains("At most"));
}

#[test]
fn frontmatter_respects_the_header_boundary_and_quoted_values() {
    let text = "---\nignored line\nother: value\nname: 'A skill'\n---\nname: wrong";
    assert_eq!(frontmatter_value(text, "name"), Some("A skill".into()));
    assert_eq!(frontmatter_value(text, "missing"), None);
    assert_eq!(frontmatter_value("name: outside", "name"), None);
    assert_eq!(expand_skill_path("~/skills/a", Path::new("/home/test")), PathBuf::from("/home/test/skills/a"));
    assert_eq!(expand_skill_path("/skills/a", Path::new("/home/test")), PathBuf::from("/skills/a"));
    assert!(skill_path_is_within(Path::new("/skills/a"), Path::new("/skills")));
    assert!(!skill_path_is_within(Path::new("/skills-other/a"), Path::new("/skills")));
}

#[test]
fn worktree_names_validate_user_input_and_sanitize_project_prefixes() {
    assert_eq!(worktree_suffix(" feature-1_test.v2 ").unwrap(), "feature-1_test.v2");
    for name in ["", " ", "feature/name", "a b", "é", "$(touch x)"] { assert!(worktree_suffix(name).is_err()); }
    assert_eq!(worktree_branch_name(" My / Project! ", "feature"), "My-Project-feature");
    assert_eq!(worktree_branch_name("!!!", "feature"), "project-feature");
    assert_eq!(worktree_branch_name("my_project", "feature"), "my_project-feature");
}
pub(super) struct TestDirectory(pub(super) PathBuf);
impl TestDirectory {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("piop-tests-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

// Tests exercising installers that read HOME must serialize the process-wide
// override and restore the original value: the test harness runs tests in
// parallel threads within one process.
struct HomeOverride(std::sync::MutexGuard<'static, ()>, Option<std::ffi::OsString>);

impl HomeOverride {
    fn take(home: &Path) -> Self {
        static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let guard = HOME_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", home);
        HomeOverride(guard, previous)
    }
}

impl Drop for HomeOverride {
    fn drop(&mut self) {
        match self.1.take() {
            Some(original) => std::env::set_var("HOME", original),
            None => std::env::remove_var("HOME"),
        }
    }
}

#[test]
fn dropped_files_preserve_binary_data_and_enforce_file_type_and_size_limits() {
    let root = TestDirectory::new();
    let path = root.0.join("attachment.bin"); fs::write(&path, [0, 255, 128, 10]).unwrap();
    assert_eq!(read_dropped_file(path.to_string_lossy().into_owned()).unwrap(), json!({"name":"attachment.bin","data":[0,255,128,10]}));
    assert_eq!(read_dropped_file(root.0.to_string_lossy().into_owned()).unwrap_err(), "Drop files, not folders");
    assert!(read_dropped_file(root.0.join("missing").to_string_lossy().into_owned()).is_err());
    let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(10 * 1024 * 1024 + 1).unwrap();
    assert_eq!(read_dropped_file(path.to_string_lossy().into_owned()).unwrap_err(), "Attachment is larger than 10 MB");
    file.set_len(10 * 1024 * 1024).unwrap();
    assert_eq!(read_dropped_file(path.to_string_lossy().into_owned()).unwrap()["data"].as_array().unwrap().len(), 10 * 1024 * 1024);
}

#[test]
fn local_session_index_discovers_refreshes_and_evicts_files() {
    let root = TestDirectory::new(); let index = SessionIndexRuntime::default();
    let sessions_dir = root.0.join("sessions"); fs::create_dir(&sessions_dir).unwrap();
    assert!(list_local_sessions(&index, &sessions_dir).unwrap().is_empty());
    let path = sessions_dir.join("chat.jsonl");
    let header = json!({"type":"session","id":"chat","cwd":root.0});
    fs::write(&path, format!("{header}\n")).unwrap();
    fs::write(sessions_dir.join("ignored.txt"), format!("{header}\n")).unwrap();
    let first = list_local_sessions(&index, &sessions_dir).unwrap();
    assert_eq!(first.len(), 1); assert_eq!(first[0].name, "Untitled session");
    assert!(first[0].cwd_exists); assert!(matches!(first[0].project_kind, Some(ProjectKind::NoRepo)));
    let fingerprint = index.local.lock().unwrap()[&path].fingerprint.clone();
    let unchanged = list_local_sessions(&index, &sessions_dir).unwrap();
    assert_eq!(unchanged[0].id, "chat"); assert_eq!(index.local.lock().unwrap()[&path].fingerprint, fingerprint);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{}", json!({"type":"message","message":{"role":"user","content":"New question"}})).unwrap();
    let updated = list_local_sessions(&index, &sessions_dir).unwrap();
    assert_eq!(updated[0].name, "New question"); assert_eq!(updated[0].message_count, 1);
    assert_ne!(index.local.lock().unwrap()[&path].fingerprint, fingerprint);
    fs::remove_file(&path).unwrap();
    assert!(list_local_sessions(&index, &sessions_dir).unwrap().is_empty());
    assert!(index.local.lock().unwrap().is_empty());
}

fn test_git(cwd: &Path, arguments: &[&str]) {
    let output = Command::new("git").current_dir(cwd)
        .args(["-c", "user.name=Piop Test", "-c", "user.email=piop-test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"])
        .args(arguments).output().unwrap();
    assert!(output.status.success(), "git {arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
}

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
    settings.mcp_servers = vec![json!({"id":"server","transport":"stdio","command":"node","enabled":true})];
    settings.context_window_cap = 12345; settings.context_window_cap_enabled = false;
    assert_eq!(runtime_settings(&settings), json!({
        "tools":["read"], "skills":["/skills/active"], "mcpServers":settings.mcp_servers,
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
        id: id.into(), group_id: None, path: path.into(), name: "Conversation".into(),
        project: "Project".into(), cwd: "/project".into(), cwd_exists: true,
        project_kind: None, project_root: None, modified_at: 0, preview: String::new(),
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
    let ephemeral = root.0.join("ephemeral.jsonl"); fs::write(&ephemeral, "temporary").unwrap();
    remove_ephemeral_session(EphemeralSession::Local(ephemeral.clone()));
    assert!(!ephemeral.exists()); assert!(path.exists());
    remove_ephemeral_session(EphemeralSession::Local(ephemeral));
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
    for length in [40, 64] {
        let token = json!({"root":root,"tree":"A".repeat(length),"repository_root":"/repo"}).to_string();
        let parsed = parse_local_snapshot_with(&token, || Ok(parent.clone())).unwrap();
        assert_eq!(parsed.root, root.canonicalize().unwrap().to_string_lossy());
        assert_eq!(parsed.tree, "A".repeat(length)); assert_eq!(parsed.repository_root, "/repo");
        assert_eq!(parse_local_snapshot_with(&token, || Err("storage failed".into())).err().unwrap(), "storage failed");
        assert!(parse_local_snapshot_with(&token, || Ok(temporary.0.join("missing"))).is_err());
    }
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
    settings.hosts = vec![RemoteHost { id: "remote".into(), name: "Remote".into(), target: "host".into(), pi_path: "pi".into() }; MAX_REMOTE_HOSTS + 1];
    fs::write(&path, serde_json::to_vec(&settings).unwrap()).unwrap();
    assert!(read_settings_at(&path).err().unwrap().contains("remote machines"));
    settings.hosts.clear(); settings.mcp_servers = vec![json!({}); MAX_MCP_SERVERS + 1];
    fs::write(&path, serde_json::to_vec(&settings).unwrap()).unwrap();
    assert!(read_settings_at(&path).err().unwrap().contains("MCP servers"));
}
#[test]
fn summary_ingestion_ignores_unrequested_paths_and_preserves_trusted_file_metadata() {
    let candidates = vec![("/requested.jsonl".into(), "trusted-fingerprint".into(), 123, 456), ("/defaults.jsonl".into(), "defaults".into(), 789, 12)];
    let host = RemoteHost { id: "remote".into(), name: "Server".into(), target: "unused.invalid".into(), pi_path: "pi".into() };
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
    let hosts = ["remote", "offline", "empty"].into_iter().map(|id| RemoteHost {
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
    let remotes = [("z", "Zulu"), ("a", "alpha"), ("b", "Bravo")].into_iter().map(|(id, name)| RemoteHost {
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
    let remotes = (0..9).map(|id| RemoteHost { id:id.to_string(), name:format!("Host {id}"), target:"unused.invalid".into(), pi_path:"pi".into() }).collect();
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

#[test]
fn remote_session_header_reads_only_one_line_and_quotes_shell_paths() {
    let root = TestDirectory::new(); let path = root.0.join("session ' $(touch injected) 日本語.jsonl");
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]).current_dir(&root.0); command };
    let header = "{\"type\":\"session\",\"id\":\"日本語\"}\n";
    fs::write(&path, format!("{header}{}", "large body\n".repeat(20_000))).unwrap();
    assert_eq!(read_remote_session_header(path.to_str().unwrap(), shell).unwrap(), header);
    assert!(!root.0.join("injected").exists());
    let boundary = format!("{}\n", "x".repeat(64 * 1024 - 1));
    fs::write(&path, &boundary).unwrap();
    assert_eq!(read_remote_session_header(path.to_str().unwrap(), shell).unwrap(), boundary);
    fs::write(&path, format!("x{boundary}")).unwrap();
    assert!(read_remote_session_header(path.to_str().unwrap(), shell).unwrap_err().contains("Could not read session identity"));
    fs::write(&path, b"\xff\xfe\n").unwrap();
    assert!(read_remote_session_header(path.to_str().unwrap(), shell).unwrap_err().contains("utf-8"));
    fs::remove_file(&path).unwrap();
    assert_eq!(read_remote_session_header(path.to_str().unwrap(), shell).unwrap_err(), "Could not read session identity");
    assert!(read_remote_session_header("unused", |_| Command::new("/missing/piop-header-test")).is_err());
}

#[test]
fn remote_ephemeral_fork_preserves_history_and_quotes_paths() {
    let root = TestDirectory::new();
    let source = root.0.join("source ' $(touch injected) 日本語.jsonl");
    let destination = root.0.join("destination ' $(touch injected) 日本語.jsonl");
    let body = format!("{{\"type\":\"message\",\"text\":\"{}\"}}\n", "history 🌍".repeat(10_000));
    let original = format!("{{\"type\":\"session\",\"id\":\"original\",\"cwd\":\"/project\",\"timestamp\":\"old\"}}\n{body}");
    fs::write(&source, &original).unwrap();
    let path = create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", |script| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).current_dir(&root.0); command
    }).unwrap();
    assert_eq!(Path::new(&path), destination);
    let copied = fs::read_to_string(&path).unwrap(); let (header, history) = copied.split_once('\n').unwrap();
    let header: Value = serde_json::from_str(header).unwrap();
    assert!(Uuid::parse_str(header["id"].as_str().unwrap()).is_ok());
    assert_eq!(header["parentSession"], source.to_str().unwrap());
    assert_eq!(header["cwd"], "/project"); assert_ne!(header["timestamp"], "old");
    assert_eq!(history, body); assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!root.0.join("injected").exists());
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn remote_ephemeral_fork_reports_failures_without_leaving_partial_files() {
    let root = TestDirectory::new(); let source = root.0.join("source.jsonl"); let destination = root.0.join("copy.jsonl");
    let shell = |script: String| { let mut command = Command::new("sh"); command.args(["-c", &script]); command };
    for content in ["", "bad JSON\n", "{\"type\":\"message\"}\n", "{\"type\":\"session\"}"] {
        fs::write(&source, content).unwrap();
        assert!(create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", shell).is_err());
        assert!(!destination.exists()); assert_eq!(fs::read_to_string(&source).unwrap(), content);
    }
    fs::write(&source, "{\"type\":\"session\"}\n").unwrap(); fs::write(&destination, "existing").unwrap();
    assert!(create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", shell).unwrap_err().contains("EEXIST"));
    assert_eq!(fs::read_to_string(&destination).unwrap(), "existing");
    assert!(create_remote_ephemeral_fork("unused", "unused", "fixture", |_| Command::new("/missing/piop-test")).unwrap_err().contains("Could not create temporary side conversation on fixture"));
    let error = create_remote_ephemeral_fork("unused", "unused", "fixture", |_| {
        let mut command = Command::new("sh"); command.args(["-c", "printf '  '"]); command
    }).unwrap_err();
    assert_eq!(error, "Temporary side conversation path was unavailable");
}

#[test]
fn remote_diff_lifecycle_discards_both_snapshots_after_success_or_patch_failure() {
    use std::cell::RefCell;
    let base = json!({"root":"/tmp/pi-desktop-diff-base", "tree":"a".repeat(40), "repository_root":"/project"}).to_string();
    let current = json!({"root":"/tmp/pi-desktop-diff-current", "tree":"b".repeat(40), "repository_root":"/project"}).to_string();
    for failure in [false, true] {
        for cleanup_failure in [false, true] {
            let events = RefCell::new(Vec::new());
            let result = load_remote_git_diff_with(&base,
                || { events.borrow_mut().push("capture"); Ok(Some(current.clone())) },
                |actual_base, actual_current| {
                    assert_eq!(actual_base, base); assert_eq!(actual_current, current);
                    events.borrow_mut().push("diff");
                    if failure { Err("patch failed".into()) } else { Ok(Some(GitDiffSnapshot::Located { patch: "change".into(), repository_root: "/project".into(), tool_paths: Vec::new() })) }
                },
                |token| {
                    if token == base { events.borrow_mut().push("discard base"); }
                    else { assert_eq!(token, current); events.borrow_mut().push("discard current"); }
                    if cleanup_failure { Err("cleanup failed".into()) } else { Ok(()) }
                });
            assert_eq!(*events.borrow(), ["capture", "diff", "discard base", "discard current"]);
            if failure { assert_eq!(result.err().unwrap(), "patch failed"); }
            else { assert_eq!(serde_json::to_value(result.unwrap().unwrap()).unwrap(), json!({"patch":"change","repositoryRoot":"/project"})); }
        }
    }
    let mut discarded = Vec::new();
    assert!(load_remote_git_diff_with(&base, || Ok(Some(current.clone())), |_, _| Ok(None), |token| { discarded.push(token.to_owned()); Ok(()) }).unwrap().is_none());
    assert_eq!(discarded, [base, current]);
}

#[test]
fn remote_diff_lifecycle_preserves_base_when_capture_cannot_produce_a_snapshot() {
    let base = json!({"root":"/tmp/pi-desktop-diff-base", "tree":"a".repeat(40), "repository_root":"/project"}).to_string();
    let unsupported = load_remote_git_diff_with(&base, || Ok(None), |_, _| panic!("missing snapshot diffed"), |_| panic!("retryable baseline discarded"));
    assert!(unsupported.unwrap().is_none());
    let error = load_remote_git_diff_with(&base, || Err("connection failed".into()), |_, _| panic!("failed capture diffed"), |_| panic!("retryable baseline discarded"));
    assert_eq!(error.err().unwrap(), "connection failed");
    for invalid in ["not JSON", "{}", "{\"root\":\"relative\",\"tree\":\"bad\"}"] {
        assert!(load_remote_git_diff_with(invalid, || panic!("invalid token captured"), |_, _| panic!("invalid token diffed"), |_| panic!("invalid token discarded")).is_err());
    }
}

#[cfg(unix)]
#[test]
fn remote_session_scan_creates_storage_and_reports_only_real_session_files() {
    use std::os::unix::fs::symlink;
    let home = TestDirectory::new();
    let scan = || query_remote_session_metadata(|script| {
        let mut command = Command::new("sh"); command.args(["-c", script]).env("HOME", &home.0); command
    });
    assert!(scan().unwrap().is_empty());
    let root = home.0.join(STORAGE_DIRECTORY).join("sessions"); assert!(root.is_dir());
    let nested = root.join("project ' λ"); fs::create_dir(&nested).unwrap();
    let first = root.join("empty.jsonl"); let second = nested.join("line\nbreak.jsonl");
    fs::write(&first, "").unwrap(); fs::write(&second, "hello λ\n").unwrap();
    fs::write(nested.join("not-session.json"), "ignored").unwrap();
    fs::create_dir(nested.join("directory.jsonl")).unwrap();
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, "outside").unwrap();
    symlink(&outside, nested.join("linked.jsonl")).unwrap();
    symlink(&nested, root.join("linked-directory")).unwrap();
    let mut metadata = parse_remote_session_metadata(&scan().unwrap()); metadata.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(metadata.len(), 2);
    for (path, fingerprint, modified, size) in metadata {
        let expected = fs::metadata(&path).unwrap();
        assert!([first.to_str().unwrap(), second.to_str().unwrap()].contains(&path.as_str()));
        assert_eq!(size, expected.len());
        assert_eq!(modified, expected.modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs());
        assert!(fingerprint.ends_with(&format!(":{size}")));
    }
    fs::remove_file(&first).unwrap();
    let metadata = parse_remote_session_metadata(&scan().unwrap());
    assert_eq!(metadata.len(), 1); assert_eq!(metadata[0].0, second.to_str().unwrap());
}

#[test]
fn remote_session_scan_propagates_launch_exit_and_output_limit_errors() {
    let directory = TestDirectory::new();
    assert!(query_remote_session_metadata(|_| Command::new(directory.0.join("missing"))).is_err());
    let query = |script: &str| query_remote_session_metadata(|_| { let mut command = Command::new("sh"); command.args(["-c", script]); command });
    assert_eq!(query("printf 'permission denied\\n' >&2; exit 7").unwrap_err(), "permission denied\n");
    assert!(query(&format!("head -c {} /dev/zero", MAX_SESSION_INDEX_BATCH_BYTES + 1)).unwrap_err().contains("Could not list remote sessions"));
    fs::write(directory.0.join(STORAGE_DIRECTORY), "preserve").unwrap();
    assert!(query_remote_session_metadata(|script| {
        let mut command = Command::new("sh"); command.args(["-c", script]).env("HOME", &directory.0); command
    }).is_err());
    assert_eq!(fs::read_to_string(directory.0.join(STORAGE_DIRECTORY)).unwrap(), "preserve");
}

#[cfg(unix)]
#[test]
fn remote_temporary_chat_removal_requires_the_expected_root_and_marker() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new(); let home = directory.0.join("home ' $(false)");
    let marked = create_local_temporary_chat(&home, &Uuid::new_v4().to_string()).unwrap();
    fs::write(marked.join("content"), "remove").unwrap();
    let sibling = create_local_temporary_chat(&home, &Uuid::new_v4().to_string()).unwrap();
    fs::write(sibling.join("keep"), "preserve").unwrap();
    let unmarked = home.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string()); fs::create_dir(&unmarked).unwrap();
    let outside = create_local_temporary_chat(&directory.0.join("outside"), &Uuid::new_v4().to_string()).unwrap();
    fs::write(outside.join("keep"), "outside").unwrap();
    let remove = |path: &Path| remove_remote_temporary_chat(path.to_str().unwrap(), "Server", |script| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home); command
    });
    assert!(remove(&unmarked).is_err()); assert!(unmarked.is_dir());
    assert!(remove(&outside).is_err()); assert!(outside.is_dir());
    remove(&marked).unwrap(); assert!(!marked.exists());
    assert_eq!(fs::read_to_string(sibling.join("keep")).unwrap(), "preserve");
    assert!(remove(&marked).is_err());
    let link = home.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string()); symlink(&outside, &link).unwrap();
    remove(&link).unwrap(); assert!(fs::symlink_metadata(&link).is_err());
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "outside", "removing a symlink must not traverse its target");
}

#[test]
fn remote_temporary_chat_removal_rejects_bad_ids_before_launch_and_reports_command_failures() {
    for path in ["", "/tmp", "/home/.piop/tmp/not-a-uuid", "/home/other/123e4567-e89b-12d3-a456-426614174000"] {
        assert_eq!(remove_remote_temporary_chat(path, "Server", |_| panic!("invalid path launched deletion")).unwrap_err(), "Refusing to remove a directory not created as a temporary chat");
    }
    let directory = TestDirectory::new();
    let path = directory.0.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string());
    let error = remove_remote_temporary_chat(path.to_str().unwrap(), "Server", |_| Command::new(directory.0.join("missing"))).unwrap_err();
    assert!(error.starts_with("Could not remove temporary chat directory on Server:"));
    let error = remove_remote_temporary_chat(path.to_str().unwrap(), "Server", |_| {
        let mut command = Command::new("sh"); command.args(["-c", "printf ' access denied\\n' >&2; exit 7"]); command
    }).unwrap_err();
    assert_eq!(error, "Could not remove temporary chat directory on Server: access denied");
}

#[test]
fn remote_temporary_chat_creates_marked_isolated_directories_and_preserves_existing_contents() {
    let directory = TestDirectory::new(); let home = directory.0.join("home ' λ $(false)"); fs::create_dir(&home).unwrap();
    let create = |id: &str| create_remote_temporary_chat(id, "Server", |script| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home); command
    });
    let first_id = Uuid::new_v4().to_string(); let second_id = Uuid::new_v4().to_string();
    let first = PathBuf::from(create(&first_id).unwrap()); let second = PathBuf::from(create(&second_id).unwrap());
    assert_eq!(first, home.join(STORAGE_DIRECTORY).join("tmp").join(&first_id));
    assert_eq!(second, home.join(STORAGE_DIRECTORY).join("tmp").join(&second_id));
    for path in [&first, &second] {
        assert_eq!(fs::read(path.join(".pi-desktop-temporary-chat")).unwrap(), b"");
        assert_eq!(fs::read_dir(path).unwrap().count(), 1);
    }
    fs::write(first.join("user-file"), "keep").unwrap();
    assert_eq!(create(&first_id).unwrap(), first.to_str().unwrap());
    assert_eq!(fs::read_to_string(first.join("user-file")).unwrap(), "keep");
    assert_eq!(fs::read_dir(&second).unwrap().count(), 1);
}

#[test]
fn remote_temporary_chat_reports_launch_setup_and_missing_path_failures() {
    let directory = TestDirectory::new(); let id = Uuid::new_v4().to_string();
    let error = create_remote_temporary_chat(&id, "Server", |_| Command::new(directory.0.join("missing"))).unwrap_err();
    assert!(error.starts_with("Could not create temporary chat directory on Server:"), "{error}");
    for (script, expected) in [("printf ' disk full\\n' >&2; exit 7", "disk full"), ("printf '  \\n'", "Remote temporary chat directory was unavailable")] {
        let error = create_remote_temporary_chat(&id, "Server", |_| { let mut command = Command::new("sh"); command.args(["-c", script]); command }).unwrap_err();
        assert_eq!(error, expected);
    }
    fs::write(directory.0.join(STORAGE_DIRECTORY), "existing file").unwrap();
    assert!(create_remote_temporary_chat(&id, "Server", |script| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &directory.0); command
    }).is_err());
    assert_eq!(fs::read_to_string(directory.0.join(STORAGE_DIRECTORY)).unwrap(), "existing file");
}

#[cfg(unix)]
#[test]
fn remote_project_validation_preserves_paths_and_accepts_directory_symlinks_only() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new();
    let project = directory.0.join("project '\n λ $(false)"); fs::create_dir(&project).unwrap();
    let link = directory.0.join("linked-project"); symlink(&project, &link).unwrap();
    let file = directory.0.join("file"); fs::write(&file, "untouched").unwrap();
    let dangling = directory.0.join("dangling"); symlink(directory.0.join("absent"), &dangling).unwrap();
    let validate = |path: &Path| validate_remote_project_directory(path.to_string_lossy().into_owned(), "Server", |script| {
        let mut command = Command::new("bash"); command.args(["-c", &script]); command
    });
    for path in [&project, &link] { assert_eq!(validate(path).unwrap(), path.to_str().unwrap()); }
    for path in [&file, &dangling, &directory.0.join("missing")] {
        assert!(validate(path).unwrap_err().starts_with("Could not open project directory on Server:"));
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "untouched");
}

#[test]
fn remote_project_validation_rejects_blank_input_before_launch_and_propagates_host_errors() {
    for path in ["", " \n\t"] {
        assert_eq!(validate_remote_project_directory(path.into(), "Server", |_| panic!("blank path launched process")).unwrap_err(), "Path can't be empty");
    }
    let directory = TestDirectory::new();
    let error = validate_remote_project_directory("/project".into(), "Server", |_| Command::new(directory.0.join("missing"))).unwrap_err();
    assert!(error.starts_with("Could not validate project directory on Server:"), "{error}");
    let error = validate_remote_project_directory("/project".into(), "Server", |_| {
        let mut command = Command::new("sh"); command.args(["-c", "printf ' permission denied\\n' >&2; exit 13"]); command
    }).unwrap_err();
    assert_eq!(error, "Could not open project directory on Server: permission denied");
}

#[cfg(unix)]
#[test]
fn remote_directory_listing_preserves_unusual_names_and_limits_results_to_direct_children() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new(); let root = directory.0.join("project ' ; $(false)");
    fs::create_dir_all(&root).unwrap();
    let names = ["zebra", "Alpha", ".hidden", "line\nbreak", "λ space"];
    for name in names { fs::create_dir(root.join(name)).unwrap(); }
    fs::create_dir(root.join("Alpha/nested")).unwrap();
    fs::write(root.join("regular-file"), "data").unwrap();
    symlink(root.join("Alpha"), root.join("linked-dir")).unwrap();
    let missing = root.join("missing"); let file = root.join("regular-file");
    let query = |path| {
        let mut command = Command::new("bash");
        command.args(["-c", &remote_directory_listing_script(path)]).env("HOME", &root);
        query_remote_directories(&mut command, "Remote")
    };
    let mut expected = names.map(|name| root.join(name).to_string_lossy().into_owned()).to_vec();
    expected.sort_by_key(|path| path.to_lowercase());
    for path in [None, Some(""), Some("  "), Some(root.to_str().unwrap())] {
        let listing = query(path).unwrap();
        assert_eq!(listing.path, root.to_str().unwrap());
        assert_eq!(listing.parent.as_deref(), Some(directory.0.to_str().unwrap()));
        assert_eq!(listing.directories, expected);
    }
    assert!(query(Some(missing.to_str().unwrap())).is_err());
    assert!(query(Some(file.to_str().unwrap())).is_err());
    assert_eq!(fs::read_to_string(root.join("regular-file")).unwrap(), "data");
}

#[test]
fn remote_directory_query_reports_launch_command_and_empty_response_failures() {
    let directory = TestDirectory::new();
    let error = query_remote_directories(&mut Command::new(directory.0.join("missing")), "Remote").err().unwrap();
    assert!(error.starts_with("Could not browse Remote:"), "{error}");
    let mut command = Command::new("sh"); command.args(["-c", "printf ' access denied ' >&2; exit 7"]);
    assert_eq!(query_remote_directories(&mut command, "Remote").err().unwrap(), "access denied");
    let mut command = Command::new("sh"); command.args(["-c", "exit 0"]);
    assert_eq!(query_remote_directories(&mut command, "Remote").err().unwrap(), "Remote directory was unavailable");
}

#[test]
fn local_project_validation_preserves_valid_paths_and_rejects_non_directories() {
    let directory = TestDirectory::new();
    let project = directory.0.join(" project 日本語 "); fs::create_dir(&project).unwrap();
    let requested = project.to_string_lossy().into_owned();
    assert_eq!(validate_local_project_directory(requested.clone()).unwrap(), requested);
    let dotted = project.join(".").to_string_lossy().into_owned();
    assert_eq!(validate_local_project_directory(dotted.clone()).unwrap(), dotted);
    for blank in ["", " ", "\t\n"] { assert_eq!(validate_local_project_directory(blank.into()).unwrap_err(), "Path can't be empty"); }
    let file = directory.0.join("file"); fs::write(&file, "keep").unwrap();
    assert_eq!(validate_local_project_directory(file.to_string_lossy().into_owned()).unwrap_err(), "Project path is not a directory");
    assert!(validate_local_project_directory(directory.0.join("missing").to_string_lossy().into_owned()).unwrap_err().starts_with("Could not open project directory:"));
    assert_eq!(fs::read_to_string(&file).unwrap(), "keep");
}

#[cfg(unix)]
#[test]
fn local_project_validation_follows_directory_links_but_rejects_broken_or_file_links() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new();
    let project = directory.0.join("project"); fs::create_dir(&project).unwrap();
    let alias = directory.0.join("alias"); symlink(&project, &alias).unwrap();
    let requested = alias.to_string_lossy().into_owned();
    assert_eq!(validate_local_project_directory(requested.clone()).unwrap(), requested);
    fs::remove_dir(&project).unwrap();
    assert!(validate_local_project_directory(requested.clone()).unwrap_err().starts_with("Could not open project directory:"));
    fs::write(&project, "now a file").unwrap();
    assert_eq!(validate_local_project_directory(requested).unwrap_err(), "Project path is not a directory");
    assert_eq!(fs::read_to_string(&project).unwrap(), "now a file");
}

#[cfg(unix)]
#[test]
fn remote_diff_scripts_round_trip_private_sidecars_and_reject_outside_sessions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = TestDirectory::new();
    let sessions = directory.0.join(STORAGE_DIRECTORY).join("sessions/project 'quoted'"); fs::create_dir_all(&sessions).unwrap();
    let session = sessions.join("conversation ' λ.jsonl"); fs::write(&session, "session data").unwrap();
    let command = |script: String| { let mut command = Command::new("bash"); command.args(["-c", &script]).env("HOME", &directory.0); command };
    let read = |path: &Path| query_remote_git_diffs(&mut command(remote_session_sidecar_script(path.to_str().unwrap(), "if [ -f \"$sidecar\" ]; then cat -- \"$sidecar\"; else printf '{}'; fi")), "Server");
    assert!(read(&session).unwrap().is_empty());
    let body = r#"{"first":"patch λ","second":{"patch":"diff","repositoryRoot":"/project","toolPaths":[]}}"#;
    write_remote_git_diffs(&mut command(remote_save_git_diffs_script(session.to_str().unwrap())), body).unwrap();
    assert_eq!(serde_json::to_value(read(&session).unwrap()).unwrap(), json!({"first":"patch λ","second":{"patch":"diff","repositoryRoot":"/project"}}));
    let sidecar = session.with_extension("diffs.json");
    assert_eq!(fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(&session).unwrap(), "session data");
    write_remote_git_diffs(&mut command(remote_save_git_diffs_script(session.to_str().unwrap())), "{}").unwrap();
    assert!(read(&session).unwrap().is_empty());
    assert_eq!(fs::read_dir(&sessions).unwrap().count(), 2, "temporary sidecars must be removed");
    let outside = directory.0.join("outside.jsonl"); fs::write(&outside, "outside").unwrap();
    let link = sessions.join("escape.jsonl"); symlink(&outside, &link).unwrap();
    let wrong_extension = sessions.join("not-a-session.txt"); fs::write(&wrong_extension, "text").unwrap();
    for rejected in [&outside, &link, &wrong_extension] {
        assert!(read(rejected).is_err());
        assert!(write_remote_git_diffs(&mut command(remote_save_git_diffs_script(rejected.to_str().unwrap())), "{}").is_err());
        assert!(!rejected.with_extension("diffs.json").exists());
    }
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
}

#[cfg(unix)]
#[test]
fn remote_diff_queries_propagate_process_encoding_json_and_size_errors() {
    let query = |script: &str| { let mut command = Command::new("bash"); command.args(["-c", script]); query_remote_git_diffs(&mut command, "Server") };
    assert_eq!(query("printf ' remote failure ' >&2; exit 7").err().unwrap(), "remote failure");
    assert_eq!(query("printf '\\377'").err().unwrap(), "Saved remote diffs were not valid UTF-8");
    assert!(query("printf 'not JSON'").err().unwrap().starts_with("Could not parse saved diffs:"));
    assert!(query("printf '[]'").is_err());
    assert!(query(&format!("head -c {} /dev/zero", MAX_GIT_DIFFS_BYTES + 1)).err().unwrap().contains("Saved diffs on Server exceed the limit"));
    let directory = TestDirectory::new();
    assert!(query_remote_git_diffs(&mut Command::new(directory.0.join("missing")), "Server").is_err());
    assert!(write_remote_git_diffs(&mut Command::new(directory.0.join("missing")), "{}").is_err());
    let mut rejected = Command::new("bash"); rejected.args(["-c", "cat >/dev/null; printf 'write rejected' >&2; exit 9"]);
    assert_eq!(write_remote_git_diffs(&mut rejected, "{}").unwrap_err(), "write rejected");
}

#[test]
fn executable_discovery_searches_home_installations_in_order_and_ignores_directories() {
    let home = TestDirectory::new();
    for directory in [".local/bin", ".npm-global/bin", ".bun/bin"] {
        fs::create_dir_all(home.0.join(directory)).unwrap();
        fs::write(home.0.join(directory).join("pi"), "").unwrap();
    }
    assert_eq!(pi_executable_in(Some(home.0.clone())), home.0.join(".local/bin/pi"));
    fs::remove_file(home.0.join(".local/bin/pi")).unwrap();
    fs::create_dir(home.0.join(".local/bin/pi")).unwrap();
    assert_eq!(pi_executable_in(Some(home.0.clone())), home.0.join(".npm-global/bin/pi"));
    fs::remove_file(home.0.join(".npm-global/bin/pi")).unwrap();
    fs::remove_file(home.0.join(".bun/bin/pi")).unwrap();
    let empty = TestDirectory::new();
    assert_eq!(pi_executable_in(Some(empty.0.clone())), pi_executable_in(None));
}

#[test]
fn temporary_chat_removal_deletes_marked_contents_and_preserves_other_chats() {
    let home = TestDirectory::new();
    let first = create_local_temporary_chat(&home.0, &Uuid::new_v4().to_string()).unwrap();
    let second = create_local_temporary_chat(&home.0, &Uuid::new_v4().to_string()).unwrap();
    fs::create_dir(first.join("nested")).unwrap(); fs::write(first.join("nested/file"), "temporary content").unwrap();
    fs::write(second.join("keep"), "other chat").unwrap();
    remove_local_temporary_chat(&home.0, first.to_str().unwrap()).unwrap();
    assert!(!first.exists());
    assert_eq!(fs::read_to_string(second.join("keep")).unwrap(), "other chat");
    assert!(second.join(".pi-desktop-temporary-chat").is_file());
    assert!(remove_local_temporary_chat(&home.0, first.to_str().unwrap()).is_err());
}

#[test]
fn temporary_chat_removal_rejects_unmarked_wrong_root_and_non_uuid_directories() {
    let home = TestDirectory::new(); let other_home = TestDirectory::new();
    let outside = create_local_temporary_chat(&other_home.0, &Uuid::new_v4().to_string()).unwrap();
    assert_eq!(remove_local_temporary_chat(&home.0, outside.to_str().unwrap()).unwrap_err(), "Refusing to remove a directory outside the temporary chat root");
    assert!(outside.is_dir());
    let unmarked = home.0.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string());
    fs::create_dir_all(&unmarked).unwrap(); fs::write(unmarked.join("keep"), "keep").unwrap();
    assert_eq!(remove_local_temporary_chat(&home.0, unmarked.to_str().unwrap()).unwrap_err(), "Refusing to remove an unmarked directory");
    fs::create_dir(unmarked.join(".pi-desktop-temporary-chat")).unwrap();
    assert!(remove_local_temporary_chat(&home.0, unmarked.to_str().unwrap()).is_err());
    assert_eq!(fs::read_to_string(unmarked.join("keep")).unwrap(), "keep");
    let named = home.0.join(STORAGE_DIRECTORY).join("tmp/project"); fs::create_dir(&named).unwrap();
    fs::write(named.join(".pi-desktop-temporary-chat"), "").unwrap();
    assert_eq!(remove_local_temporary_chat(&home.0, named.to_str().unwrap()).unwrap_err(), "Refusing to remove a directory not created as a temporary chat");
    assert!(named.is_dir());
}

#[test]
fn temporary_chats_create_marked_directories_and_validate_their_location() {
    let root = TestDirectory::new();
    let id = "12345678-1234-4123-8123-123456789abc";
    let path = create_local_temporary_chat(&root.0, id).unwrap();
    assert_eq!(path, root.0.join(STORAGE_DIRECTORY).join("tmp").join(id));
    assert!(path.join(".pi-desktop-temporary-chat").is_file());
    assert_eq!(temporary_chat_id(path.to_str().unwrap()), Some(id));
    assert_eq!(create_local_temporary_chat(&root.0, id).unwrap(), path);
    for invalid in [format!("/home/tmp/{id}"), format!("/home/.piop/other/{id}"), "/home/.piop/tmp/not-a-uuid".into(), "/".into()] {
        assert_eq!(temporary_chat_id(&invalid), None);
    }
    let blocked = root.0.join("blocked"); fs::write(&blocked, b"file").unwrap();
    assert!(create_local_temporary_chat(&blocked, id).unwrap_err().contains("Could not create temporary chat directory"));
}

#[test]
fn directory_listing_defaults_to_home_filters_files_and_sorts_names() {
    let home = TestDirectory::new();
    for name in ["zebra", "Apple", "beta", ".hidden"] { fs::create_dir(home.0.join(name)).unwrap(); }
    fs::write(home.0.join("not-a-directory"), "file").unwrap();
    let canonical = home.0.canonicalize().unwrap();
    let expected: Vec<_> = [".hidden", "Apple", "beta", "zebra"].iter().map(|name| canonical.join(name).to_string_lossy().into_owned()).collect();
    for path in [None, Some(""), Some(" \t"), home.0.to_str()] {
        let listing = list_local_directories(&home.0, path).unwrap();
        assert_eq!(listing.path, canonical.to_string_lossy());
        assert_eq!(listing.parent, Some(canonical.parent().unwrap().to_string_lossy().into_owned()));
        assert_eq!(listing.directories, expected);
    }
    let empty = list_local_directories(&home.0, home.0.join("beta").to_str()).unwrap();
    assert!(empty.directories.is_empty());
    assert_eq!(empty.parent.as_deref(), canonical.to_str());
    assert!(list_local_directories(&home.0, home.0.join("missing").to_str()).err().unwrap().starts_with("Could not browse"));
    assert!(list_local_directories(&home.0, home.0.join("not-a-directory").to_str()).err().unwrap().ends_with("is not a directory"));
}

#[cfg(unix)]
#[test]
fn directory_listing_resolves_requested_symlinks_and_omits_broken_links() {
    use std::os::unix::fs::symlink;
    let home = TestDirectory::new();
    let target = home.0.join("target"); fs::create_dir(&target).unwrap();
    symlink(&target, home.0.join("alias")).unwrap();
    symlink(home.0.join("missing"), home.0.join("broken")).unwrap();
    let listing = list_local_directories(&home.0, home.0.join("alias").to_str()).unwrap();
    assert_eq!(listing.path, target.canonicalize().unwrap().to_string_lossy());
    let root = list_local_directories(&home.0, None).unwrap();
    assert_eq!(root.directories.len(), 2);
    assert!(root.directories.iter().any(|path| path.ends_with("/alias")));
    assert!(!root.directories.iter().any(|path| path.ends_with("/broken")));
}

#[test]
fn remote_directory_output_preserves_names_and_root_parent_semantics() {
    let listing = parse_remote_directories(b"/project\0zebra\0Apple\0a b\nname\0\0").unwrap();
    assert_eq!(listing.path, "/project"); assert_eq!(listing.parent.as_deref(), Some("/"));
    assert_eq!(listing.directories, vec!["/project/a b\nname", "/project/Apple", "/project/zebra"]);
}

#[test]
fn saved_diff_history_round_trips_and_replaces_removed_messages() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions/project");
    fs::create_dir_all(&sessions).unwrap();
    let session = sessions.join("conversation.jsonl");
    fs::write(&session, "{\"type\":\"session\",\"id\":\"conversation\"}\n").unwrap();
    let original = fs::read(&session).unwrap();
    let history = json!({"first":"diff --git a/a b/a\n+hello 日本語\n", "second":{"patch":"+new\n","repositoryRoot":"/project with spaces","toolPaths":[{"toolCallId":"call","path":"a","absolutePath":"/project with spaces/a","canonicalPath":"/project with spaces/a"}]}});
    for expected in [history, json!({"second":"updated patch"}), json!({})] {
        save_local_git_diffs(&home.0, session.to_str().unwrap(), &expected.to_string()).unwrap();
        let loaded = load_local_git_diffs(&home.0, session.to_str().unwrap()).unwrap();
        assert_eq!(serde_json::to_value(loaded).unwrap(), expected);
        assert_eq!(fs::read(&session).unwrap(), original);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(session.with_extension("diffs.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
    assert_eq!(fs::read_dir(&sessions).unwrap().count(), 2);
}

#[test]
fn saving_diffs_requires_an_existing_desktop_session_and_reports_sidecar_failures() {
    let home = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let missing = sessions.join("missing.jsonl");
    assert!(save_local_git_diffs(&home.0, missing.to_str().unwrap(), "{}").is_err());
    assert!(!missing.with_extension("diffs.json").exists());
    let outside = home.0.join("outside.jsonl");
    fs::write(&outside, "outside").unwrap();
    assert!(save_local_git_diffs(&home.0, outside.to_str().unwrap(), "{}").is_err());
    assert!(!outside.with_extension("diffs.json").exists());
    let session = sessions.join("valid.jsonl");
    fs::write(&session, "original").unwrap();
    let sidecar = session.with_extension("diffs.json");
    fs::create_dir(&sidecar).unwrap();
    fs::write(sidecar.join("keep"), "keep").unwrap();
    assert!(save_local_git_diffs(&home.0, session.to_str().unwrap(), "{}").unwrap_err().starts_with("Could not save diffs:"));
    assert_eq!(fs::read_to_string(sidecar.join("keep")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(&session).unwrap(), "original");
}

#[test]
fn oversized_diff_histories_are_rejected_before_accessing_local_or_remote_storage() {
    let root = TestDirectory::new(); let session = root.0.join("untouched.jsonl"); fs::write(&session, "retain").unwrap();
    let remote = RemoteHost { id: "remote".into(), name: "Remote".into(), target: "unused.invalid".into(), pi_path: "pi".into() };
    for host in [None, Some(&remote)] {
        let snapshots = HashMap::from([("message".into(), GitDiffSnapshot::Legacy("x".repeat(MAX_GIT_DIFFS_BYTES)))]);
        assert_eq!(save_git_diffs_at_host(session.to_str().unwrap(), snapshots, host).unwrap_err(), "Diff history exceeds the 16 MiB limit");
    }
    assert_eq!(fs::read_to_string(&session).unwrap(), "retain");
    assert!(!session.with_extension("diffs.json").exists());
}

#[test]
fn session_identity_reads_only_the_header_and_accepts_the_size_boundary() {
    let directory = TestDirectory::new();
    let path = directory.0.join("session.jsonl");
    let settings = default_settings();
    for suffix in ["", "\ninvalid body", "\r\n{\"id\":\"wrong-message-id\"}\n"] {
        fs::write(&path, format!("{{\"type\":\"session\",\"id\":\"session-日本語\"}}{suffix}")).unwrap();
        assert_eq!(session_identity(&settings, "local", path.to_str().unwrap()).unwrap(), "session-日本語");
    }
    let prefix = "{\"id\":\"boundary\",\"padding\":\"";
    let header = format!("{prefix}{}\"}}", "x".repeat(64 * 1024 - prefix.len() - 2));
    assert_eq!(header.len(), 64 * 1024);
    fs::write(&path, format!("{header}\n{{\"id\":\"ignored\"}}\n")).unwrap();
    assert_eq!(session_identity(&settings, "local", path.to_str().unwrap()).unwrap(), "boundary");
    let oversized = format!("{prefix}{}\"}}\n", "x".repeat(64 * 1024));
    fs::write(&path, oversized).unwrap();
    assert!(session_identity(&settings, "local", path.to_str().unwrap()).is_err());
}

#[test]
fn session_identity_rejects_missing_ids_invalid_headers_and_unavailable_files() {
    let directory = TestDirectory::new();
    let path = directory.0.join("session.jsonl");
    let settings = default_settings();
    assert!(session_identity(&settings, "local", path.to_str().unwrap()).is_err());
    for header in ["{}", "[]", "null", "{\"id\":null}", "{\"id\":42}", "{\"id\":\"\"}"] {
        fs::write(&path, format!("{header}\n{{\"id\":\"later-id\"}}\n")).unwrap();
        assert_eq!(session_identity(&settings, "local", path.to_str().unwrap()).unwrap_err(), "Missing session identity");
    }
    for content in [b"".as_slice(), b"not json\n", b"\xff\n", b"\n{\"id\":\"later\"}"] {
        fs::write(&path, content).unwrap();
        assert!(session_identity(&settings, "local", path.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&path).unwrap(), content);
    }
    assert!(session_identity(&settings, "unknown-host", path.to_str().unwrap()).unwrap_err().contains("Unknown machine"));
}

#[test]
fn git_snapshot_workflow_compares_changes_and_cleans_both_snapshots() {
    for changed in [false, true] {
        let temporary = TestDirectory::new(); let repository = temporary.0.join("repository");
        let snapshots = temporary.0.join("snapshots");
        fs::create_dir(&repository).unwrap(); fs::create_dir(&snapshots).unwrap();
        test_git(&repository, &["init", "--initial-branch=main"]);
        fs::write(repository.join("file"), "before\n").unwrap();
        test_git(&repository, &["add", "."]); test_git(&repository, &["commit", "-m", "Initial"]);
        let baseline = local_git_tree_with(repository.to_str().unwrap(), || Ok(snapshots.clone())).unwrap().unwrap();
        if changed { fs::write(repository.join("file"), "after\n").unwrap(); }
        let diff = local_git_diff_with(repository.to_str().unwrap(), &baseline,
            |token| validate_snapshot_location(serde_json::from_str(token).unwrap(), &snapshots),
            |cwd| local_git_tree_with(cwd, || Ok(snapshots.clone()))).unwrap();
        if changed {
            match diff.unwrap() {
                GitDiffSnapshot::Located { patch, repository_root, .. } => {
                    assert!(patch.contains("-before\n+after")); assert_eq!(repository_root, repository.to_str().unwrap());
                }
                _ => panic!("expected located diff"),
            }
        } else { assert!(diff.is_none()); }
        assert_eq!(fs::read_dir(&snapshots).unwrap().count(), 0);
    }
}

#[test]
fn git_snapshot_workflow_skips_non_repositories_and_discards_baseline_when_capture_unavailable() {
    let temporary = TestDirectory::new();
    assert!(local_git_tree_with(temporary.0.to_str().unwrap(), || panic!("non-repository allocated storage")).unwrap().is_none());
    let snapshots = temporary.0.join("snapshots"); fs::create_dir(&snapshots).unwrap();
    let baseline_root = snapshots.join("pi-desktop-diff-baseline"); fs::create_dir(&baseline_root).unwrap();
    let token = serde_json::to_string(&GitSnapshotToken { root:baseline_root.to_string_lossy().into_owned(), tree:"a".repeat(40), repository_root:temporary.0.to_string_lossy().into_owned() }).unwrap();
    let result = local_git_diff_with(temporary.0.to_str().unwrap(), &token,
        |token| validate_snapshot_location(serde_json::from_str(token).unwrap(), &snapshots), |_| Ok(None)).unwrap();
    assert!(result.is_none()); assert!(!baseline_root.exists());
}

#[test]
fn git_snapshots_capture_working_changes_without_modifying_the_real_index() {
    let repository = TestDirectory::new(); let snapshots = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    fs::write(repository.0.join("tracked.txt"), "original\n").unwrap();
    test_git(&repository.0, &["add", "tracked.txt"]); test_git(&repository.0, &["commit", "-m", "Initial"]);
    let (root, objects) = git_root_and_objects(repository.0.to_str().unwrap()).unwrap().unwrap();
    let capture = || serde_json::from_str::<GitSnapshotToken>(&capture_local_git_tree(&root, &objects, &snapshots.0).unwrap()).unwrap();
    let base = capture();
    fs::write(repository.0.join("tracked.txt"), "staged\n").unwrap(); test_git(&repository.0, &["add", "tracked.txt"]);
    fs::write(repository.0.join("tracked.txt"), "working\n").unwrap(); fs::write(repository.0.join("new.txt"), "untracked\n").unwrap();
    let index_entries = || {
        let output = Command::new("git").arg("-C").arg(&repository.0).args(["ls-files", "--stage", "-z"]).output().unwrap();
        assert!(output.status.success()); output.stdout
    };
    let index_before = index_entries();
    let current = capture();
    assert_eq!(index_entries(), index_before);
    assert_eq!(fs::read_to_string(repository.0.join("tracked.txt")).unwrap(), "working\n");
    let diff = local_git_diff_between(root.to_str().unwrap(), &base, &current).unwrap().unwrap();
    let GitDiffSnapshot::Located { patch, repository_root, tool_paths } = diff else { panic!("snapshot diff must carry its repository root") };
    assert!(patch.contains("-original")); assert!(patch.contains("+working")); assert!(patch.contains("+untracked"));
    assert!(!patch.contains("+staged")); assert_eq!(repository_root, root.to_string_lossy()); assert!(tool_paths.is_empty());
    let unchanged = capture();
    assert!(local_git_diff_between(root.to_str().unwrap(), &current, &unchanged).unwrap().is_none());
    let plain = TestDirectory::new();
    assert!(local_git_diff_between(plain.0.to_str().unwrap(), &base, &current).unwrap().is_none());
}

#[test]
fn failed_snapshot_capture_removes_temporary_objects_and_preserves_staged_content() {
    let repository = TestDirectory::new(); let snapshots = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    fs::write(repository.0.join("staged.txt"), "staged content").unwrap(); test_git(&repository.0, &["add", "staged.txt"]);
    test_git(&repository.0, &["config", "filter.reject.clean", "false"]);
    test_git(&repository.0, &["config", "filter.reject.required", "true"]);
    fs::write(repository.0.join(".gitattributes"), "rejected.txt filter=reject\n").unwrap();
    fs::write(repository.0.join("rejected.txt"), "working content").unwrap();
    let (root, objects) = git_root_and_objects(repository.0.to_str().unwrap()).unwrap().unwrap();
    let error = capture_local_git_tree(&root, &objects, &snapshots.0).unwrap_err();
    assert!(error.contains("clean filter 'reject' failed"));
    assert_eq!(fs::read_dir(&snapshots.0).unwrap().count(), 0);
    let staged = Command::new("git").arg("-C").arg(&root).args(["show", ":staged.txt"]).output().unwrap();
    assert!(staged.status.success()); assert_eq!(staged.stdout, b"staged content");
    assert_eq!(fs::read_to_string(root.join("rejected.txt")).unwrap(), "working content");
}

#[test]
fn snapshot_creation_reports_unavailable_storage_and_invalid_repositories() {
    let repository = TestDirectory::new(); let storage = TestDirectory::new();
    test_git(&repository.0, &["init", "--initial-branch=main"]);
    let (root, objects) = git_root_and_objects(repository.0.to_str().unwrap()).unwrap().unwrap();
    let blocked = storage.0.join("blocked"); fs::write(&blocked, "retain").unwrap();
    assert!(capture_local_git_tree(&root, &objects, &blocked).unwrap_err().contains("Could not create Git snapshot"));
    assert_eq!(fs::read_to_string(&blocked).unwrap(), "retain");
    assert!(capture_local_git_tree(&storage.0, &objects, &storage.0).is_err());
    assert_eq!(fs::read_dir(&storage.0).unwrap().count(), 1);
}

#[test]
fn snapshot_locations_require_direct_children_with_the_expected_name() {
    let storage = TestDirectory::new(); let parent = storage.0.canonicalize().unwrap();
    let valid = parent.join("pi-desktop-diff-valid"); fs::create_dir(&valid).unwrap();
    let token = |path: &Path| GitSnapshotToken { root: path.to_string_lossy().into_owned(), tree: "a".repeat(40), repository_root: "/original/repository".into() };
    let parsed = validate_snapshot_location(token(&valid), &parent).unwrap();
    assert_eq!(parsed.root, valid.to_string_lossy()); assert_eq!(parsed.repository_root, "/original/repository"); assert_eq!(parsed.tree, "a".repeat(40));
    let wrong_name = parent.join("unrelated"); fs::create_dir(&wrong_name).unwrap();
    let nested = valid.join("pi-desktop-diff-nested"); fs::create_dir(&nested).unwrap();
    for path in [&wrong_name, &nested, &parent] {
        assert_eq!(validate_snapshot_location(token(path), &parent).err().unwrap(), "Invalid Git snapshot location");
    }
    assert_eq!(validate_snapshot_location(token(&parent.join("pi-desktop-diff-expired")), &parent).err().unwrap(), "Git snapshot expired");
}

#[cfg(unix)]
#[test]
fn snapshot_location_validation_checks_the_symlink_destination() {
    use std::os::unix::fs::symlink;
    let storage = TestDirectory::new(); let outside = TestDirectory::new();
    let parent = storage.0.canonicalize().unwrap();
    let valid = parent.join("pi-desktop-diff-valid"); fs::create_dir(&valid).unwrap();
    let alias = parent.join("alias"); symlink(&valid, &alias).unwrap();
    let make_token = |path: &Path| GitSnapshotToken { root: path.to_string_lossy().into_owned(), tree: "b".repeat(40), repository_root: String::new() };
    assert_eq!(validate_snapshot_location(make_token(&alias), &parent).unwrap().root, valid.to_string_lossy());
    let escape = parent.join("pi-desktop-diff-escape"); symlink(&outside.0, &escape).unwrap();
    assert_eq!(validate_snapshot_location(make_token(&escape), &parent).err().unwrap(), "Invalid Git snapshot location");
    assert!(outside.0.is_dir());
}

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
            _ => settings.hosts.push(RemoteHost { id:"remote".into(), name:"Local".into(), target:"unused.invalid".into(), pi_path:"pi".into() }),
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
    let host = RemoteHost { id: "remote".into(), name: "Server".into(), target: "user@host".into(), pi_path: "pi".into() };
    let mut settings = default_settings(); settings.hosts = vec![host.clone()];
    assert!(validate_settings_for_save(&settings).is_ok());
    for (id, name, target, executable, expected) in [
        (" ", "Server", "host", "pi", "unique id"),
        ("remote", " ", "host", "pi", "needs a name"),
        ("remote", " LoCaL ", "host", "pi", "already in use"),
        ("remote", "Server", "host;id", "pi", "SSH target"),
        ("remote", "Server", "host", "pi --flag", "Pi executable"),
    ] {
        settings.hosts = vec![RemoteHost { id: id.into(), name: name.into(), target: target.into(), pi_path: executable.into() }];
        assert!(validate_settings_for_save(&settings).unwrap_err().contains(expected));
    }
    settings.hosts = vec![host.clone(), RemoteHost { name: "Other".into(), ..host.clone() }];
    assert!(validate_settings_for_save(&settings).unwrap_err().contains("unique id"));
    settings.hosts = vec![host.clone(), RemoteHost { id: "other".into(), name: " SERVER ".into(), ..host.clone() }];
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
    settings.active_dictionary_ids = vec!["missing".into()]; assert!(validate_settings_for_save(&settings).unwrap_err().contains("dictionary"));
    settings.active_dictionary_ids.clear(); settings.keybindings.insert("newConversation".into(), "Ctrl+G".into());
    assert!(validate_settings_for_save(&settings).is_err()); settings.keybindings = default_keybindings();
    settings.mcp_servers = vec![json!({"id":"invalid"})]; assert!(validate_settings_for_save(&settings).is_err());
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
    // Restore fixture traversal before assertions so a regression does not prevent cleanup.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(result.is_err(), "a directory cannot be used as settings.json");
    assert_eq!(mode, 0o750);
    assert_eq!(fs::read_to_string(path.join("keep")).unwrap(), "original");
}

#[test]
fn project_worktree_creation_uses_repository_root_and_preserves_source_changes() {
    let temporary = TestDirectory::new();
    let repository = temporary.0.join("Project's files");
    let nested = repository.join("nested");
    fs::create_dir_all(&nested).unwrap();
    test_git(&repository, &["init", "--initial-branch=main"]);
    fs::write(repository.join("tracked"), "committed").unwrap();
    test_git(&repository, &["add", "."]); test_git(&repository, &["commit", "-m", "Initial"]);
    fs::write(repository.join("tracked"), "local edits").unwrap();
    fs::write(repository.join("untracked"), "private").unwrap();
    let worktree = create_project_worktree_at(nested.to_str().unwrap(), " feature ", None).unwrap();
    assert_eq!(worktree.branch, "Project-s-files-feature");
    assert_eq!(Path::new(&worktree.path), temporary.0.join("Project-s-files-feature"));
    assert_eq!(fs::read_to_string(Path::new(&worktree.path).join("tracked")).unwrap(), "committed");
    assert!(!Path::new(&worktree.path).join("untracked").exists());
    assert_eq!(fs::read_to_string(repository.join("tracked")).unwrap(), "local edits");
    assert_eq!(fs::read_to_string(repository.join("untracked")).unwrap(), "private");
    assert!(local_worktree_is_registered(&repository, Path::new(&worktree.path)).unwrap());
    assert!(local_branch_exists(&repository, &worktree.branch).unwrap());
    let output = Command::new("git").args(["-C", &worktree.path, "branch", "--show-current"]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), worktree.branch);
}

#[test]
fn project_worktree_creation_rejects_invalid_sources_and_names_without_creating_targets() {
    let temporary = TestDirectory::new();
    let repository = temporary.0.join("project"); fs::create_dir(&repository).unwrap();
    for name in ["", "../escape", "two words", "a/b"] {
        assert!(create_project_worktree_at(repository.to_str().unwrap(), name, None).is_err());
    }
    assert_eq!(create_project_worktree_at(repository.to_str().unwrap(), "feature", None).err().unwrap(), "Project is not a Git repository");
    assert_eq!(create_project_worktree_at(repository.join("missing").to_str().unwrap(), "feature", None).err().unwrap(), "Project is not a Git repository");
    test_git(&repository, &["init", "--initial-branch=main"]);
    assert!(create_project_worktree_at(repository.to_str().unwrap(), "feature", None).is_err(), "unborn repositories have no HEAD to check out");
    assert!(!temporary.0.join("project-feature").exists());
    assert!(!local_branch_exists(&repository, "project-feature").unwrap());
}

#[test]
fn project_worktree_creation_preserves_existing_branch_and_target_on_collisions() {
    let temporary = TestDirectory::new();
    let repository = temporary.0.join("project"); fs::create_dir(&repository).unwrap();
    test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let created = create_project_worktree_at(repository.to_str().unwrap(), "feature", None).unwrap();
    let marker = Path::new(&created.path).join("keep"); fs::write(&marker, "existing work").unwrap();
    assert!(create_project_worktree_at(repository.to_str().unwrap(), "feature", None).is_err());
    assert_eq!(fs::read_to_string(marker).unwrap(), "existing work");
    assert!(local_worktree_is_registered(&repository, Path::new(&created.path)).unwrap());
    let occupied = temporary.0.join("project-occupied"); fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep"), "unrelated directory").unwrap();
    assert!(create_project_worktree_at(repository.to_str().unwrap(), "occupied", None).is_err());
    assert_eq!(fs::read_to_string(occupied.join("keep")).unwrap(), "unrelated directory");
    assert!(!local_worktree_is_registered(&repository, &occupied).unwrap());
}

#[test]
fn copied_worktree_supports_unborn_repositories_with_staged_and_untracked_files() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    fs::write(repository.join("staged"), "staged content").unwrap();
    test_git(&repository, &["add", "staged"]);
    fs::write(repository.join("untracked"), "untracked content").unwrap();
    let index = fs::read(repository.join(".git/index")).unwrap();
    let result = create_local_git_worktree(repository.to_str().unwrap(), "first").unwrap();
    let target = Path::new(&result.path);
    assert_eq!(fs::read_to_string(target.join("staged")).unwrap(), "staged content");
    assert_eq!(fs::read_to_string(target.join("untracked")).unwrap(), "untracked content");
    assert_eq!(fs::read(repository.join(".git/index")).unwrap(), index);
    assert!(local_worktree_is_registered(&repository, target).unwrap());
    let head = Command::new("git").arg("-C").arg(target).args(["rev-parse", "--verify", "HEAD"]).output().unwrap();
    assert!(!head.status.success(), "creation must not invent an initial commit");
    let staged = Command::new("git").arg("-C").arg(target).args(["ls-files"]).output().unwrap();
    assert!(staged.status.success()); assert!(staged.stdout.is_empty());
}

#[test]
fn copied_worktree_rejects_missing_but_registered_targets_without_removing_the_registration() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let target = temporary.0.join("project-copy");
    test_git(&repository, &["worktree", "add", "--detach", target.to_str().unwrap()]);
    fs::remove_dir_all(&target).unwrap();
    assert!(local_worktree_is_registered(&repository, &target).unwrap());
    let error = create_local_git_worktree(repository.to_str().unwrap(), "copy").err().unwrap();
    assert!(error.contains("Git worktree is already registered"), "{error}");
    assert!(local_worktree_is_registered(&repository, &target).unwrap());
    assert!(!local_branch_exists(&repository, "project-copy").unwrap());
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn copied_worktree_preserves_broken_symlink_destinations_and_copies_relative_file_links() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let occupied = temporary.0.join("project-occupied");
    std::os::unix::fs::symlink("missing-target", &occupied).unwrap();
    assert!(create_local_git_worktree(repository.to_str().unwrap(), "occupied").err().unwrap().contains("Worktree directory already exists"));
    assert_eq!(fs::read_link(&occupied).unwrap(), PathBuf::from("missing-target"));
    fs::write(repository.join("file"), "contents").unwrap();
    std::os::unix::fs::symlink("file", repository.join("link")).unwrap();
    std::os::unix::fs::symlink("missing", repository.join("broken")).unwrap();
    let copied = create_local_git_worktree(repository.to_str().unwrap(), "copy").unwrap();
    let target = Path::new(&copied.path);
    assert_eq!(fs::read_link(target.join("link")).unwrap(), PathBuf::from("file"));
    assert_eq!(fs::read_link(target.join("broken")).unwrap(), PathBuf::from("missing"));
    assert_eq!(fs::read_to_string(target.join("link")).unwrap(), "contents");
}

#[test]
fn copied_worktree_combines_staged_unstaged_binary_and_untracked_changes() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    fs::write(repository.join("tracked"), "original\n").unwrap();
    fs::write(repository.join("binary"), [0, 1, 2]).unwrap();
    test_git(&repository, &["add", "."]); test_git(&repository, &["commit", "-m", "Initial"]);
    fs::write(repository.join("tracked"), "staged\n").unwrap(); test_git(&repository, &["add", "tracked"]);
    fs::write(repository.join("tracked"), "unstaged final\n").unwrap();
    fs::write(repository.join("binary"), [0, 255, 17, 0]).unwrap();
    fs::create_dir(repository.join("nested")).unwrap();
    fs::write(repository.join("nested/new file"), "new content").unwrap();
    fs::write(repository.join(".gitignore"), "ignored\n").unwrap();
    fs::write(repository.join("ignored"), "not copied").unwrap();
    let index_before = fs::read(repository.join(".git/index")).unwrap();
    let result = create_local_git_worktree(repository.join("nested").to_str().unwrap(), "copy").unwrap();
    let target = Path::new(&result.path);
    assert_eq!(result.branch, "project-copy");
    assert_eq!(fs::read_to_string(target.join("tracked")).unwrap(), "unstaged final\n");
    assert_eq!(fs::read(target.join("binary")).unwrap(), vec![0, 255, 17, 0]);
    assert_eq!(fs::read_to_string(target.join("nested/new file")).unwrap(), "new content");
    assert!(!target.join("ignored").exists());
    assert_eq!(fs::read(repository.join(".git/index")).unwrap(), index_before);
    assert_eq!(fs::read_to_string(repository.join("tracked")).unwrap(), "unstaged final\n");
    let staged = Command::new("git").arg("-C").arg(target).args(["diff", "--cached", "--quiet"]).status().unwrap();
    assert!(staged.success(), "copied edits should be unstaged in the new checkout");
}

#[test]
fn copied_worktree_rejects_invalid_refs_and_existing_destinations_before_mutation() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap();
    assert_eq!(create_local_git_worktree(repository.to_str().unwrap(), "copy").err().unwrap(), "Project is not a Git repository");
    test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    assert!(create_local_git_worktree(repository.to_str().unwrap(), "bad..ref").err().unwrap().contains("Invalid Git branch"));
    test_git(&repository, &["branch", "project-existing"]);
    assert!(create_local_git_worktree(repository.to_str().unwrap(), "existing").err().unwrap().contains("Git branch already exists"));
    let target = temporary.0.join("project-occupied"); fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), "untouched").unwrap();
    assert!(create_local_git_worktree(repository.to_str().unwrap(), "occupied").err().unwrap().contains("Worktree directory already exists"));
    assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "untouched");
    assert!(!local_branch_exists(&repository, "project-occupied").unwrap());
}

#[cfg(unix)]
#[test]
fn copied_worktree_rolls_back_branch_and_registration_when_nested_file_copy_fails() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let nested = repository.join("nested"); fs::create_dir(&nested).unwrap();
    test_git(&nested, &["init", "--initial-branch=main"]);
    test_git(&nested, &["commit", "--allow-empty", "-m", "Nested"]);
    let socket_path = nested.join("socket");
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let error = create_local_git_worktree(repository.to_str().unwrap(), "copy").err().unwrap();
    assert!(error.contains("Unsupported untracked filesystem entry"), "{error}");
    assert!(!temporary.0.join("project-copy").exists());
    assert!(!local_branch_exists(&repository, "project-copy").unwrap());
    assert!(!local_worktree_is_registered(&repository, &temporary.0.join("project-copy")).unwrap());
    assert!(nested.join(".git").is_dir());
    assert!(socket_path.exists());
}

#[test]
fn worktree_removal_honors_branch_retention_and_reports_unmerged_branches() {
    for scenario in ["keep", "delete", "unmerged", "detached"] {
        let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
        fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
        test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
        let worktree = temporary.0.join("checkout");
        if scenario == "detached" {
            test_git(&repository, &["worktree", "add", "--detach", worktree.to_str().unwrap()]);
        } else {
            test_git(&repository, &["worktree", "add", "-b", "feature", worktree.to_str().unwrap()]);
        }
        if scenario == "unmerged" { test_git(&worktree, &["commit", "--allow-empty", "-m", "Unmerged work"]); }
        let settings = default_settings();
        let target = inspect_worktree_removal(&settings, worktree.to_str().unwrap(), "local").unwrap();
        let result = remove_worktree_target(&settings, "local", target, scenario != "keep").unwrap();
        assert!(!worktree.exists());
        assert!(!local_worktree_is_registered(&repository, &worktree).unwrap());
        assert_eq!(result.branch.as_deref(), if scenario == "detached" { None } else { Some("feature") });
        assert_eq!(result.branch_deleted, scenario == "delete");
        assert_eq!(local_branch_exists(&repository, "feature").unwrap(), matches!(scenario, "keep" | "unmerged"));
        match scenario {
            "keep" | "delete" => assert!(result.warning.is_none()),
            "detached" => assert_eq!(result.warning.as_deref(), Some("The detached worktree was removed; there was no branch to delete")),
            _ => assert!(result.warning.unwrap().contains("branch 'feature' was kept")),
        }
        assert!(repository.join(".git").is_dir());
    }
}

#[test]
fn worktree_removal_rechecks_git_safety_when_files_change_after_inspection() {
    for change in ["dirty", "locked"] {
        let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
        fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
        test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
        let worktree = temporary.0.join("checkout");
        test_git(&repository, &["worktree", "add", "-b", "feature", worktree.to_str().unwrap()]);
        let settings = default_settings();
        let target = inspect_worktree_removal(&settings, worktree.to_str().unwrap(), "local").unwrap();
        if change == "dirty" { fs::write(worktree.join("new-work"), "preserve").unwrap(); }
        else { test_git(&repository, &["worktree", "lock", worktree.to_str().unwrap()]); }
        assert!(remove_worktree_target(&settings, "local", target, true).is_err());
        assert!(worktree.exists());
        assert!(local_worktree_is_registered(&repository, &worktree).unwrap());
        assert!(local_branch_exists(&repository, "feature").unwrap());
        if change == "dirty" { assert_eq!(fs::read_to_string(worktree.join("new-work")).unwrap(), "preserve"); }
    }
}

#[cfg(unix)]
#[test]
fn worktree_usage_guards_resolve_nested_paths_and_isolate_hosts_and_resource_types() {
    let temporary = TestDirectory::new(); let repository = temporary.0.join("project");
    fs::create_dir(&repository).unwrap(); test_git(&repository, &["init", "--initial-branch=main"]);
    test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let worktree = temporary.0.join("checkout");
    test_git(&repository, &["worktree", "add", "-b", "feature", worktree.to_str().unwrap()]);
    let nested = worktree.join("nested"); fs::create_dir(&nested).unwrap();
    let settings = default_settings(); let runtime = PiRuntime::default();
    let terminals = TestTerminals(TerminalRuntime::default());
    let target = worktree.to_str().unwrap();
    for count in [1, 2] {
        let sessions = vec![nested.to_string_lossy().into_owned(); count];
        assert_eq!(validate_worktree_unused(&settings, "local", target, &sessions, &runtime, &terminals.0).unwrap_err(),
            format!("Archive or relocate the {count} conversation{} using this worktree before deleting it", if count == 1 { "" } else { "s" }));
    }
    let unrelated = vec![repository.to_string_lossy().into_owned(), temporary.0.join("missing").to_string_lossy().into_owned()];
    assert!(validate_worktree_unused(&settings, "local", target, &unrelated, &runtime, &terminals.0).is_ok());
    runtime.active_agents.lock().unwrap().insert("agent".into(), AgentAddress {
        host_id:"remote".into(), session_id:Some("session".into()), session_path:None,
        worktree:Some(nested.to_string_lossy().into_owned()), presence_id:None, working:false, messageable:true,
    });
    assert!(validate_worktree_unused(&settings, "local", target, &[], &runtime, &terminals.0).is_ok());
    runtime.active_agents.lock().unwrap().get_mut("agent").unwrap().host_id = "local".into();
    assert_eq!(validate_worktree_unused(&settings, "local", target, &[], &runtime, &terminals.0).unwrap_err(), "Close every conversation using this worktree before deleting it");
    runtime.active_agents.lock().unwrap().clear();
    let _receiver = terminals.add("terminal");
    {
        let mut processes = terminals.0.processes.lock().unwrap();
        let terminal = processes.get_mut("terminal").unwrap();
        terminal.cwd = nested.to_string_lossy().into_owned(); terminal.host_id = "remote".into();
    }
    assert!(validate_worktree_unused(&settings, "local", target, &[], &runtime, &terminals.0).is_ok());
    terminals.0.processes.lock().unwrap().get_mut("terminal").unwrap().host_id = "local".into();
    assert_eq!(validate_worktree_unused(&settings, "local", target, &[], &runtime, &terminals.0).unwrap_err(), "Close every terminal using this worktree before deleting it");
    assert!(worktree.exists());
    assert!(local_branch_exists(&repository, "feature").unwrap());
}

#[test]
fn project_inspection_batches_distinct_directories_and_updates_all_matching_sessions() {
    let root = TestDirectory::new();
    let repository = root.0.join("repo ' 日本語"); fs::create_dir(&repository).unwrap();
    test_git(&repository, &["init", "--initial-branch=main"]); test_git(&repository, &["commit", "--allow-empty", "-m", "Initial"]);
    let worktree = root.0.join("worktree"); test_git(&repository, &["worktree", "add", "-b", "feature", worktree.to_str().unwrap()]);
    let plain = root.0.join("plain"); fs::create_dir(&plain).unwrap();
    let mut paths = vec![repository.clone(), worktree.clone(), plain.clone()];
    paths.extend((0..127).map(|index| root.0.join(format!("missing-{index}"))));
    let mut sessions = paths.iter().enumerate().map(|(index, path)| {
        let mut session = test_session("remote", &index.to_string(), "/session"); session.cwd = path.to_string_lossy().into_owned(); session
    }).collect::<Vec<_>>();
    sessions.push(sessions[0].clone());
    let mut batches = Vec::new(); let mut inspected = HashSet::new();
    inspect_session_projects_with(&mut sessions, |script, batch| {
        batches.push(batch.len()); for path in batch { assert!(inspected.insert(path.clone())); }
        let mut command = Command::new("sh"); command.args(["-c", script, "sh"]).args(batch).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null"); command
    }).unwrap();
    assert_eq!(batches, [128, 2]); assert_eq!(inspected.len(), 130);
    assert!(matches!(sessions[0].project_kind, Some(ProjectKind::Main)));
    assert!(matches!(sessions[1].project_kind, Some(ProjectKind::Worktree)));
    assert!(matches!(sessions[2].project_kind, Some(ProjectKind::NoRepo)));
    assert_eq!(sessions[1].project_root.as_deref(), repository.to_str());
    for session in &sessions[3..130] { assert!(!session.cwd_exists); assert!(session.project_kind.is_none()); assert!(session.project_root.is_none()); }
    assert_eq!(serde_json::to_value(&sessions[0]).unwrap(), serde_json::to_value(&sessions[130]).unwrap());
}

#[test]
fn project_inspection_preserves_all_sessions_when_a_later_batch_is_incomplete() {
    let mut sessions = (0..129).map(|index| {
        let mut session = test_session("local", &index.to_string(), "/session"); session.cwd = format!("/project/{index}"); session.project_root = Some("previous".into()); session
    }).collect::<Vec<_>>();
    let original = serde_json::to_value(&sessions).unwrap();
    for failure in ["printf incomplete", "printf 'main\\000'", "printf denied >&2; exit 1"] {
        let mut calls = 0;
        let error = inspect_session_projects_with(&mut sessions, |_, batch| {
            calls += 1;
            let mut command = Command::new("sh");
            if calls == 1 { command.args(["-c", "for path do printf 'missing\\000\\000'; done", "sh"]).args(batch); }
            else { command.args(["-c", failure]); }
            command
        }).unwrap_err();
        assert!(!error.is_empty()); assert_eq!(calls, 2);
        assert_eq!(serde_json::to_value(&sessions).unwrap(), original);
    }
    assert!(inspect_session_projects_with(&mut sessions, |_, _| Command::new("/missing/piop-project-test")).is_err());
    assert_eq!(serde_json::to_value(&sessions).unwrap(), original);
    inspect_session_projects_with(&mut [], |_, _| panic!("empty list launched a process")).unwrap();
}

#[test]
fn ephemeral_forks_copy_history_with_new_identity_and_private_permissions() {
    let home = TestDirectory::new(); let temporary = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("source.jsonl");
    let body = format!("{{\"type\":\"message\",\"text\":\"{}\"}}\n", "hello 🌍".repeat(20_000));
    let header = json!({"type":"session","id":"original","cwd":"/project","version":3,"timestamp":"old","custom":true});
    let original = format!("{header}\n{body}"); fs::write(&source, &original).unwrap();
    let mut ids = HashSet::new();
    for _ in 0..2 {
        let (path, ephemeral) = create_local_ephemeral_fork(&home.0, &temporary.0, source.to_str().unwrap()).unwrap();
        assert!(Path::new(&path).starts_with(&temporary.0));
        let content = fs::read_to_string(&path).unwrap(); let (first, rest) = content.split_once('\n').unwrap();
        let fork: Value = serde_json::from_str(first).unwrap();
        let id = fork["id"].as_str().unwrap(); assert!(Uuid::parse_str(id).is_ok()); assert!(ids.insert(id.to_owned()));
        assert_eq!(fork["parentSession"], source.to_str().unwrap());
        assert_ne!(fork["timestamp"], "old");
        for key in ["type", "cwd", "version", "custom"] { assert_eq!(fork[key], header[key]); }
        assert_eq!(rest, body); assert_eq!(fs::read_to_string(&source).unwrap(), original);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        remove_ephemeral_session(ephemeral); assert!(!Path::new(&path).exists());
    }
    assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 0);
}

#[test]
fn failed_ephemeral_forks_leave_no_partial_files_and_preserve_the_source() {
    let home = TestDirectory::new(); let temporary = TestDirectory::new();
    let sessions = home.0.join(STORAGE_DIRECTORY).join("sessions"); fs::create_dir_all(&sessions).unwrap();
    let source = sessions.join("source.jsonl");
    for content in ["", "invalid\n", "{\"type\":\"message\"}\n", "{\"type\":\"session\"}"] {
        fs::write(&source, content).unwrap();
        assert!(create_local_ephemeral_fork(&home.0, &temporary.0, source.to_str().unwrap()).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), content);
        assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 0);
    }
    let outside = home.0.join("outside.jsonl"); fs::write(&outside, "{\"type\":\"session\"}\n").unwrap();
    assert!(create_local_ephemeral_fork(&home.0, &temporary.0, outside.to_str().unwrap()).is_err());
    assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 0);
}

#[test]
fn project_inspection_updates_directory_existence_without_reindexing_the_session() {
    let root = TestDirectory::new(); let index = SessionIndexRuntime::default();
    let sessions_dir = root.0.join("sessions"); fs::create_dir(&sessions_dir).unwrap();
    let project = root.0.join("missing project"); let path = sessions_dir.join("chat.jsonl");
    fs::write(&path, format!("{}\n", json!({"type":"session","id":"chat","cwd":project}))).unwrap();
    let missing = list_local_sessions(&index, &sessions_dir).unwrap();
    assert!(!missing[0].cwd_exists); assert!(missing[0].project_kind.is_none());
    let fingerprint = index.local.lock().unwrap()[&path].fingerprint.clone();
    fs::create_dir(&project).unwrap();
    let restored = list_local_sessions(&index, &sessions_dir).unwrap();
    assert!(restored[0].cwd_exists); assert!(matches!(restored[0].project_kind, Some(ProjectKind::NoRepo)));
    assert_eq!(index.local.lock().unwrap()[&path].fingerprint, fingerprint);
    fs::remove_dir(&project).unwrap();
    assert!(!list_local_sessions(&index, &sessions_dir).unwrap()[0].cwd_exists);
}

#[test]
fn parallel_short_lived_worktree_scripts_retain_failure_diagnostics() {
    thread::scope(|scope| {
        let workers = (0..8).map(|_| scope.spawn(|| {
            let root = TestDirectory::new(); test_git(&root.0, &["init", "--initial-branch=main"]);
            let mut settings = default_settings();
            settings.worktree_setup_scripts = vec![setup_script("diagnostic", &root.0, "printf 'expected diagnostic' >&2; exit 7", "")];
            for _ in 0..25 {
                let error = run_worktree_scripts(&settings, root.0.to_str().unwrap(), root.0.to_str().unwrap(), "local", &AtomicBool::new(false), WorktreeScriptPhase::Setup).unwrap_err();
                assert!(error.contains("expected diagnostic"), "{error}");
            }
        })).collect::<Vec<_>>();
        for worker in workers { worker.join().unwrap(); }
    });
}

#[test]
fn usage_query_propagates_server_errors_and_missing_usage_data() {
    for (stage, response, expected) in [
        (1, json!({"id":1,"error":{"message":"initialize denied"}}), "initialize denied"),
        (2, json!({"id":2,"error":{"message":"not signed in"}}), "not signed in"),
        (2, json!({"id":2,"result":{}}), "Codex usage is unavailable"),
        (2, json!({"id":2}), "Codex returned no usage data"),
    ] {
        let script = format!("const r=require(\u{27}readline\u{27}).createInterface({{input:process.stdin}});r.on(\u{27}line\u{27},line=>{{const p=JSON.parse(line);if(p.id===1) console.log(JSON.stringify({}));else if(p.id===2) console.log(JSON.stringify({}));}});", if stage == 1 { response.clone() } else { json!({"id":1,"result":{}}) }, response);
        let error = query_codex_usage(Command::new("node").args(["-e", &script])).err().unwrap();
        assert!(error.contains(expected), "{error}");
    }
    let directory = TestDirectory::new();
    assert!(query_codex_usage(&mut Command::new(directory.0.join("missing"))).err().unwrap().starts_with("Could not start Codex:"));
}

#[test]
fn conversation_window_targets_require_a_nonblank_string_session_id() {
    for target in [Value::Null, json!({}), json!({"sessionId":null}), json!({"sessionId":7}), json!({"sessionId":""}), json!({"sessionId":" \n\t"})] {
        assert_eq!(conversation_window_target(&target).unwrap_err(), "Select a conversation to open in another window");
    }
}

#[test]
fn conversation_window_targets_round_trip_special_characters_without_extra_query_fields() {
    let target = json!({
        "sessionId":"session & # ? = + / \u{3bb}",
        "sessionPath":"/project\u{27}s files/a?b#c.jsonl",
        "hostId":"remote",
        "name":"hello\n\u{4e16}\u{754c}",
        "nested":{"value":"%26target=other"}
    });
    let (first, path) = conversation_window_target(&target).unwrap();
    let (second, _) = conversation_window_target(&target).unwrap();
    assert_ne!(first, second);
    assert!(Uuid::parse_str(first.strip_prefix("chat-").unwrap()).is_ok());
    assert!(Uuid::parse_str(second.strip_prefix("chat-").unwrap()).is_ok());
    let url = tauri::Url::parse("https://piop.invalid/").unwrap().join(&path).unwrap();
    assert_eq!(url.path(), "/index.html");
    assert!(url.fragment().is_none());
    let parameters = url.query_pairs().collect::<Vec<_>>();
    assert_eq!(parameters.len(), 1);
    assert_eq!(parameters[0].0, "target");
    assert_eq!(serde_json::from_str::<Value>(&parameters[0].1).unwrap(), target);
}

#[test]
fn external_url_opening_rejects_non_web_schemes_before_invoking_the_system_opener() {
    for url in ["", "relative/path", "https://", "http://[invalid"] {
        assert_eq!(open_external_url_with(url, |_| panic!("invalid URL opened")).unwrap_err(), "Enter a valid HTTP or HTTPS URL");
    }
    for url in ["file:///tmp/file", "javascript:alert(1)", "data:text/html,hello", "mailto:user@example.com", "ftp://example.com/file"] {
        assert_eq!(open_external_url_with(url, |_| panic!("non-web URL opened")).unwrap_err(), "Only HTTP and HTTPS links can be opened in the browser");
    }
}

#[test]
fn external_url_opening_preserves_encoded_targets_and_propagates_launcher_failures() {
    for (url, expected) in [
        ("HTTPS://Example.COM:443/a b?x=1&y=2#section", "https://example.com/a%20b?x=1&y=2#section"),
        ("http://localhost:8080/path", "http://localhost:8080/path"),
        ("https://example.com/?q=%26%3D%23", "https://example.com/?q=%26%3D%23"),
    ] {
        open_external_url_with(url, |target| {
            assert_eq!(target, std::ffi::OsStr::new(expected)); Ok(())
        }).unwrap();
    }
    assert_eq!(open_external_url_with("https://example.com", |_| Err("launcher unavailable".into())).unwrap_err(), "launcher unavailable");
}

#[test]
fn project_directory_opening_passes_literal_paths_and_propagates_launcher_errors() {
    let temporary = TestDirectory::new();
    let directory = temporary.0.join("project\u{27}s $files; \u{3bb}"); fs::create_dir(&directory).unwrap();
    open_project_directory_with(directory.to_str().unwrap(), None, |path| {
        assert_eq!(path, directory.as_os_str()); Ok(())
    }).unwrap();
    assert_eq!(open_project_directory_with(directory.to_str().unwrap(), None, |_| Err("file manager unavailable".into())).unwrap_err(), "file manager unavailable");
    #[cfg(unix)]
    {
        let alias = temporary.0.join("alias");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        open_project_directory_with(alias.to_str().unwrap(), None, |path| { assert_eq!(path, alias.as_os_str()); Ok(()) }).unwrap();
    }
}

#[test]
fn project_directory_opening_rejects_files_missing_directories_and_remote_hosts() {
    let temporary = TestDirectory::new(); let file = temporary.0.join("file"); fs::write(&file, "contents").unwrap();
    for path in [file, temporary.0.join("missing")] {
        let error = open_project_directory_with(path.to_str().unwrap(), None, |_| panic!("invalid directory opened")).unwrap_err();
        assert_eq!(error, format!("Project directory does not exist: {}", path.display()));
    }
    let host = RemoteHost { id:"remote".into(), name:"Build server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
    assert_eq!(open_project_directory_with(temporary.0.to_str().unwrap(), Some(&host), |_| panic!("remote directory opened locally")).unwrap_err(),
        "Opening project directories on Build server is not supported by the local file manager");
}

#[test]
fn extension_staging_transport_delivers_large_scripts_and_drains_output() {
    let temporary = TestDirectory::new(); let destination = temporary.0.join("received");
    let payload = "\u{3bb} payload\n".repeat(100_000);
    let script = format!("cat > {} <<\u{27}PIOP_PAYLOAD\u{27}\n{}PIOP_PAYLOAD\nhead -c 100000 /dev/zero\nhead -c 100000 /dev/zero >&2\n", shell_quote(destination.to_str().unwrap()), payload);
    stage_extension_script(Command::new("sh").arg("-s"), "Test server", script).unwrap();
    assert_eq!(fs::read_to_string(destination).unwrap(), payload);
}

#[test]
fn extension_staging_transport_reports_launch_exit_and_stdin_failures() {
    let temporary = TestDirectory::new();
    let error = stage_extension_script(&mut Command::new(temporary.0.join("missing")), "Test server", "script".into()).unwrap_err();
    assert!(error.starts_with("Could not install piop extensions on Test server:"));
    let payload = "x".repeat(2 * 1024 * 1024);
    let error = stage_extension_script(Command::new("sh").args(["-c", "printf \u{27} install rejected \\n\u{27} >&2; exit 7"]), "Test server", payload.clone()).unwrap_err();
    assert_eq!(error, "install rejected", "process diagnostics must take precedence over a broken stdin pipe");
    let error = stage_extension_script(Command::new("sh").args(["-c", "exit 0"]), "Test server", payload).unwrap_err();
    assert!(error.starts_with("Could not send piop extensions to Test server:"), "{error}");
}

#[test]
fn worktree_setup_execution_removes_finished_failed_and_panicked_jobs_only() {
    for outcome in ["success", "failure", "panic"] {
        let runtime = PiRuntime::default();
        let id = register_worktree_setup(&runtime).unwrap();
        let other = register_worktree_setup(&runtime).unwrap();
        let result = tauri::async_runtime::block_on(execute_worktree_setup(&runtime, &id, move |cancelled| {
            assert!(!cancelled.load(Ordering::SeqCst));
            match outcome { "success" => Ok(()), "failure" => Err("setup failed".into()), _ => panic!("setup worker panicked") }
        }));
        match outcome {
            "success" => result.unwrap(),
            "failure" => assert_eq!(result.unwrap_err(), "setup failed"),
            _ => assert!(result.unwrap_err().contains("panicked")),
        }
        let pending = runtime.worktree_setups.lock().unwrap();
        assert!(!pending.contains_key(&id)); assert!(pending.contains_key(&other)); assert_eq!(pending.len(), 1);
    }
}

#[test]
fn worktree_setup_execution_observes_cancellation_and_rejects_unknown_jobs() {
    let runtime = Arc::new(PiRuntime::default());
    assert_eq!(tauri::async_runtime::block_on(execute_worktree_setup(&runtime, "unknown",
        |_| panic!("unknown job executed"))).unwrap_err(), "Unknown setup");
    let id = register_worktree_setup(&runtime).unwrap();
    let (started, ready) = mpsc::channel(); let (release, proceed) = mpsc::channel();
    let worker_runtime = runtime.clone(); let worker_id = id.clone();
    let worker = thread::spawn(move || tauri::async_runtime::block_on(execute_worktree_setup(&worker_runtime, &worker_id, move |cancelled| {
        started.send(()).unwrap();
        proceed.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
        Err("Environment setup cancelled".into())
    })));
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    signal_worktree_setup_cancellation(&runtime, &id).unwrap();
    release.send(()).unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err(), "Environment setup cancelled");
    assert!(runtime.worktree_setups.lock().unwrap().is_empty());
}

#[test]
fn worktree_setup_registration_and_cancellation_are_isolated_and_repeatable() {
    let runtime = PiRuntime::default();
    let first = register_worktree_setup(&runtime).unwrap();
    let second = register_worktree_setup(&runtime).unwrap();
    assert_ne!(first, second); assert!(Uuid::parse_str(&first).is_ok()); assert!(Uuid::parse_str(&second).is_ok());
    let (first_signal, second_signal) = {
        let setups = runtime.worktree_setups.lock().unwrap();
        (setups[&first].clone(), setups[&second].clone())
    };
    assert!(!first_signal.load(Ordering::SeqCst)); assert!(!second_signal.load(Ordering::SeqCst));
    signal_worktree_setup_cancellation(&runtime, "missing").unwrap();
    for _ in 0..2 { signal_worktree_setup_cancellation(&runtime, &first).unwrap(); }
    assert!(first_signal.load(Ordering::SeqCst)); assert!(!second_signal.load(Ordering::SeqCst));
    assert_eq!(runtime.worktree_setups.lock().unwrap().len(), 2, "running setup owns registry removal");
    runtime.worktree_setups.lock().unwrap().remove(&first);
    signal_worktree_setup_cancellation(&runtime, &first).unwrap();
    assert_eq!(runtime.worktree_setups.lock().unwrap().len(), 1);
}

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
    let script = format!("require(\u{27}node:os\u{27}).homedir = () => process.argv[1];\n{}", include_str!("../resources/capture-git-tree.cjs"));
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
        let script = format!("require(\u{27}node:os\u{27}).homedir = () => process.argv[1];\n{}", include_str!("../resources/capture-git-tree.cjs"));
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
        (prepare_session_broker, "session-broker.ts", include_str!("../resources/session-broker.ts")),
        (prepare_trace_reader, "piop-trace-reader.ts", include_str!("../resources/trace-reader.ts")),
        (prepare_openai_cache_lineage_extension, "piop-openai-cache-lineage.ts", include_str!("../../extensions/piop-openai-cache-lineage/index.ts")),
        (prepare_codex_web_search_extension, "piop-codex-web-search.ts", include_str!("../../extensions/piop-codex-web-search/index.ts")),
    ];
    for (install, relative, expected) in installers {
        let home = TestDirectory::new();
        let _home = HomeOverride::take(&home.0);
        let target = home.0.join(STORAGE_DIRECTORY).join(relative);
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
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 2);
        fs::remove_file(&target).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "original directory").unwrap();
        assert!(install().is_err());
        assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "original directory");
    }
}

#[test]
fn hook_preparation_updates_bundles_without_changing_user_hooks() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let hooks = home.0.join(STORAGE_DIRECTORY).join("hooks");
    fs::create_dir_all(hooks.join("custom")).unwrap();
    fs::write(hooks.join("custom/index.ts"), "user hook").unwrap();
    for _ in 0..2 {
        let entry = prepare_hooks_extension().unwrap();
        assert_eq!(entry, home.0.join(STORAGE_DIRECTORY).join("hook-loader.ts"));
        assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../extensions/piop-hooks/index.ts"));
        let stats = entry.with_file_name("hook-stats.ts");
        assert_eq!(fs::read_to_string(&stats).unwrap(), include_str!("../../extensions/piop-hooks/hook-stats.ts"));
        assert_eq!(fs::read_to_string(hooks.join("custom/index.ts")).unwrap(), "user hook");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&hooks).unwrap().permissions().mode() & 0o777, 0o700);
            for path in [&entry, &stats] { assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600); }
        }
        fs::write(&entry, "old loader").unwrap();
        fs::write(&stats, "old stats").unwrap();
    }
    let blocked = TestDirectory::new();
    drop(_home);
    let _blocked = HomeOverride::take(&blocked.0);
    fs::create_dir_all(blocked.0.join(STORAGE_DIRECTORY)).unwrap();
    fs::write(blocked.0.join(STORAGE_DIRECTORY).join("hooks"), "keep").unwrap();
    assert!(prepare_hooks_extension().is_err());
    assert_eq!(fs::read_to_string(blocked.0.join(STORAGE_DIRECTORY).join("hooks")).unwrap(), "keep");
    assert!(!blocked.0.join(STORAGE_DIRECTORY).join("hook-loader.ts").exists());
}

#[test]
fn side_conversation_preparation_removes_only_the_legacy_extension_after_installing() {
    let home = TestDirectory::new();
    let _home = HomeOverride::take(&home.0);
    let entry = home.0.join(STORAGE_DIRECTORY).join("piop-btw.ts");
    let legacy = home.0.join(".pi/agent/extensions/pi-desktop-btw.ts");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, "old btw").unwrap();
    let other = legacy.with_file_name("user-extension.ts");
    fs::write(&other, "keep").unwrap();
    assert_eq!(prepare_btw_extension().unwrap(), entry);
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../resources/btw.ts"));
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
    assert_eq!(entry, home.0.join(STORAGE_DIRECTORY).join("piop-diff-watch/index.ts"));
    for _ in 0..2 {
        assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../extensions/piop-diff-watch/index.ts"));
        for (name, expected) in FILE_CHANGE_ASSETS {
            let path = entry.with_file_name(name);
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            }
            fs::write(&path, "outdated").unwrap();
        }
        prepare_diff_watch_extension().unwrap();
    }
    assert_eq!(fs::read_dir(entry.parent().unwrap()).unwrap().count(), 4, "no temporary files should remain");
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
    assert_eq!(entry, home.0.join(STORAGE_DIRECTORY).join("piop-define-agents/index.ts"));
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../extensions/piop-define-agents/index.ts"));
    let config = entry.with_file_name("config.json");
    assert!(!config.exists(), "legacy configuration migration is disabled in development builds");
    assert_eq!(fs::read(legacy.join("config.json")).unwrap(), original);
    assert_eq!(fs::read_to_string(legacy.join("notes.txt")).unwrap(), "keep");
    fs::write(&entry, "outdated extension").unwrap();
    prepare_defined_agents_extension().unwrap();
    assert_eq!(fs::read_to_string(&entry).unwrap(), include_str!("../../extensions/piop-define-agents/index.ts"));
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
        assert_eq!(actual, source.to_str().unwrap()); create_local_ephemeral_fork(&home.0, &temporary.0, actual)
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
    settings.mcp_servers = vec![json!({"id":"server","command":"node","args":["a b"],"env":{"TOKEN":"test-only-token"},"enabled":true})];
    for enabled in [true, false] {
        settings.context_window_cap = if enabled { 12345 } else { 2000 };
        settings.context_window_cap_enabled = enabled;
        if !enabled { settings.mcp_servers.clear(); settings.skills.clear(); settings.tools.clear(); }
        let (bridge, mcp) = prepare_mcp_bridge(&settings).unwrap();
        let runtime = prepare_runtime_settings(&settings).unwrap();
        let context = prepare_context_window_cap_extension(&settings).unwrap();
        assert_eq!(fs::read_to_string(&bridge).unwrap(), include_str!("../resources/mcp-bridge.bundle.mjs"));
        assert_eq!(fs::read_to_string(&runtime).unwrap(), include_str!("../../extensions/piop-runtime-settings/index.ts"));
        assert_eq!(fs::read_to_string(&context).unwrap(), include_str!("../../extensions/piop-context-window-cap/index.ts"));
        let mcp_value: Value = serde_json::from_slice(&fs::read(&mcp).unwrap()).unwrap();
        assert_eq!(mcp_value, json!(settings.mcp_servers));
        let runtime_config = runtime.with_file_name("runtime-settings.json");
        let runtime_value: Value = serde_json::from_slice(&fs::read(&runtime_config).unwrap()).unwrap();
        assert_eq!(runtime_value["tools"], if enabled { json!(["read"]) } else { json!([]) });
        assert_eq!(runtime_value["skills"], if enabled { json!(["/skill with spaces/SKILL.md"]) } else { json!([]) });
        assert_eq!(runtime_value["mcpServers"], mcp_value);
        assert_eq!(runtime_value["contextWindowCap"], settings.context_window_cap);
        assert_eq!(runtime_value["contextWindowCapEnabled"], enabled);
        let context_config = context.with_file_name("config.json");
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(&context_config).unwrap()).unwrap(), json!({"contextWindowCap":settings.context_window_cap,"enabled":enabled}));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            for file in [&bridge, &mcp, &runtime, &runtime_config, &context, &context_config] {
                assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
    }
}

#[test]
fn configuration_preparation_reports_failed_writes_and_cleans_temporary_files() {
    let settings = default_settings();
    for (relative, kind) in [("mcp-servers.json", 0), ("runtime-settings.json", 1), ("piop-context-window-cap/config.json", 2)] {
        let home = TestDirectory::new();
        let _home = HomeOverride::take(&home.0);
        let obstruction = home.0.join(STORAGE_DIRECTORY).join(relative);
        fs::create_dir_all(&obstruction).unwrap();
        fs::write(obstruction.join("keep"), "original").unwrap();
        let result = match kind {
            0 => prepare_mcp_bridge(&settings).map(|_| ()),
            1 => prepare_runtime_settings(&settings).map(|_| ()),
            _ => prepare_context_window_cap_extension(&settings).map(|_| ()),
        };
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(obstruction.join("keep")).unwrap(), "original");
        let files: Vec<_> = fs::read_dir(obstruction.parent().unwrap()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(files.len(), if kind == 1 { 3 } else { 2 }, "failed writes must not leave temporary files: {files:?}");
        if kind == 1 { assert!(files.contains(&std::ffi::OsString::from("provider-accounts.mjs"))); }
    }
}
