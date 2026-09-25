
#[cfg_attr(
    not(any(
        target_os = "macos",
        all(target_os = "linux", target_env = "gnu"),
        all(windows, target_env = "msvc")
    )),
    allow(dead_code)
)]
mod audio_track;
#[cfg_attr(
    not(any(
        target_os = "macos",
        all(target_os = "linux", target_env = "gnu"),
        all(windows, target_env = "msvc")
    )),
    path = "devices_unavailable.rs"
)]
mod devices;
mod helper_exit;
mod incoming;
mod protocol;
mod runtime;
mod service_failure;
mod transport;
mod transport_runtime;

use std::cell::Cell;
use std::io;
use std::io::Write;
use std::sync::mpsc;
use std::time::Duration;

use crate::protocol::Message;
use crate::protocol::encode_frame;
use crate::protocol::read_message;
use helper_exit::HelperExitStage;
use service_failure::ServiceFailure;

const DEVICE_SERVICE_INTERVAL: Duration = Duration::from_millis(           5);

const BUILD_COMMIT: &str = "piop-voice-1";

fn main() {
    let mut args = std::env::args_os().skip(      1);
    match (args.next(), args.next()) {
        (Some(arg), None) if arg == "--build-commit" => println!("{BUILD_COMMIT}"),
        (None, None) => {
            let phase = Cell::new(HelperExitStage::ControlSequence);
            if run(&phase, |executor| {
                phase.set(HelperExitStage::Transport);
                executor
                    .block_on(transport::Transport::new())
                    .map_err(io::Error::other)
            })
            .is_err()
            {
                std::process::exit(phase.get().code());
            }
        }
        _ => std::process::exit(         2),
    }
}

fn control_receiver() -> io::Result<mpsc::Receiver<Message>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("voice-control".into())
        .spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                match read_message(&mut input) {
                    Ok(Some(message)) => {
                        if sender.try_send(message).is_err() {
                            std::process::exit(HelperExitStage::ControlQueue.code());
                        }
                    }
                    Ok(None) => break,
                    Err(_) => std::process::exit(HelperExitStage::ControlRead.code()),
                }
            }
            drop(sender);
            std::thread::sleep(Duration::from_secs(2));
            std::process::exit(HelperExitStage::ParentGone.code());
        })?;
    Ok(receiver)
}

fn write_reply(output: &mut impl Write, reply: Message) -> io::Result<()> {
    output.write_all(&encode_frame(&reply)?)?;
    output.flush()
}

fn accept_hello(receiver: &mpsc::Receiver<Message>) -> io::Result<bool> {
    let Ok(hello) = receiver.recv() else {
        return Ok(false);
    };
    if hello
        != (Message::Hello {
            protocol: 1,
            build_commit: BUILD_COMMIT.to_owned(),
        })
    {
        return Err(io::Error::other("incompatible voice helper"));
    }
    Ok(true)
}

fn run(
    phase: &Cell<HelperExitStage>,
    start_transport: impl Fn(&tokio::runtime::Runtime) -> io::Result<transport::Transport>,
) -> io::Result<()> {
    let receiver = control_receiver()?;
    if !accept_hello(&receiver)? {
        return Ok(());
    }
    phase.set(HelperExitStage::Reply);
    let mut output = io::stdout().lock();
    write_reply(&mut output, Message::Ready {})?;
    let mut session = HelperSession {
        runtime: None,
        executor: tokio::runtime::Runtime::new()?,
        transport: None,
        answered: false,
        devices: None,
    };
    run_controls(
        &mut session,
        &receiver,
        phase,
        &start_transport,
        &mut output,
    )
}

fn run_controls(
    session: &mut HelperSession,
    receiver: &mpsc::Receiver<Message>,
    phase: &Cell<HelperExitStage>,
    start_transport: &impl Fn(&tokio::runtime::Runtime) -> io::Result<transport::Transport>,
    output: &mut impl Write,
) -> io::Result<()> {
    loop {
        phase.set(HelperExitStage::ControlSequence);
        let Some(message) = session.next_control(receiver, phase)? else {
            return Ok(());
        };
        let (reply, finished) = session.handle_control(message, phase, start_transport)?;
        if !finished {
            phase.set(HelperExitStage::Reply);
        }
        write_reply(output, reply)?;
        if finished {
            return Ok(());
        }
    }
}

struct HelperSession {
    devices: Option<devices::Devices>,
    transport: Option<transport::Transport>,
    answered: bool,
    executor: tokio::runtime::Runtime,
    runtime: Option<runtime::Runtime>,
}

type ControlReply = io::Result<(Message, bool)>;

impl HelperSession {
    fn next_control(
        &mut self,
        receiver: &mpsc::Receiver<Message>,
        phase: &Cell<HelperExitStage>,
    ) -> io::Result<Option<Message>> {
        let Some(devices) = &mut self.devices else {
            return Ok(receiver.recv().ok());
        };
        let peer = self
            .transport
            .as_mut()
            .ok_or_else(|| io::Error::other("voice peer not started"))?;
        wait_for_control(receiver, || {
            service_audio(devices, peer, &self.executor, phase)
        })
    }

    fn handle_control(
        &mut self,
        message: Message,
        phase: &Cell<HelperExitStage>,
        start_transport: &impl Fn(&tokio::runtime::Runtime) -> io::Result<transport::Transport>,
    ) -> ControlReply {
        match message {
            Message::InspectAudio {} => self.inspect_audio(phase),
            Message::OpenDevices {} => self.open_devices(phase),
            Message::SetAudioControls { controls } => self.set_controls(phase, controls),
            Message::StartTransport {} => self.start_transport(phase, start_transport),
            Message::ApplyAnswer { sdp } => self.apply_answer(phase, sdp.into_sdp()),
            Message::InitializeRuntime {} => self.initialize_runtime(phase),
            Message::Close {} => self.close(phase),
            _ => Err(io::Error::other("invalid voice control sequence")),
        }
    }

    fn inspect_audio(&self, phase: &Cell<HelperExitStage>) -> ControlReply {
        phase.set(HelperExitStage::InspectAudio);
        if self.answered
            && self
                .transport
                .as_ref()
                .is_none_or(|peer| !*peer.ready.borrow())
        {
            return Err(io::Error::other("voice connection closed"));
        }
        let state = self
            .devices
            .as_ref()
            .map(devices::Devices::take_state)
            .transpose()
            .inspect_err(|_| phase.set(HelperExitStage::Device))?
            .unwrap_or_default();
        Ok((Message::AudioState { state }, false))
    }

    fn open_devices(&mut self, phase: &Cell<HelperExitStage>) -> ControlReply {
        if self.devices.is_some() || self.runtime.is_none() || !self.answered {
            return Err(io::Error::other("invalid voice control sequence"));
        }
        phase.set(HelperExitStage::OpenDevices);
        self.devices = Some(devices::Devices::open()?);
        Ok((Message::DevicesOpened {}, false))
    }

    fn set_controls(
        &mut self,
        phase: &Cell<HelperExitStage>,
        controls: protocol::AudioControls,
    ) -> ControlReply {
        phase.set(HelperExitStage::AudioControls);
        let peer = self
            .transport
            .as_ref()
            .ok_or_else(|| io::Error::other("voice peer not started"))?;
        if controls.speaker_suppressed {
            peer.incoming
                .set_suppressed(controls.speaker_suppressed)
                .map_err(io::Error::other)?;
        }
        self.devices
            .as_mut()
            .ok_or_else(|| io::Error::other("audio devices not open"))?
            .set_controls(controls)?;
        if !controls.speaker_suppressed {
            peer.incoming
                .set_suppressed(controls.speaker_suppressed)
                .map_err(io::Error::other)?;
        }
        Ok((Message::AudioControlsApplied {}, false))
    }

    fn start_transport(
        &mut self,
        phase: &Cell<HelperExitStage>,
        start: &impl Fn(&tokio::runtime::Runtime) -> io::Result<transport::Transport>,
    ) -> ControlReply {
        if self.transport.is_some() {
            return Err(io::Error::other("invalid voice control sequence"));
        }
        phase.set(HelperExitStage::Transport);
        let peer = start(&self.executor)?;
        let sdp = self
            .executor
            .block_on(peer.offer())
            .map_err(io::Error::other)?;
        self.transport = Some(peer);
        Ok((
            Message::Offer {
                sdp: sdp.try_into().map_err(io::Error::other)?,
            },
            false,
        ))
    }

    fn apply_answer(&mut self, phase: &Cell<HelperExitStage>, sdp: String) -> ControlReply {
        if self.answered {
            return Err(io::Error::other("invalid voice control sequence"));
        }
        phase.set(HelperExitStage::Transport);
        let peer = self
            .transport
            .as_ref()
            .ok_or_else(|| io::Error::other("voice transport not started"))?;
        let outcome = self
            .executor
            .block_on(peer.apply_answer(sdp))
            .map_err(io::Error::other)?;
        if outcome == transport::AnswerOutcome::TimedOut {
            return Ok((Message::TransportTimedOut {}, true));
        }
        self.answered = true;
        Ok((Message::TransportReady {}, false))
    }

    fn initialize_runtime(&mut self, phase: &Cell<HelperExitStage>) -> ControlReply {
        phase.set(HelperExitStage::Runtime);
        if self.runtime.is_some() {
            return Err(io::Error::other("runtime already initialized"));
        }
        self.runtime = Some(runtime::Runtime::initialize()?);
        Ok((Message::RuntimeReady {}, false))
    }

    fn close(&mut self, phase: &Cell<HelperExitStage>) -> ControlReply {
        phase.set(HelperExitStage::Shutdown);
        let _ = self.devices.take();
        if let Some(mut peer) = self.transport.take() {
            self.executor
                .block_on(peer.close())
                .map_err(io::Error::other)?;
        }
        Ok((Message::Closed {}, true))
    }
}

fn service_audio(
    devices: &mut devices::Devices,
    peer: &mut transport::Transport,
    executor: &tokio::runtime::Runtime,
    phase: &Cell<HelperExitStage>,
) -> io::Result<()> {
    for _ in 0..64 {
        phase.set(HelperExitStage::AudioIngress);
        let Some(packet) = peer.incoming.take().map_err(io::Error::other)? else {
            break;
        };
        phase.set(HelperExitStage::Playout);
        devices.receive(packet)?;
    }
    phase.set(HelperExitStage::AudioService);
    executor
        .block_on(devices.service(&mut peer.audio))
        .map(|_| ())
        .inspect_err(|error| set_service_failure(phase, error))
}

fn set_service_failure(phase: &Cell<HelperExitStage>, error: &io::Error) {
    if let Some(failure) = error
        .get_ref()
        .and_then(|error| error.downcast_ref::<ServiceFailure>())
    {
        phase.set(match failure {
            ServiceFailure::Playout => HelperExitStage::Playout,
            ServiceFailure::Render => HelperExitStage::Render,
            ServiceFailure::Capture => HelperExitStage::Capture,
            ServiceFailure::Device => HelperExitStage::Device,
            ServiceFailure::Send => HelperExitStage::Send,
        });
    }
}

fn wait_for_control(
    receiver: &mpsc::Receiver<Message>,
    mut service: impl FnMut() -> io::Result<()>,
) -> io::Result<Option<Message>> {
    loop {
        match receiver.recv_timeout(DEVICE_SERVICE_INTERVAL) {
            Ok(message) => return Ok(Some(message)),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            Err(mpsc::RecvTimeoutError::Timeout) => service()?,
        }
    }
}
