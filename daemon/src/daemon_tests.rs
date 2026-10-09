use super::*;

struct TestDaemon(Arc<Daemon>);

impl TestDaemon {
    fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (input, packets) = tokio::sync::mpsc::unbounded_channel();
        let daemon = Arc::new(Daemon {
            alive: AtomicBool::new(true), remote_port: None, connection_config: None,
            agent_prefix: "test:".into(), events: Mutex::new(()),
            worker: Mutex::new(None), events_worker: Mutex::new(None), input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
        });
        (Self(daemon), packets)
    }
}

#[test]
fn command_spec_preserves_argument_boundaries_cwd_and_explicit_environment() {
    let mut command = Command::new("node");
    command.args(["--eval", "console.log('a b')", "$(literal)"]).current_dir("/project with spaces");
    command.env("PIOP_TEST_VALUE", "a=b\nnext").env_remove("PIOP_TEST_REMOVED");
    assert_eq!(spec(&command), json!({
        "program":"node", "args":["--eval","console.log('a b')","$(literal)"],
        "cwd":"/project with spaces", "env":{"PIOP_TEST_VALUE":"a=b\nnext"}
    }));
    assert_eq!(spec(&Command::new("node"))["cwd"], Value::Null);
}

#[test]
fn daemon_connections_match_transport_configuration_and_reject_missing_hosts() {
    let mut settings = default_settings();
    assert_eq!(connection_config(&settings, "local").unwrap(), None);
    assert!(connection_config(&settings, "missing").unwrap_err().contains("Unknown machine"));
    settings.hosts.push(RemoteHost { enabled: true, id: "remote".into(), name: "Server".into(), target: "user@example.com".into(), pi_path: "/opt/pi".into() });
    assert_eq!(connection_config(&settings, "remote").unwrap(), Some(("user@example.com".into(), "/opt/pi".into())));
    let (daemon, _) = TestDaemon::new();
    assert!(daemon.0.matches_connection(&settings, "local"));
    assert!(!daemon.0.matches_connection(&settings, "remote"));
    assert!(!daemon.0.matches_connection(&settings, "missing"));
}

#[test]
fn failed_daemon_input_cleans_up_pending_requests_and_shutdown_tolerates_unavailable_input() {
    let (daemon, _) = TestDaemon::new();
    let connection = daemon.0.clone();
    assert!(thread::spawn(move || {
        let _input = connection.input.lock().unwrap();
        panic!("simulate input writer failure");
    }).join().is_err());
    assert_eq!(daemon.0.request(json!({"type":"command"})).unwrap_err(), "Daemon input lock was poisoned");
    assert!(daemon.0.pending.lock().unwrap().is_empty());
    daemon.0.shutdown();
}

#[test]
fn shutdown_sends_a_standalone_packet_without_registering_a_request() {
    let (daemon, mut packets) = TestDaemon::new();
    daemon.0.shutdown();
    assert_eq!(packets.blocking_recv().unwrap(), json!({"type":"shutdown"}));
    assert!(daemon.0.pending.lock().unwrap().is_empty());
}

#[test]
fn daemon_configuration_propagates_rejection_and_releases_the_request() {
    let (daemon, mut packets) = TestDaemon::new(); let connection = daemon.0.clone();
    let configure = thread::spawn(move || connection.configure(&PiRuntime::default(), &default_settings(), "local"));
    let packet = packets.blocking_recv().unwrap();
    daemon.0.pending.lock().unwrap().get(packet["id"].as_str().unwrap()).unwrap().send(Err("invalid configuration".into())).unwrap();
    assert_eq!(configure.join().unwrap().unwrap_err(), "invalid configuration");
    assert!(daemon.0.pending.lock().unwrap().is_empty());
}
