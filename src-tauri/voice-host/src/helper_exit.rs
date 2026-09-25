//! Fixed helper exit phases for safe diagnostics when its framed output closes.
//! The same-build handshake keeps these codes aligned between parent and helper.

#[derive(Clone, Copy, Debug)]
#[repr(i32)]
pub enum HelperExitStage {
    ControlRead = 20,
    ControlQueue = 21,
    ParentGone = 22,
    Runtime = 23,
    Transport = 24,
    OpenDevices = 25,
    AudioIngress = 26,
    AudioService = 27,
    InspectAudio = 28,
    AudioControls = 29,
    Reply = 30,
    Shutdown = 31,
    ControlSequence = 32,
    Playout = 33,
    Render = 35,
    Capture = 36,
    Device = 37,
    Send = 39,
}

impl HelperExitStage {
    pub fn code(self) -> i32 {
        self as i32
    }

    pub fn from_code(code: i32) -> Option<Self> {
        [
            Self::ControlRead, Self::ControlQueue, Self::ParentGone, Self::Runtime,
            Self::Transport, Self::OpenDevices, Self::AudioIngress, Self::AudioService,
            Self::InspectAudio, Self::AudioControls, Self::Reply, Self::Shutdown,
            Self::ControlSequence, Self::Playout, Self::Render, Self::Capture,
            Self::Device, Self::Send,
        ].into_iter().find(|stage| stage.code() == code)
    }
}
