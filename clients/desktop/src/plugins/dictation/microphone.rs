//! Lets the app's own pages use the microphone for dictation.
use tauri::Manager;

const DEVELOPMENT: bool = cfg!(debug_assertions);

pub(super) fn allow(webview: &tauri::Webview) -> Result<(), String> {
    let dev_url = webview.app_handle().config().build.dev_url.clone();
    webview.with_webview(move |webview| {
        use gtk::prelude::Cast;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) { settings.set_enable_media_stream(true); }
        view.connect_permission_request(move |view, request| {
            let trusted = view.uri().and_then(|uri| tauri::Url::parse(&uri).ok()).is_some_and(|url| {
                url.scheme() == "tauri" && url.host_str() == Some("localhost")
                    || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
                    || DEVELOPMENT && dev_url.as_ref().is_some_and(|configured| url.origin() == configured.origin())
            });
            if trusted && request.downcast_ref::<UserMediaPermissionRequest>().is_some_and(|media| media.is_for_audio_device() && !media.is_for_video_device()) {
                request.allow(); true
            } else { false }
        });
    }).map_err(|error| error.to_string())
}
