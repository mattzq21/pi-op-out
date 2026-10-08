use super::*;
use tokio_tungstenite::tungstenite::handshake::server::{Callback, Request, Response};

#[test]
fn identity_requires_host_login_and_rejects_funnel_and_foreign_origins() {
    for login in [None, Some("other@example.com"), Some("owner@example.com")] {
        for origin in [None, Some("https://localhost"), Some("capacitor://localhost"), Some("https://evil.example"), Some("http://localhost")] {
            for funnel in [false, true] {
                let mut request = Request::builder().uri("/");
                if let Some(login) = login { request = request.header("tailscale-user-login", login); }
                if let Some(origin) = origin { request = request.header("origin", origin); }
                if funnel { request = request.header("tailscale-funnel-request", ""); }
                let response = Response::builder().status(101).body(()).unwrap();
                let result = TailscaleIdentity { login: "owner@example.com".into() }.on_request(&request.body(()).unwrap(), response);
                let allowed = login == Some("owner@example.com") && !funnel && matches!(origin, None | Some("https://localhost" | "capacitor://localhost"));
                if allowed { assert_eq!(result.unwrap().status(), 101); }
                else { assert_eq!(result.unwrap_err().status(), 403); }
            }
        }
    }
}

#[tokio::test]
async fn authentication_requires_both_packet_type_and_tailscale_mode() {
    use tokio_tungstenite::tungstenite::protocol::Role;
    for packet in [json!({"type":"authenticate", "mode":"tailscale"}), json!({"type":"command", "mode":"tailscale"}), json!({"type":"authenticate", "mode":"token"}), json!({})] {
        let (server, client) = tokio::net::UnixStream::pair().unwrap();
        let mut server = tokio_tungstenite::WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let mut client = tokio_tungstenite::WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        client.send(Message::Text(packet.to_string().into())).await.unwrap();
        let result = authenticate_mode(&mut server).await;
        assert_eq!(result.is_ok(), packet["type"] == "authenticate" && packet["mode"] == "tailscale");
    }
}

#[test]
fn socket_cleanup_removes_only_sockets_and_propagates_path_errors() {
    let directory = std::env::temp_dir().join(format!("piop-auth-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("socket");
    assert!(remove_previous_socket(&path).is_ok());
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    remove_previous_socket(&path).unwrap();
    assert!(!path.exists());
    drop(listener);
    fs::write(&path, "keep me").unwrap();
    assert!(remove_previous_socket(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep me");
    assert!(remove_previous_socket(&path.join("invalid")).is_err());
    let link = directory.join("symlink");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(remove_previous_socket(&link).is_err());
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    fs::remove_dir_all(directory).unwrap();
}
