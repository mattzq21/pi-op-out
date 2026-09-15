//! Keep non-native helper targets buildable without linking a host audio backend.

use std::io;

pub(super) struct Devices;

impl Devices {
    pub(super) fn receive(&self, _: crate::incoming::ReceivedRtp) -> io::Result<()> {
        Self::open().map(|_| ())
    }

    pub(super) fn take_state(&self) -> io::Result<crate::protocol::AudioState> {
        Self::open().map(|_| crate::protocol::AudioState::default())
    }

    pub(super) fn open() -> io::Result<Self> {
        Err(io::Error::other(
            "audio devices unavailable for this helper target",
        ))
    }

    pub(super) fn set_controls(&self, _: crate::protocol::AudioControls) -> io::Result<()> {
        Self::open().map(|_| ())
    }

    pub(super) async fn service(
        &mut self,
        _: &mut crate::audio_track::AudioTrack,
    ) -> io::Result<usize> {
        Self::open().map(|_| 0)
    }
}
