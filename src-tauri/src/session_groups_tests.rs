use super::*;
use crate::tests::TestDirectory;
use serde_json::json;

#[test]
fn concurrent_group_changes_persist_every_update_before_notifying() {
    use std::sync::{Arc, Barrier};
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    load_at(&path, vec![], SessionGroups::default()).unwrap();
    let barrier = Arc::new(Barrier::new(12));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    std::thread::scope(|scope| {
        for index in 0..12 {
            let barrier = barrier.clone(); let notifications = notifications.clone(); let path = &path;
            scope.spawn(move || {
                barrier.wait();
                let state = change_with(GroupChange::Create { name: format!("Group {index}") }, || Ok(path.clone()), |state| {
                    let persisted = read(path).unwrap().unwrap();
                    assert_eq!(serde_json::to_value(&persisted).unwrap(), serde_json::to_value(state).unwrap());
                    notifications.lock().unwrap().push(state.groups.len());
                }).unwrap();
                assert!(state.groups.iter().any(|group| group.name == format!("Group {index}")));
            });
        }
    });
    assert_eq!(*notifications.lock().unwrap(), (1..=12).collect::<Vec<_>>());
    let state = read(&path).unwrap().unwrap();
    assert_eq!(state.groups.len(), 12);
    assert_eq!(state.groups.iter().map(|group| group.id.clone()).collect::<HashSet<_>>().len(), 12);
    for index in 0..12 { assert!(state.groups.iter().any(|group| group.name == format!("Group {index}"))); }
    assert!(path.with_extension("lock").is_file());
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
}

#[test]
fn failed_group_changes_do_not_notify_and_release_the_storage_lock() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    let change = || GroupChange::Create { name: "First".into() };
    assert_eq!(change_with(change(), || Err("storage unavailable".into()), |_| panic!("failed path notified")).err().unwrap(), "storage unavailable");
    assert!(change_with(change(), || Ok(path.clone()), |_| panic!("uninitialized storage notified")).is_err());
    fs::write(&path, "corrupt").unwrap();
    assert!(change_with(change(), || Ok(path.clone()), |_| panic!("corrupt storage notified")).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt");
    fs::remove_file(&path).unwrap(); load_at(&path, vec![], SessionGroups::default()).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(change_with(GroupChange::Create { name: " ".into() }, || Ok(path.clone()), |_| panic!("invalid change notified")).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let mut notified = false;
    let state = change_with(change(), || Ok(path.clone()), |state| { notified = true; assert_eq!(state.groups[0].name, "First"); }).unwrap();
    assert!(notified); assert_eq!(state.groups.len(), 1);
}

#[test]
fn assignment_lookup_is_host_specific_and_preserves_other_session_fields() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    let state = SessionGroups {
        groups: vec![project("first", "First", None), project("second", "Second", None)],
        assignments: HashMap::from([("local:shared".into(), Some("first".into())), ("remote:shared".into(), Some("second".into())), ("local:ungrouped".into(), None)]),
        removed_projects: HashSet::new(),
    };
    write(&path, &state).unwrap();
    let mut sessions = vec![
        crate::tests::test_session("local", "shared", "/local.jsonl"),
        crate::tests::test_session("remote", "shared", "/remote.jsonl"),
        crate::tests::test_session("local", "ungrouped", "/ungrouped.jsonl"),
        crate::tests::test_session("local", "unknown", "/unknown.jsonl"),
    ];
    for session in &mut sessions { session.group_id = Some("stale".into()); }
    let before = sessions.clone();
    attach_assignments_at(&mut sessions, &path).unwrap();
    for (index, expected) in [Some("first"), Some("second"), None, None].into_iter().enumerate() {
        let mut expected_session = before[index].clone(); expected_session.group_id = expected.map(str::to_owned);
        assert_eq!(serde_json::to_value(&sessions[index]).unwrap(), serde_json::to_value(expected_session).unwrap());
    }
    assert_eq!(serde_json::to_value(read(&path).unwrap().unwrap()).unwrap(), serde_json::to_value(state).unwrap());
}

#[test]
fn assignment_lookup_handles_absent_and_unreadable_storage_without_mutating_sessions() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    let mut sessions = vec![crate::tests::test_session("local", "one", "/one.jsonl")];
    sessions[0].group_id = Some("existing".into());
    let original = serde_json::to_value(&sessions).unwrap();
    attach_assignments_at(&mut sessions, &path).unwrap();
    assert_eq!(serde_json::to_value(&sessions).unwrap(), original);
    assert!(!path.exists());
    fs::write(&path, "invalid json").unwrap();
    assert!(attach_assignments_at(&mut sessions, &path).unwrap_err().starts_with("Could not read session groups:"));
    assert_eq!(serde_json::to_value(&sessions).unwrap(), original);
    fs::remove_file(&path).unwrap(); fs::create_dir(&path).unwrap();
    assert!(attach_assignments_at(&mut sessions, &path).is_err());
    assert_eq!(serde_json::to_value(&sessions).unwrap(), original);
    assert!(write(&path, &SessionGroups::default()).unwrap_err().starts_with("Could not save session groups:"));
}

fn project(id: &str, name: &str, cwd: Option<&str>) -> SessionGroup {
    SessionGroup { id: id.into(), name: name.into(), cwd: cwd.map(str::to_owned), host_id: Some("local".into()), host_name: None, project_kind: None }
}

#[test]
fn removing_projects_ungroups_existing_sessions_but_allows_new_discovery() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    load_at(&path, vec![], SessionGroups::default()).unwrap();
    let make_project = || project("local:/repo", "Repository", Some("/repo"));
    change_at(&path, GroupChange::Project { project: make_project(), key: Some("local:first".into()) }).unwrap();
    let removed = change_at(&path, GroupChange::Remove { id: "local:/repo".into() }).unwrap();
    assert!(removed.groups.is_empty()); assert!(removed.removed_projects.is_empty());
    assert_eq!(removed.assignments["local:first"], None);
    let discovered = load_at(&path, vec![SessionSeed { session_key: "local:second".into(), project: make_project() }], SessionGroups::default()).unwrap();
    assert_eq!(discovered.groups.len(), 1); assert_eq!(discovered.assignments["local:second"].as_deref(), Some("local:/repo"));
    let restored = change_at(&path, GroupChange::Project { project: make_project(), key: Some("local:first".into()) }).unwrap();
    assert_eq!(restored.groups.len(), 1); assert!(restored.removed_projects.is_empty());
    assert_eq!(restored.assignments["local:first"].as_deref(), Some("local:/repo"));
    assert_eq!(restored.assignments["local:second"].as_deref(), Some("local:/repo"));
    change_at(&path, GroupChange::Assign { key: "local:first".into(), group: None }).unwrap();
    let reloaded = load_at(&path, vec![SessionSeed { session_key: "local:first".into(), project: make_project() }], SessionGroups::default()).unwrap();
    assert_eq!(reloaded.assignments["local:first"], None, "discovery must preserve explicit ungrouping");
}

#[test]
fn project_metadata_updates_keep_user_names_and_do_not_duplicate_groups() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    load_at(&path, vec![], SessionGroups::default()).unwrap();
    change_at(&path, GroupChange::Project { project: project("local:/repo", "My name", Some("/repo")), key: None }).unwrap();
    let mut updated = project("local:/repo", "Discovered name", Some("/repo"));
    updated.project_kind = Some(crate::ProjectKind::Worktree);
    let state = change_at(&path, GroupChange::Project { project: updated, key: None }).unwrap();
    assert_eq!(state.groups.len(), 1); assert_eq!(state.groups[0].name, "My name");
    assert!(matches!(state.groups[0].project_kind, Some(crate::ProjectKind::Worktree)));
    let state = change_at(&path, GroupChange::Project { project: project("local:/repo", "Other", Some("/repo")), key: None }).unwrap();
    assert!(matches!(state.groups[0].project_kind, Some(crate::ProjectKind::Worktree)));
    let state = load_at(&path, vec![SessionSeed { session_key: "local:new".into(), project: project("local:/repo", "Other", Some("/repo")) }], SessionGroups::default()).unwrap();
    assert_eq!(state.groups.len(), 1); assert_eq!(state.assignments["local:new"].as_deref(), Some("local:/repo"));
    let other = change_at(&path, GroupChange::Create { name: "Other".into() }).unwrap().groups[0].id.clone();
    let before = fs::read(&path).unwrap();
    assert!(change_at(&path, GroupChange::Rename { id: other, name: "MY NAME".into() }).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(change_at(&path, GroupChange::Rename { id: "local:/repo".into(), name: "MY NAME".into() }).is_ok());
}

#[test]
fn loading_migrates_legacy_groups_and_preserves_explicit_assignments() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    let legacy = SessionGroups {
        groups: vec![project("local:/repo/", "Workspace", Some("/repo/"))],
        assignments: HashMap::from([("local:ungrouped".into(), None), ("local:stale".into(), Some("deleted".into()))]),
        removed_projects: HashSet::from(["local:/forgotten".into()]),
    };
    let seeds = vec![
        SessionSeed { session_key: "local:ungrouped".into(), project: project("local:/repo/", "Workspace", Some("/repo/")) },
        SessionSeed { session_key: "local:new".into(), project: project("local:/new", "New", Some("/new")) },
        SessionSeed { session_key: "local:forgotten".into(), project: project("local:/forgotten", "Forgotten", Some("/forgotten")) },
    ];
    let state = load_at(&path, seeds, legacy).unwrap();
    assert_eq!(state.groups.len(), 3); assert_eq!(state.groups[0].name, "Forgotten"); assert_eq!(state.groups[1].name, "New"); assert_eq!(state.groups[2].name, "repo");
    assert_eq!(state.assignments["local:new"].as_deref(), Some("local:/new"));
    for key in ["local:ungrouped", "local:stale"] { assert_eq!(state.assignments[key], None); }
    assert_eq!(state.assignments["local:forgotten"].as_deref(), Some("local:/forgotten"));
    assert!(state.removed_projects.is_empty());
    let reloaded = load_at(&path, vec![], SessionGroups::default()).unwrap();
    assert_eq!(serde_json::to_value(reloaded).unwrap(), serde_json::to_value(state).unwrap());
}

#[test]
fn group_changes_persist_creation_renaming_assignment_and_removal() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    assert!(change_at(&path, GroupChange::Create { name: "First".into() }).err().unwrap().contains("not loaded"));
    load_at(&path, vec![], SessionGroups::default()).unwrap();
    let state = change_at(&path, GroupChange::Create { name: " First ".into() }).unwrap();
    let id = state.groups[0].id.clone(); assert_eq!(state.groups[0].name, "First");
    assert!(id.starts_with("__pi-desktop-custom-group__:"));
    change_at(&path, GroupChange::Assign { key: "local:chat".into(), group: Some(id.clone()) }).unwrap();
    let renamed = change_at(&path, GroupChange::Rename { id: id.clone(), name: " Renamed ".into() }).unwrap();
    assert_eq!(renamed.groups[0].name, "Renamed"); assert_eq!(renamed.assignments["local:chat"], Some(id.clone()));
    let removed = change_at(&path, GroupChange::Remove { id }).unwrap();
    assert!(removed.groups.is_empty()); assert_eq!(removed.assignments["local:chat"], None); assert!(removed.removed_projects.is_empty());
    assert_eq!(serde_json::to_value(read(&path).unwrap().unwrap()).unwrap(), serde_json::to_value(removed).unwrap());
}

#[test]
fn invalid_group_changes_leave_persisted_state_untouched() {
    let directory = TestDirectory::new(); let path = directory.0.join("groups.json");
    load_at(&path, vec![], SessionGroups::default()).unwrap();
    let state = change_at(&path, GroupChange::Create { name: "Existing".into() }).unwrap();
    let id = state.groups[0].id.clone();
    let before = fs::read(&path).unwrap();
    for change in [
        GroupChange::Create { name: " ".into() }, GroupChange::Create { name: "eXISTING".into() },
        GroupChange::Rename { id: id.clone(), name: " ".into() }, GroupChange::Rename { id: "missing".into(), name: "Name".into() },
        GroupChange::Remove { id: "missing".into() }, GroupChange::Assign { key: "local:chat".into(), group: Some("missing".into()) },
        GroupChange::Project { project: project("bad", "Bad", None), key: None },
    ] {
        assert!(change_at(&path, change).is_err()); assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn persisted_groups_round_trip_project_metadata_and_explicit_ungrouping() {
    let directory = TestDirectory::new();
    let path = directory.0.join("nested/groups.json");
    assert!(read(&path).unwrap().is_none());
    let value = json!({
        "groups": [{"id":"remote:/repo","name":"Project α","cwd":"/repo","hostId":"remote","hostName":"Server","projectKind":"worktree"}],
        "assignments": {"remote:one":"remote:/repo","local:two":null},
        "removedProjects": ["local:/forgotten"]
    });
    let groups: SessionGroups = serde_json::from_value(value.clone()).unwrap();
    write(&path, &groups).unwrap();
    assert_eq!(serde_json::to_value(read(&path).unwrap().unwrap()).unwrap(), value);
    write(&path, &SessionGroups::default()).unwrap();
    let replacement = read(&path).unwrap().unwrap();
    assert!(replacement.groups.is_empty());
    assert!(replacement.assignments.is_empty());
    assert!(replacement.removed_projects.is_empty());
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "atomic writes must not leave temporary files");
}

#[test]
fn corrupt_or_unreadable_group_storage_is_reported_instead_of_treated_as_empty() {
    let directory = TestDirectory::new();
    let path = directory.0.join("groups.json");
    for body in ["not json", "null", "{}", "{\"groups\":42}"] {
        fs::write(&path, body).unwrap();
        let error = read(&path).err().expect("invalid storage must fail");
        assert!(error.starts_with("Could not read session groups:"));
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
    }
    assert!(read(&directory.0).err().unwrap().starts_with("Could not read session groups:"));
    assert!(write(&path.join("child.json"), &SessionGroups::default()).unwrap_err().starts_with("Could not save session groups:"));
}

#[cfg(unix)]
#[test]
fn group_storage_repairs_permissions_even_when_content_is_unchanged() {
    use std::os::unix::fs::PermissionsExt;
    let directory = TestDirectory::new();
    let path = directory.0.join("private/groups.json");
    let groups = SessionGroups::default();
    write(&path, &groups).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    write(&path, &groups).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    assert!(read(&path).unwrap().is_some());
}
