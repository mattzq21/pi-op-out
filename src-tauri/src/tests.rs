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
