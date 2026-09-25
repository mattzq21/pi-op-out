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
    settings.keybindings.insert("newConversation".into(), "Ctrl+G".into());
    assert!(validate_settings_for_save(&settings).is_err()); settings.keybindings = default_keybindings();
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
        let result = remove_worktree_target(&settings, "local", target, scenario != "keep", &AtomicBool::new(false)).unwrap();
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
        assert!(remove_worktree_target(&settings, "local", target, true, &AtomicBool::new(false)).is_err());
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
