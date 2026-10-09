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
