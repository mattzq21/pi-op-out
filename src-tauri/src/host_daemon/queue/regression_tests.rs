use super::*;
struct Unresponsive { forced: std::sync::atomic::AtomicBool }
impl Execution for Unresponsive {
    fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            if kind(&command) == "force_stop" { self.forced.store(true, std::sync::atomic::Ordering::SeqCst); return Ok(Value::Null); }
            std::future::pending().await
        })
    }
    fn publish(&self, _: Value) {}
}
#[tokio::test]
async fn abort_forces_stop_when_preparation_never_answers() {
    let executor = Arc::new(Unresponsive { forced: std::sync::atomic::AtomicBool::new(false) });
    let queue = SessionQueue::new(executor.clone(), vec![]);
    let result = tokio::time::timeout(std::time::Duration::from_secs(6), queue.command(json!({"type":"abort"}))).await;
    assert!(result.is_ok(), "abort never reached force stop");
    result.unwrap().unwrap();
    assert!(executor.forced.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn queue_updates_keep_attachment_metadata_without_image_data() {
    let item = json!({"id":"queued","message":"inspect","behavior":"followUp","images":[{"type":"image","mimeType":"image/png","data":"private-image"}]});
    let view = QueueState::default().view(&[item]);
    assert_eq!(view["pendingMessages"][0]["id"], "queued");
    assert_eq!(view["pendingMessages"][0]["images"][0]["mimeType"], "image/png");
    assert!(view["pendingMessages"][0]["images"][0].get("data").is_none());
}

struct StuckPreparation;
impl Execution for StuckPreparation {
    fn execute(&self, command: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            if kind(&command) == "force_stop" { Ok(Value::Null) } else { std::future::pending().await }
        })
    }
    fn publish(&self, _event: Value) {}
}
#[tokio::test]
async fn abort_escalates_even_when_preparation_and_gate_are_stuck() {
    let queue = SessionQueue::new(Arc::new(StuckPreparation), Vec::new());
    let _gate = queue.gate.lock().await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(6), queue.command(json!({"type":"abort"}))).await;
    assert!(result.is_ok(), "abort never reached force_stop");
    assert!(result.unwrap().is_ok());
}
