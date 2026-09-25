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
        let result = crate::platform::async_runtime::block_on(execute_worktree_setup(&runtime, &id, move |cancelled| {
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
    assert_eq!(crate::platform::async_runtime::block_on(execute_worktree_setup(&runtime, "unknown",
        |_| panic!("unknown job executed"))).unwrap_err(), "Unknown setup");
    let id = register_worktree_setup(&runtime).unwrap();
    let (started, ready) = mpsc::channel(); let (release, proceed) = mpsc::channel();
    let worker_runtime = runtime.clone(); let worker_id = id.clone();
    let worker = thread::spawn(move || crate::platform::async_runtime::block_on(execute_worktree_setup(&worker_runtime, &worker_id, move |cancelled| {
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
