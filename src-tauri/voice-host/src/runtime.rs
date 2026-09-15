use std::io;

pub(super) struct Runtime;

impl Runtime {
    pub(super) fn initialize() -> io::Result<Self> {
        gstreamer::init().map_err(|_| io::Error::other("Could not initialize GStreamer"))?;
        for name in ["appsrc", "audioconvert", "audioresample", "capsfilter", "opusdec", "rtpopusdepay", "rtpjitterbuffer"] {
            if gstreamer::ElementFactory::find(name).is_none() {
                return Err(io::Error::other(format!("Missing GStreamer element: {name}")));
            }
        }
        Ok(Self)
    }
}
