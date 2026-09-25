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

