use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use crate::platform::AppHandle;
#[cfg(feature = "desktop")]
use crate::platform::State;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};
#[cfg(feature = "desktop")]
use std::{path::PathBuf, process::Stdio, time::Duration};
#[cfg(feature = "desktop")]
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::{Child, ChildStdin, ChildStdout, Command}, sync::{mpsc, watch}, time::timeout};
#[cfg(feature = "desktop")]
#[allow(dead_code)]
#[path = "../voice-host/src/protocol.rs"]
mod protocol;
#[cfg(feature = "desktop")]
use protocol::{AudioControls, Message};

#[derive(Default, Clone)]
pub struct VoiceRuntime(Arc<Mutex<Option<ActiveCall>>>);
#[cfg(feature = "desktop")]
struct ActiveCall { id: String, runtime_id: String, close: watch::Sender<bool>, commands: mpsc::Sender<Control> }
#[cfg(not(feature = "desktop"))]
struct ActiveCall;
#[cfg(feature = "desktop")]
enum Control { Mute(bool), Suppress(bool) }
impl VoiceRuntime {
    #[cfg(feature = "desktop")]
    pub fn disconnect_runtime(&self, runtime_id: &str) {
        if let Ok(active) = self.0.lock() { if let Some(call) = active.as_ref().filter(|call| call.runtime_id == runtime_id) { let _ = call.close.send(true); } }
    }
    pub fn shutdown(&self) {
        if let Ok(mut active) = self.0.lock() { if let Some(_call) = active.take() {
            #[cfg(feature = "desktop")]
            let _ = _call.close.send(true);
        } }
    }
    pub fn ended(&self, _id: &str) {
        #[cfg(feature = "desktop")]
        if let Ok(active) = self.0.lock() { if let Some(call) = active.as_ref().filter(|call| call.id == _id) { let _ = call.close.send(true); } }
    }
}
#[cfg(not(feature = "desktop"))]
type HostConnection = crate::daemon::Daemon;
#[cfg(feature = "desktop")]
type HostConnection = crate::desktop_daemon::Connection;
#[cfg(not(feature = "desktop"))]
fn daemon(app: &AppHandle, runtime_id: &str) -> Result<Arc<HostConnection>, String> {
    app.state::<crate::PiRuntime>().processes.lock().map_err(|_| "Pi runtime unavailable")?.get(runtime_id).map(|process| process.daemon.clone()).ok_or("Connect to the conversation before starting voice".into())
}
#[cfg(feature = "desktop")]
fn daemon(app: &AppHandle, runtime_id: &str) -> Result<Arc<HostConnection>, String> {
    app.state::<crate::desktop_daemon::DesktopDaemon>().for_runtime(runtime_id)
}
async fn request(daemon: Arc<HostConnection>, packet: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || daemon.request(packet)).await.map_err(|error| error.to_string())?
}
pub async fn host_request(app: AppHandle, runtime_id: String, action: String, call_id: Option<String>, offer: Option<String>) -> Result<Value, String> {
    request(daemon(&app, &runtime_id)?, json!({"type":"voice","runtimeId":runtime_id,"action":action,"callId":call_id,"offer":offer})).await
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_configuration(app: AppHandle, runtime_id: String) -> Result<Value, String> {
    let configuration = host_request(app.clone(), runtime_id, "configuration".into(), None, None).await?;
    #[cfg(feature = "desktop")]
    let configuration = { let mut value = configuration; value["helperAvailable"] = json!(helper_path(&app).is_ok()); value };
    Ok(configuration)
}
fn emit(app: &AppHandle, id: &str, event: Value) { let _ = app.emit("pi://voice", json!({"callId":id,"event":event})); }

#[cfg(feature = "desktop")]
fn helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = format!("piop-voice-host{}", std::env::consts::EXE_SUFFIX);
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let adjacent = executable.parent().ok_or("Cannot locate application")?.join(&name);
    if adjacent.is_file() { return Ok(adjacent); }
    let bundled = app.path().resource_dir().map_err(|e| e.to_string())?.join(&name);
    if bundled.is_file() { return Ok(bundled); }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("voice-host/target/release").join(&name);
        if development.is_file() { return Ok(development); }
    }
    Err("The native voice helper is missing. Build Piop with npm run build:voice.".into())
}


#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn voice_start(app: AppHandle, runtime: State<'_, VoiceRuntime>, runtime_id: String, call_id: String) -> Result<(), String> {
    uuid::Uuid::parse_str(&call_id).map_err(|_| "Invalid voice call identifier")?;
    let path = helper_path(&app)?;
    let daemon = daemon(&app, &runtime_id)?;
    let mut active = runtime.0.lock().map_err(|_| "Voice state unavailable")?;
    if active.is_some() { return Err("End the current voice call first".into()); }
    let (commands, receiver) = mpsc::channel(64);
    let (close, closing) = watch::channel(false);
    let id = call_id.clone(); let owner = runtime.inner().clone(); let target_runtime = runtime_id.clone();
    tokio::spawn(async move {
        let result = run_media(&app, &id, &runtime_id, daemon.clone(), path, receiver, closing).await;
        let _ = request(daemon, json!({"type":"voice","action":"stop","runtimeId":runtime_id,"callId":id})).await;
        if let Err(error) = result { emit(&app, &id, json!({"type":"error","message":error})); }
        if let Ok(mut active) = owner.0.lock() { if active.as_ref().is_some_and(|call| call.id == id) { *active = None; } }
        emit(&app, &id, json!({"type":"ended"}));
    });
    *active = Some(ActiveCall { id: call_id, runtime_id: target_runtime, close, commands });
    Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_stop(app: AppHandle, runtime_id: String, call_id: String) -> Result<(), String> {
    app.state::<VoiceRuntime>().ended(&call_id);
    host_request(app, runtime_id, "stop".into(), Some(call_id), None).await.map(|_| ())
}
#[cfg(feature = "desktop")]
fn command(runtime: &VoiceRuntime, id: &str, control: Control) -> Result<(), String> {
    let active = runtime.0.lock().map_err(|_| "Voice state unavailable")?;
    let call = active.as_ref().filter(|call| call.id == id).ok_or("This voice call has ended")?;
    call.commands.try_send(control).map_err(|_| "Voice is busy; try again".into())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn voice_mute(app: AppHandle, call_id: String, muted: bool) -> Result<(), String> {
    #[cfg(feature = "desktop")]
    command(&app.state::<VoiceRuntime>(), &call_id, Control::Mute(muted))?;
    #[cfg(not(feature = "desktop"))]
    emit(&app, &call_id, json!({"type":"muted","muted":muted})); Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn voice_suppress(app: AppHandle, call_id: String, suppressed: bool) -> Result<(), String> {
    #[cfg(feature = "desktop")]
    command(&app.state::<VoiceRuntime>(), &call_id, Control::Suppress(suppressed))?;
    #[cfg(not(feature = "desktop"))]
    emit(&app, &call_id, json!({"type":"suppressed","suppressed":suppressed})); Ok(())
}

#[cfg(feature = "desktop")]
struct Helper {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}
#[cfg(feature = "desktop")]
impl Helper {
    #[cfg(feature = "desktop")]
    fn spawn(path: PathBuf) -> Result<Self, String> {
        let mut child = Command::new(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .env_remove("OPENAI_API_KEY").env_remove("GST_PLUGIN_PATH").env_remove("GST_PLUGIN_PATH_1_0")
            .kill_on_drop(true).spawn().map_err(|e| format!("Cannot start native voice: {e}"))?;
        let input = child.stdin.take().ok_or("Voice helper input unavailable")?;
        let output = child.stdout.take().ok_or("Voice helper output unavailable")?;
        Ok(Self { child, input, output })
    }
    async fn exchange(&mut self, request: Message) -> Result<Message, String> {
        let result = timeout(Duration::from_secs(30), self.exchange_inner(request)).await;
        match result {
            Ok(Ok(reply)) => Ok(reply),
            _ => {
                let phase = self.child.try_wait().ok().flatten().and_then(|status| status.code());
                Err(match phase {
                    Some(23) => "The audio runtime could not start. Install GStreamer 1.28 with its base and good plugins.",
                    Some(25) => "Cannot open the microphone or speaker. Check the default audio devices and microphone permission.",
                    Some(24) => "Could not establish the voice media connection.",
                    _ => "The native voice helper stopped responding.",
                }.into())
            }
        }
    }
    async fn exchange_inner(&mut self, request: Message) -> Result<Message, String> {
        self.input.write_all(&protocol::encode_frame(&request).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())?;
        let length = self.output.read_u32().await.map_err(|e| e.to_string())? as usize;
        if length > protocol::MAX_FRAME_BYTES { return Err("Invalid voice helper reply".into()); }
        let mut bytes = vec![0; length];
        self.output.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "Invalid voice helper reply".into())
    }
    async fn expect(&mut self, request: Message, expected: Message) -> Result<(), String> {
        if self.exchange(request).await? != expected { return Err("Unexpected voice helper reply".into()); }
        Ok(())
    }
    #[cfg(feature = "desktop")]
    async fn offer(&mut self) -> Result<String, String> {
        self.expect(Message::Hello { protocol: 1, build_commit: "piop-voice-1".into() }, Message::Ready {}).await?;
        self.expect(Message::InitializeRuntime {}, Message::RuntimeReady {}).await?;
        match self.exchange(Message::StartTransport {}).await? {
            Message::Offer { sdp } => Ok(sdp.into_sdp()),
            _ => Err("Native voice did not produce a connection offer".into()),
        }
    }
    #[cfg(feature = "desktop")]
    async fn connect(&mut self, answer: String) -> Result<(), String> {
        self.expect(Message::ApplyAnswer { sdp: answer.try_into().map_err(str::to_owned)? }, Message::TransportReady {}).await?;
        self.expect(Message::OpenDevices {}, Message::DevicesOpened {}).await
    }
    async fn controls(&mut self, controls: AudioControls) -> Result<(), String> {
        self.expect(Message::SetAudioControls { controls }, Message::AudioControlsApplied {}).await
    }
    #[cfg(feature = "desktop")]
    async fn close(&mut self) {
        let _ = timeout(Duration::from_secs(2), self.expect(Message::Close {}, Message::Closed {})).await;
        let _ = self.child.start_kill();
        let _ = timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

#[cfg(feature = "desktop")]
fn pending_audio_controls(commands: &mut mpsc::Receiver<Control>) -> AudioControls {
    let mut controls = AudioControls { microphone_muted: false, speaker_suppressed: false };
    while let Ok(control) = commands.try_recv() {
        match control { Control::Mute(value) => controls.microphone_muted = value, Control::Suppress(value) => controls.speaker_suppressed = value }
    }
    controls
}

#[cfg(feature = "desktop")]
async fn run_media(app: &AppHandle, id: &str, runtime_id: &str, daemon: Arc<HostConnection>, path: PathBuf, mut commands: mpsc::Receiver<Control>, mut closing: watch::Receiver<bool>) -> Result<(), String> {
    let mut helper = Helper::spawn(path)?;
    let result = async {
        let offer = tokio::select! { biased; _ = closing.changed() => return Ok(()), offer = helper.offer() => offer? };
        if *closing.borrow() { return Ok(()); }
        // Await the host response so the final stop cannot overtake start.
        let answer = request(daemon, json!({"type":"voice","action":"start","callId":id,"runtimeId":runtime_id,"offer":offer})).await?;
        if *closing.borrow() { return Ok(()); }
        helper.connect(answer.as_str().ok_or("Missing voice connection answer")?.to_owned()).await?;
        let mut controls = pending_audio_controls(&mut commands);
        helper.controls(controls).await?;
        emit(app, id, json!({"type":"muted","muted":controls.microphone_muted}));
        emit(app, id, json!({"type":"suppressed","suppressed":controls.speaker_suppressed}));
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = closing.changed() => return Ok(()),
                control = commands.recv() => {
                    match control { Some(Control::Mute(value)) => controls.microphone_muted = value, Some(Control::Suppress(value)) => controls.speaker_suppressed = value, None => return Ok(()) }
                    helper.controls(controls).await?;
                    emit(app, id, json!({"type":"muted","muted":controls.microphone_muted}));
                    emit(app, id, json!({"type":"suppressed","suppressed":controls.speaker_suppressed}));
                },
                _ = poll.tick() => if let Message::AudioState { state } = helper.exchange(Message::InspectAudio {}).await? {
                    emit(app, id, json!({"type":"levels","microphone":state.microphone_peak,"speaker":state.speaker_peak}));
                }
            }
        }
    }.await;
    helper.close().await;
    result
}
