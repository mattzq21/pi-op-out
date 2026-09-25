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
    start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "interactive".into(), session_key: "session".into(), cwd: "/tmp".into(), cols: 0, rows: 0, host_id: "local".into(), window_label: "window".into() },
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
fn stopping_a_started_terminal_suppresses_stale_events_and_preserves_other_processes() {
    let runtime = TestTerminals(TerminalRuntime::default());
    let _other_input = runtime.add("other");
    let (sender, events) = mpsc::channel();
    start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "stop-me".into(), session_key: "another-session".into(), cwd: "/tmp".into(), cols: 80, rows: 24, host_id: "local".into(), window_label: "window".into() },
        || { let mut command = CommandBuilder::new("sh"); command.args(["-c", "printf READY; exec sleep 60"]); Ok(command) },
        move |packet| { let _ = sender.send(packet); }).unwrap();
    let packet = events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(packet["type"], "terminal_output");
    stop_terminals(&runtime.0, &["stop-me".into()]).unwrap();
    assert_eq!(events.recv_timeout(Duration::from_secs(3)).unwrap_err(), mpsc::RecvTimeoutError::Disconnected);
    let processes = runtime.0.processes.lock().unwrap();
    assert_eq!(processes.len(), 1); assert!(processes.contains_key("other"));
}

#[cfg(unix)]
#[test]
fn terminal_startup_streams_shell_output_and_removes_finished_process() {
    let runtime = TestTerminals(TerminalRuntime::default());
    let (sender, events) = mpsc::channel();
    start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "terminal".into(), session_key: "session".into(), cwd: "/tmp".into(), cols: 0, rows: 0, host_id: "local".into(), window_label: "window".into() },
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
    start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "terminal-0".into(), session_key: "session".into(), cwd: "/tmp".into(), cols: 80, rows: 24, host_id: "local".into(), window_label: "main".into() },
        || panic!("duplicate must not launch"), |_| panic!("duplicate emitted")).unwrap();
    let error = start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "extra".into(), session_key: "session".into(), cwd: "/tmp".into(), cols: 80, rows: 24, host_id: "local".into(), window_label: "window".into() },
        || panic!("limit must prevent launch"), |_| panic!("limit emitted")).unwrap_err();
    assert!(error.contains("At most"));
    for failure in ["build", "spawn"] {
        let temporary = TestDirectory::new();
        let error = start_terminal_with(&runtime.0, TerminalLaunch { terminal_id: "other".into(), session_key: "other-session".into(), cwd: "/tmp".into(), cols: 80, rows: 24, host_id: "local".into(), window_label: "window".into() },
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
            generation: Uuid::new_v4(),
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
