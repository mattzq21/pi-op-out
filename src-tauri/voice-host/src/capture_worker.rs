
use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use super::MAX_CAPTURE_AGE;
use super::buffers::Buffers;
use super::processing;
use crate::service_failure::ServiceFailure;

pub(super) struct CaptureWorker {
    pub(super) buffers: Arc<Buffers>,
    pub(super) processor: processing::Processor,
    pub(super) pending: VecDeque<crate::audio_track::EncodedAudio>,
}

impl CaptureWorker {
    pub(super) fn set_controls(
        &mut self,
        controls: crate::protocol::AudioControls,
    ) -> io::Result<()> {
        self.buffers
            .set_speaker_disabled(controls.speaker_suppressed)?;
        let previous = self.buffers.microphone.load(Ordering::Acquire);
        Buffers::set_disabled(&self.buffers.microphone, controls.microphone_muted)?;
        if previous != self.buffers.microphone.load(Ordering::Acquire) {
            self.pending.clear();
            self.processor.reset().map_err(io::Error::other)?;
        }
        Ok(())
    }

    fn reset_dropped(&mut self) -> io::Result<()> {
        if self.buffers.render_dropped.swap(false, Ordering::AcqRel) {
            self.processor.reset_render();
            for _ in 0..self.buffers.rendered.capacity() {
                if self.buffers.rendered.pop().is_none() {
                    break;
                }
            }
        }
        if self.buffers.capture_dropped.swap(false, Ordering::AcqRel) {
            self.pending.clear();
            self.processor.reset().map_err(io::Error::other)?;
            for _ in 0..self.buffers.capture.capacity() {
                if self.buffers.capture.pop().is_none() {
                    break;
                }
            }
        }
        Ok(())
    }

    fn process_render(&mut self) -> io::Result<()> {
        let mut render_stale = false;
        for _ in 0..self.buffers.rendered.capacity() {
            let Some(frame) = self.buffers.rendered.pop() else {
                break;
            };
            if frame.at.elapsed() > MAX_CAPTURE_AGE {
                if !render_stale {
                    self.processor.reset_render();
                    render_stale = true;
                }
                continue;
            }
            render_stale = false;
            self.processor
                .render(&frame)
                .map_err(|_| io::Error::other(ServiceFailure::Render))?;
        }
        Ok(())
    }

    fn encode_capture(
        &mut self,
        frame: &super::buffers::Frame,
        now: &impl Fn() -> Instant,
    ) -> io::Result<()> {
        let frames = self.processor.capture(frame, now);
        match frames {
            Ok(frames) => self.pending.extend(frames),
            Err(processing::PROCESSING_LATE) => {
                self.pending.clear();
                self.processor.reset().map_err(io::Error::other)?;
            }
            Err(_) => return Err(io::Error::other(ServiceFailure::Capture)),
        }
        Ok(())
    }

    fn process_capture(&mut self, generation: u64, now: &impl Fn() -> Instant) -> io::Result<()> {
        let mut capture_stale = false;
        for _ in 0..self.buffers.capture.capacity() {
            let Some(frame) = self.buffers.capture.pop() else {
                break;
            };
            if generation.is_multiple_of(2) && frame.generation == generation {
                if now().saturating_duration_since(frame.at) > processing::MAX_PROCESSING_DELAY {
                    self.pending.clear();
                    if !capture_stale {
                        self.processor.reset().map_err(io::Error::other)?;
                        capture_stale = true;
                    }
                    continue;
                }
                capture_stale = false;
                self.encode_capture(&frame, now)?;
            }
        }
        Ok(())
    }

    fn check_device(&self) -> io::Result<()> {
        if self.buffers.failed.load(Ordering::Acquire) {
            return Err(io::Error::other(ServiceFailure::Device));
        }
        Ok(())
    }

    pub(super) async fn service(
        &mut self,
        audio: &mut crate::audio_track::AudioTrack,
        now: impl Fn() -> Instant,
    ) -> io::Result<usize> {
        self.buffers.serviced.store(true, Ordering::Release);
        let generation = self.buffers.microphone.load(Ordering::Acquire);
        self.reset_dropped()?;
        self.process_render()?;
        if self.pending.is_empty() {
            self.process_capture(generation, &now)?;
        }
        self.check_device()?;
        self.send_pending(audio, generation, now).await
    }

    async fn send_pending(
        &mut self,
        audio: &mut crate::audio_track::AudioTrack,
        generation: u64,
        now: impl Fn() -> Instant,
    ) -> io::Result<usize> {
        let Some(frame) = self.pending.pop_front() else {
            if !generation.is_multiple_of(2) {
                audio
                    .send_muted_silence(now())
                    .await
                    .map_err(|_| io::Error::other(ServiceFailure::Send))?;
            }
            return Ok(0);
        };
        if now().saturating_duration_since(frame.at) > processing::MAX_PROCESSING_DELAY {
            self.pending.clear();
            self.processor.reset().map_err(io::Error::other)?;
            return Ok(0);
        }
        audio
            .send(frame)
            .await
            .map_err(|_| io::Error::other(ServiceFailure::Send))?;
        Ok(1)
    }
}
