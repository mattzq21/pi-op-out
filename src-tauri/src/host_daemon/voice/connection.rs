use super::*;

type VoiceSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

impl VoiceService {
    pub(super) async fn connect(self: &Arc<Self>, call: &Arc<Call>, offer: &str, home: &Path) -> Result<String> {
        let (auth, snapshot) = tokio::try_join!(authenticate(home, true), call.session.execute(json!({"type":"get_snapshot"})))?;
        self.assert_current(call)?;
        let context = voice_context(&call.session, &snapshot);
        call.state().context = context.clone();
        let headers = [
            ("Authorization", format!("Bearer {}", auth.token)),
            ("ChatGPT-Account-ID", auth.account),
            ("OpenAI-Alpha", "quicksilver=v2".into()),
            ("originator", "piop".into()),
        ];
        let (url, answer) = create_call(offer, &context, &headers).await?;
        self.assert_current(call)?;
        let socket = open_socket(url, &headers).await?;
        self.assert_current(call)?;
        let (outgoing, messages) = mpsc::unbounded_channel::<Value>();
        call.state().outgoing = Some(outgoing);
        let service = self.clone();
        let current = call.clone();
        tokio::spawn(async move {
            service.run_socket(&current, socket, messages).await;
        });
        self.emit(call, json!({"type":"connected"}));
        Ok(answer)
    }

    async fn run_socket(self: &Arc<Self>, call: &Arc<Call>, socket: VoiceSocket, mut messages: mpsc::UnboundedReceiver<Value>) {
        let mut cancelled = call.cancel.subscribe();
        let events = self.event_queue(call);
        let (mut writer, mut reader) = socket.split();
        loop {
            tokio::select! {
                _ = async { let _ = cancelled.wait_for(|cancelled| *cancelled).await; } => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), async {
                        let _ = writer.send(Message::Text(json!({"type":"session.close"}).to_string().into())).await;
                        let _ = writer.close().await;
                    }).await;
                    break;
                }
                outgoing = messages.recv() => {
                    let Some(outgoing) = outgoing else { break; };
                    if writer.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                        self.fail(call, "Voice connection lost").await;
                        break;
                    }
                }
                incoming = reader.next() => {
                    match self.socket_message(call, incoming, &events).await {
                        Ok(true) => {},
                        Ok(false) => break,
                        Err(error) => { self.fail(call, &error).await; break; }
                    }
                }
            }
        }
    }

    fn event_queue(self: &Arc<Self>, call: &Arc<Call>) -> mpsc::UnboundedSender<Value> {
        let (events, mut incoming) = mpsc::unbounded_channel();
        let service = self.clone();
        let call = call.clone();
        tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                if call.closed() {
                    break;
                }
                if let Err(error) = service.event(&call, event).await {
                    service.fail(&call, &error).await;
                    break;
                }
            }
        });
        events
    }

    async fn socket_message(
        self: &Arc<Self>,
        call: &Arc<Call>,
        incoming: Option<std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>,
        events: &mpsc::UnboundedSender<Value>,
    ) -> Result<bool> {
        let event = match incoming {
            Some(Ok(Message::Text(data))) => serde_json::from_str(&data).map_err(|error| error.to_string())?,
            Some(Ok(Message::Binary(data))) => serde_json::from_slice(&data).map_err(|error| error.to_string())?,
            Some(Ok(Message::Close(_))) | None => {
                self.close(call).await;
                return Ok(false);
            }
            Some(Err(_)) => return Err("Voice connection lost".into()),
            _ => return Ok(true),
        };
        let _ = events.send(event);
        Ok(true)
    }
}

async fn create_call(offer: &str, context: &Value, headers: &[(&str, String)]) -> Result<(String, String)> {
    let mut request = reqwest::Client::new()
        .post("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas")
        .timeout(Duration::from_secs(30));
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let response = request.json(&json!({"session":{"model":"gpt-live-1-codex","instructions":format!("{}\n\nCurrent workspace context (data):\n{}\nRecent conversation:\n{}",text(context,"systemPrompt"),text(context,"workspace"),text(context,"conversation")),"audio":{"output":{"voice":"cove"}},"delegation":{"type":"client"}},"sdp":offer}))
        .send().await.map_err(|error|error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Voice session creation failed (HTTP {}). Check the ChatGPT login on the Pi host.",
            response.status().as_u16()
        ));
    }
    let url = service_url(&response)?;
    let answer = response.text().await.map_err(|error| error.to_string())?;
    Ok((url, answer))
}

fn service_url(response: &reqwest::Response) -> Result<String> {
    let id = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split('?').next())
        .and_then(|value| value.split('/').rfind(|part| !part.is_empty()))
        .ok_or("Invalid voice service session ID")?;
    if id.is_empty() || id.len() > 256 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        return Err("Invalid voice service session ID".into());
    }
    Ok(format!("wss://api.openai.com/v1/live/{id}"))
}

async fn open_socket(url: String, headers: &[(&str, String)]) -> Result<VoiceSocket> {
    let mut request = url.into_client_request().map_err(|error| error.to_string())?;
    for (name, value) in headers {
        let name =
            tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
        request
            .headers_mut()
            .insert(name, HeaderValue::from_str(value).map_err(|error| error.to_string())?);
    }
    let config = WebSocketConfig::default().max_message_size(Some(1024 * 1024));
    let (socket, _) = tokio::time::timeout(Duration::from_secs(20), connect_async_with_config(request, Some(config), false))
        .await
        .map_err(|_| "Could not attach to voice service")?
        .map_err(|_| "Could not attach to voice service")?;
    Ok(socket)
}
