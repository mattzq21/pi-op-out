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
    assert_eq!(canonical_shortcut("F2").unwrap(), Some("f2".into()));
    assert_eq!(canonical_shortcut(" + ").unwrap(), None);
    for invalid in ["Ctrl", "n", "Shift+é", "🦆"] { assert!(canonical_shortcut(invalid).is_err(), "{invalid}"); }
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
