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
            session_path: use_path.then(|| path.to_string_lossy().into_owned()), worktree: None, presence_id: None, working: false, messageable: true,
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
