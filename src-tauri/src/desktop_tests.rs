use super::*;

#[test]
fn conversation_window_targets_require_a_nonblank_string_session_id() {
    for target in [Value::Null, json!({}), json!({"sessionId":null}), json!({"sessionId":7}), json!({"sessionId":""}), json!({"sessionId":" \n\t"})] {
        assert_eq!(conversation_window_target(&target).unwrap_err(), "Select a conversation to open in another window");
    }
}

#[test]
fn conversation_window_targets_round_trip_special_characters_without_extra_query_fields() {
    let target = json!({
        "sessionId":"session & # ? = + / \u{3bb}",
        "sessionPath":"/project\u{27}s files/a?b#c.jsonl",
        "hostId":"remote",
        "name":"hello\n\u{4e16}\u{754c}",
        "nested":{"value":"%26target=other"}
    });
    let (first, path) = conversation_window_target(&target).unwrap();
    let (second, _) = conversation_window_target(&target).unwrap();
    assert_ne!(first, second);
    assert!(Uuid::parse_str(first.strip_prefix("chat-").unwrap()).is_ok());
    assert!(Uuid::parse_str(second.strip_prefix("chat-").unwrap()).is_ok());
    let url = tauri::Url::parse("https://piop.invalid/").unwrap().join(&path).unwrap();
    assert_eq!(url.path(), "/index.html");
    assert!(url.fragment().is_none());
    let parameters = url.query_pairs().collect::<Vec<_>>();
    assert_eq!(parameters.len(), 1);
    assert_eq!(parameters[0].0, "target");
    assert_eq!(serde_json::from_str::<Value>(&parameters[0].1).unwrap(), target);
}

include!("test_directory.rs");

#[test]
fn external_url_opening_rejects_non_web_schemes_before_invoking_the_system_opener() {
    for url in ["", "relative/path", "https://", "http://[invalid"] {
        assert_eq!(open_external_url_with(url, |_| panic!("invalid URL opened")).unwrap_err(), "Enter a valid HTTP or HTTPS URL");
    }
    for url in ["file:///tmp/file", "javascript:alert(1)", "data:text/html,hello", "mailto:user@example.com", "ftp://example.com/file"] {
        assert_eq!(open_external_url_with(url, |_| panic!("non-web URL opened")).unwrap_err(), "Only HTTP and HTTPS links can be opened in the browser");
    }
}

#[test]
fn external_url_opening_preserves_encoded_targets_and_propagates_launcher_failures() {
    for (url, expected) in [
        ("HTTPS://Example.COM:443/a b?x=1&y=2#section", "https://example.com/a%20b?x=1&y=2#section"),
        ("http://localhost:8080/path", "http://localhost:8080/path"),
        ("https://example.com/?q=%26%3D%23", "https://example.com/?q=%26%3D%23"),
    ] {
        open_external_url_with(url, |target| {
            assert_eq!(target, std::ffi::OsStr::new(expected)); Ok(())
        }).unwrap();
    }
    assert_eq!(open_external_url_with("https://example.com", |_| Err("launcher unavailable".into())).unwrap_err(), "launcher unavailable");
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
