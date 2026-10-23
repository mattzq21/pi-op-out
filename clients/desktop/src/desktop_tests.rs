use super::*;

include!("test_directory.rs");

#[test]
fn dropped_files_preserve_binary_data_and_enforce_file_type_and_size_limits() {
    let read = |path: &std::path::Path| tauri::async_runtime::block_on(read_dropped_file(path.to_string_lossy().into_owned()));
    let root = TestDirectory::new();
    let path = root.0.join("attachment.bin"); fs::write(&path, [0, 255, 128, 10]).unwrap();
    assert_eq!(read(&path).unwrap(), json!({"name":"attachment.bin","data":[0,255,128,10]}));
    assert_eq!(read(&root.0).unwrap_err(), "Drop regular files only");
    assert!(read(&root.0.join("missing")).is_err());
    let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(10 * 1024 * 1024 + 1).unwrap();
    assert_eq!(read(&path).unwrap_err(), "Attachment is larger than 10 MB");
    file.set_len(10 * 1024 * 1024).unwrap();
    assert_eq!(read(&path).unwrap()["data"].as_array().unwrap().len(), 10 * 1024 * 1024);
}

#[test]
#[ignore = "Test-only command bridge launched by the UI integration tests"]
fn attachment_command_bridge() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let path = std::env::var("PIOP_TEST_NATIVE_SOCKET").expect("native test socket path");
    let listener = UnixListener::bind(&path).expect("bind native test socket");
    let app = if std::env::var_os("PIOP_TEST_NATIVE_APP").is_some() {
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        if let Ok(url) = std::env::var("PIOP_TEST_NATIVE_URL") {
            let url = tauri::Url::parse(&url).expect("test document URL");
            assert_eq!(url.host_str(), Some("127.0.0.1"));
            context.config_mut().build.dev_url = Some(url.clone());
            context.config_mut().build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(url));
        }
        Some(tauri::Builder::default().any_thread().manage(desktop_daemon::DesktopDaemon::default()).build(context).expect("build native test app"))
    } else { None };
    println!("PIOP_TEST_NATIVE_READY");
    let serve = move |handle: Option<AppHandle>| {
    // Events the app sends to its windows, for tests of the daemon connection.
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    if let Some(app) = handle.as_ref() {
        use tauri::Listener;
        for name in ["pi://event", "pi://daemon-error", "pi://daemon-restarting", "pi://daemon-log-status"] {
            let events = events.clone();
            app.listen_any(name, move |event| {
                let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
                events.lock().unwrap().push(json!({ "event": name, "payload": payload }));
            });
        }
    }
    let daemon_window = |app: &AppHandle| match app.get_webview_window("daemon-test") {
        Some(window) => Ok(window),
        None => tauri::WebviewWindowBuilder::new(app, "daemon-test", tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap())).visible(false).build(),
    }.map_err(|error| error.to_string());
    let (mut stream, _) = listener.accept().expect("connect native test client");
    // A Rust listener that blocks keeps Tauri's event handlers locked, as a slow listener does while another event is sent.
    let mut held_dispatch: Option<(std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>)> = None;
    for line in BufReader::new(stream.try_clone().unwrap()).lines() {
        let request: Value = serde_json::from_str(&line.expect("read native test request")).unwrap();
        let result = match request["command"].as_str() {
            Some("hold_event_dispatch") => {
                use tauri::Listener;
                let app = handle.as_ref().expect("desktop test app").clone();
                let (entered_sender, entered) = std::sync::mpsc::channel();
                let (release, released) = std::sync::mpsc::channel::<()>();
                let released = std::sync::Mutex::new(Some(released));
                app.listen_any("piop-test://hold", move |_| {
                    let Some(released) = released.lock().unwrap().take() else { return };
                    entered_sender.send(()).unwrap();
                    let _ = released.recv();
                });
                let emitter = std::thread::spawn(move || { app.emit("piop-test://hold", ()).expect("hold event dispatch"); });
                entered.recv_timeout(std::time::Duration::from_secs(5)).expect("event dispatch held");
                held_dispatch = Some((release, emitter));
                Ok(Value::Null)
            },
            Some("release_event_dispatch") => match held_dispatch.take() {
                Some((release, emitter)) => {
                    let _ = release.send(());
                    emitter.join().map(|_| Value::Null).map_err(|_| "The held event dispatch failed".to_owned())
                },
                None => Err("No event dispatch is held".to_owned()),
            },
            Some("daemon_invoke") => {
                let app = handle.as_ref().expect("desktop test app");
                daemon_window(app).and_then(|window| tauri::async_runtime::block_on(desktop_daemon::daemon_invoke(
                    app.clone(), window, request["daemonCommand"].as_str().expect("daemon command").to_owned(), request["args"].clone(),
                )))
            },
            Some("daemon_events") => Ok(Value::Array(events.lock().unwrap().clone())),
            Some("daemon_log_statuses") => {
                let app = handle.as_ref().expect("desktop test app");
                let window = match app.get_webview_window("status-test") {
                    Some(window) => Ok(window),
                    None => tauri::WebviewWindowBuilder::new(app, "status-test", tauri::WebviewUrl::External(tauri::Url::parse("about:blank").unwrap())).visible(false).build(),
                };
                window.map_err(|error| error.to_string()).map(|window| json!(tauri::async_runtime::block_on(daemon_log_statuses(app.clone(), window))))
            },
            Some("load_client_settings") => tauri::async_runtime::block_on(load_client_settings()),
            Some("save_client_settings") => tauri::async_runtime::block_on(save_client_settings(
                handle.as_ref().expect("desktop test app").clone(),
                serde_json::from_value(request["settings"].clone()).expect("client settings"),
                serde_json::from_value(request["baseline"].clone()).expect("client settings baseline"),
                request["initialize"].as_bool(),
            )),
            Some("new_window") => new_window(
                handle.as_ref().expect("desktop test app").clone(), request["target"].clone(),
            ).map(Value::String),
            Some("read_dropped_file") => tauri::async_runtime::block_on(read_dropped_file(request["path"].as_str().expect("file path").to_owned())),
            Some("open_external_url") => tauri::async_runtime::block_on(open_external_url(
                request["url"].as_str().expect("web URL").to_owned(),
            )).map(|_| Value::Null),
            Some("open_project_directory") => tauri::async_runtime::block_on(open_project_directory(
                request["cwd"].as_str().expect("project path").to_owned(),
                request["hostId"].as_str().map(str::to_owned),
            )).map(|_| Value::Null),
            _ => Err("Unsupported native test command".to_owned()),
        };
        let response = match result {
            Ok(value) => json!({ "id": request["id"], "result": value }),
            Err(error) => json!({ "id": request["id"], "error": error }),
        };
        writeln!(stream, "{}", response).expect("write native test response");
    }
    if let Some((release, emitter)) = held_dispatch.take() {
        let _ = release.send(());
        emitter.join().expect("event dispatch thread");
    }
    std::fs::remove_file(path).expect("remove native test socket");
    if let Some(handle) = handle { handle.exit(0); }
    };
    if let Some(app) = app {
        let handle = app.handle().clone();
        let worker = std::thread::spawn(move || serve(Some(handle)));
        assert_eq!(app.run_return(|_, _| {}), 0);
        worker.join().expect("native command bridge thread");
    } else { serve(None); }
}
