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
    let path = create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", None, |script| {
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
        assert!(create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", None, shell).is_err());
        assert!(!destination.exists()); assert_eq!(fs::read_to_string(&source).unwrap(), content);
    }
    fs::write(&source, "{\"type\":\"session\"}\n").unwrap(); fs::write(&destination, "existing").unwrap();
    assert!(create_remote_ephemeral_fork(source.to_str().unwrap(), destination.to_str().unwrap(), "fixture", None, shell).unwrap_err().contains("EEXIST"));
    assert_eq!(fs::read_to_string(&destination).unwrap(), "existing");
    assert!(create_remote_ephemeral_fork("unused", "unused", "fixture", None, |_| Command::new("/missing/piop-test")).unwrap_err().contains("Could not create temporary side conversation on fixture"));
    let error = create_remote_ephemeral_fork("unused", "unused", "fixture", None, |_| {
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
fn remote_temporary_chat_removal_preserves_contents_and_rejects_symlinks() {
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
    remove(&unmarked).unwrap(); assert!(!unmarked.exists());
    assert!(remove(&outside).is_err()); assert!(outside.is_dir());
    remove(&marked).unwrap(); assert_eq!(fs::read_to_string(marked.join("content")).unwrap(), "remove");
    fs::remove_file(marked.join("content")).unwrap(); remove(&marked).unwrap(); assert!(!marked.exists());
    assert_eq!(fs::read_to_string(sibling.join("keep")).unwrap(), "preserve");
    remove(&marked).unwrap();
    let link = home.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string()); symlink(&outside, &link).unwrap();
    assert!(remove(&link).is_err()); assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
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
fn remote_temporary_chat_creates_empty_isolated_directories_and_preserves_existing_contents() {
    let directory = TestDirectory::new(); let home = directory.0.join("home ' λ $(false)"); fs::create_dir(&home).unwrap();
    let create = |id: &str| create_remote_temporary_chat(id, "Server", |script| {
        let mut command = Command::new("sh"); command.args(["-c", &script]).env("HOME", &home); command
    });
    let first_id = Uuid::new_v4().to_string(); let second_id = Uuid::new_v4().to_string();
    let first = PathBuf::from(create(&first_id).unwrap()); let second = PathBuf::from(create(&second_id).unwrap());
    assert_eq!(first, home.join(STORAGE_DIRECTORY).join("tmp").join(&first_id));
    assert_eq!(second, home.join(STORAGE_DIRECTORY).join("tmp").join(&second_id));
    for path in [&first, &second] {
        assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    }
    fs::write(first.join("user-file"), "keep").unwrap();
    assert_eq!(create(&first_id).unwrap(), first.to_str().unwrap());
    assert_eq!(fs::read_to_string(first.join("user-file")).unwrap(), "keep");
    assert_eq!(fs::read_dir(&second).unwrap().count(), 0);
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
fn temporary_chat_removal_preserves_contents_and_removes_only_empty_directories() {
    let home = TestDirectory::new();
    let first = create_local_temporary_chat(&home.0, &Uuid::new_v4().to_string()).unwrap();
    let second = create_local_temporary_chat(&home.0, &Uuid::new_v4().to_string()).unwrap();
    fs::create_dir(first.join("nested")).unwrap(); fs::write(first.join("nested/file"), "temporary content").unwrap();
    fs::write(second.join("keep"), "other chat").unwrap();
    remove_local_temporary_chat(&home.0, first.to_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(first.join("nested/file")).unwrap(), "temporary content");
    assert_eq!(fs::read_to_string(second.join("keep")).unwrap(), "other chat");
    fs::remove_file(first.join("nested/file")).unwrap(); fs::remove_dir(first.join("nested")).unwrap();
    remove_local_temporary_chat(&home.0, first.to_str().unwrap()).unwrap(); assert!(!first.exists());
    remove_local_temporary_chat(&home.0, first.to_str().unwrap()).unwrap();
}

#[test]
fn temporary_chat_removal_preserves_legacy_markers_and_rejects_wrong_roots_and_non_uuid_directories() {
    let home = TestDirectory::new(); let other_home = TestDirectory::new();
    let outside = create_local_temporary_chat(&other_home.0, &Uuid::new_v4().to_string()).unwrap();
    assert_eq!(remove_local_temporary_chat(&home.0, outside.to_str().unwrap()).unwrap_err(), "Refusing to remove a directory outside the temporary chat root");
    assert!(outside.is_dir());
    let unmarked = home.0.join(STORAGE_DIRECTORY).join("tmp").join(Uuid::new_v4().to_string());
    fs::create_dir_all(&unmarked).unwrap(); fs::write(unmarked.join("keep"), "keep").unwrap();
    remove_local_temporary_chat(&home.0, unmarked.to_str().unwrap()).unwrap();
    fs::create_dir(unmarked.join(".pi-desktop-temporary-chat")).unwrap();
    remove_local_temporary_chat(&home.0, unmarked.to_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(unmarked.join("keep")).unwrap(), "keep");
    let named = home.0.join(STORAGE_DIRECTORY).join("tmp/project"); fs::create_dir(&named).unwrap();
    fs::write(named.join(".pi-desktop-temporary-chat"), "").unwrap();
    assert_eq!(remove_local_temporary_chat(&home.0, named.to_str().unwrap()).unwrap_err(), "Refusing to remove a directory not created as a temporary chat");
    assert!(named.is_dir());
}

#[test]
fn temporary_chats_create_empty_directories_and_validate_their_location() {
    let root = TestDirectory::new();
    let id = "12345678-1234-4123-8123-123456789abc";
    let path = create_local_temporary_chat(&root.0, id).unwrap();
    assert_eq!(path, root.0.join(STORAGE_DIRECTORY).join("tmp").join(id));
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
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
    let remote = RemoteHost { enabled: true, id: "remote".into(), name: "Remote".into(), target: "unused.invalid".into(), pi_path: "pi".into() };
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
