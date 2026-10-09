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
    let host = RemoteHost { enabled: true, id:"remote".into(), name:"Build server".into(), target:"unused.invalid".into(), pi_path:"pi".into() };
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
