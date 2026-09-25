mod platform;
mod daemon_endpoint;
mod desktop_daemon;
mod voice;
use desktop_daemon::daemon_invoke;
use voice::{voice_configuration, voice_start, voice_stop, voice_mute, voice_suppress};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs::{self, OpenOptions}, io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, thread, time::Duration};
use crate::platform::AppHandle;
use tauri::{Emitter, Manager};
use uuid::Uuid;
const STORAGE_DIRECTORY: &str = if cfg!(debug_assertions) { ".piop-dev" } else { ".piop" };
const DEVELOPMENT: bool = cfg!(debug_assertions);
const APP_TITLE: &str = if DEVELOPMENT { "Piop Dev" } else { "piop" };

fn home_dir() -> Result<PathBuf, String> {
    #[cfg(feature = "webdriver")]
    if let Some(path) = std::env::var_os("PIOP_TEST_HOME") { return Ok(PathBuf::from(path)); }
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    if path.is_dir() { return Err(format!("Configuration path is a directory: {}", path.display())); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o600 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        if permissions.mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn new_window(app: AppHandle, target: Value) -> Result<String, String> {
    let (label, path) = conversation_window_target(&target)?;
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.into()))
        .background_color(tauri::window::Color(24, 24, 23, 255))
        .title(APP_TITLE).inner_size(1280.0, 800.0).min_inner_size(900.0, 640.0)
        .build().map_err(|error| error.to_string())?;
    configure_dictation_microphone(&window)?;
    Ok(label)
}

fn configure_dictation_microphone(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let dev_url = window.app_handle().config().build.dev_url.clone();
    #[cfg(target_os = "linux")]
    window.with_webview(move |webview| {
        use gtk::prelude::Cast;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) { settings.set_enable_media_stream(true); }
        view.connect_permission_request(move |view, request| {
            let trusted = view.uri().and_then(|uri| reqwest::Url::parse(&uri).ok()).is_some_and(|url| {
                url.scheme() == "tauri" && url.host_str() == Some("localhost")
                    || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
                    || DEVELOPMENT && dev_url.as_ref().is_some_and(|configured| url.origin() == configured.origin())
            });
            if trusted && request.downcast_ref::<UserMediaPermissionRequest>().is_some_and(|media| media.is_for_audio_device() && !media.is_for_video_device()) {
                request.allow(); true
            } else { false }
        });
    }).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

#[cfg(feature = "desktop")]
fn conversation_window_target(target: &Value) -> Result<(String, String), String> {
    if !target["sessionId"].as_str().is_some_and(|id| !id.trim().is_empty()) { return Err("Select a conversation to open in another window".into()); }
    let label = format!("chat-{}", Uuid::new_v4());
    let mut url = reqwest::Url::parse("https://piop.invalid/").map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("target", &target.to_string());
    let path = format!("index.html{}", url.query().map(|query| format!("?{query}")).unwrap_or_default());
    Ok((label, path))
}

fn open_system_resource(target: &std::ffi::OsStr) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else if cfg!(target_os = "windows") { "explorer" } else { "xdg-open" };
    let mut child = Command::new(program).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy()))?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
#[cfg(feature = "desktop")]
fn read_dropped_file(path: String) -> Result<Value, String> {
    let path = Path::new(&path);
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Drop files, not folders".to_string()); }
    let limit = 10 * 1024 * 1024;
    if metadata.len() > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let name = path.file_name().ok_or("Attachment has no filename")?.to_string_lossy();
    Ok(json!({ "name": name, "data": data }))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
#[cfg(feature = "desktop")]
fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_with(&url, open_system_resource)
}

#[cfg(feature = "desktop")]
fn open_external_url_with(url: &str, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() { return Err("Only HTTP and HTTPS links can be opened in the browser".into()); }
    open(std::ffi::OsStr::new(parsed.as_str()))
}


#[tauri::command(async)]
fn open_project_directory(cwd: String, host_id: Option<String>) -> Result<(), String> {
    if std::env::var_os("PIOP_DAEMON_URL").is_some() || host_id.as_deref().unwrap_or("local") != "local" { return Err("Opening remote project directories is not supported by the local file manager".into()); }
    let path = PathBuf::from(cwd);
    if !path.is_dir() { return Err(format!("Project directory does not exist: {}", path.display())); }
    open_system_resource(path.as_os_str())
}

#[cfg(all(feature = "desktop", target_os = "linux"))]
const LOAD_ERROR_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>piop - connection error</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #181817; color: #e8e5dd; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 32px; background: #181817; }
    main { width: min(440px, 100%); padding: 30px; border: 1px solid #34322d; border-radius: 12px; background: #1f1f1c; box-shadow: 0 18px 60px #0006; }
    .eyebrow { margin: 0 0 10px; color: #d46a24; font-size: 11px; font-weight: 600; letter-spacing: .15em; text-transform: uppercase; }
    h1 { margin: 0 0 10px; font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
    p { margin: 0; color: #a09c93; font-size: 14px; line-height: 1.55; }
    button { margin-top: 22px; padding: 9px 14px; border: 1px solid #48453e; border-radius: 7px; background: #292824; color: #e8e5dd; font: 600 13px system-ui, sans-serif; cursor: pointer; }
    button:hover { border-color: #d46a24; color: #fff; }
    button:focus-visible { outline: 2px solid #d46a24; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">piop</p>
    <h1>Could not connect</h1>
    <p>The local app server is not available. Start or restart it, then try again.</p>
    <button type="button" onclick="window.location.reload()">Try again</button>
  </main>
</body>
</html>"#;

#[cfg(feature = "desktop")]
pub fn run() {
    let mut context = tauri::generate_context!();
    if DEVELOPMENT {
        let config = context.config_mut();
        config.identifier = "dev.pi.desktop.debug".into();
        config.product_name = Some(APP_TITLE.into());
        for window in &mut config.app.windows { window.title = APP_TITLE.into(); }
    }
    #[cfg(target_os = "linux")]
    let (context, start_window) = {
        let mut context = context;
        let window = context.config_mut().app.windows.first_mut().expect("Missing main window configuration");
        let start_window = window.visible.then(|| (window.label.clone(), window.focus));
        window.visible = false;
        if let Ok(value) = std::env::var("PI_WINDOW_BOUNDS") {
            #[derive(Deserialize)]
            struct WindowBounds { x: i32, y: i32, width: u32, height: u32 }
            let bounds: WindowBounds = serde_json::from_str(&value).expect("Invalid PI_WINDOW_BOUNDS");
            window.x = Some(f64::from(bounds.x));
            window.y = Some(f64::from(bounds.y));
            window.width = f64::from(bounds.width);
            window.height = f64::from(bounds.height);
            window.decorations = false;
        }
        (context, start_window)
    };
    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder.plugin(tauri_plugin_dialog::init()).manage(voice::VoiceRuntime::default()).manage(desktop_daemon::DesktopDaemon::default()).setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
        for window in app.webview_windows().values() { configure_dictation_microphone(window)?; }
        #[cfg(target_os = "linux")]
        if let Some((label, focus)) = start_window.as_ref() {
            use gtk::prelude::GtkWindowExt;
            use webkit2gtk::WebViewExt;
            let window = app.get_webview_window(label).ok_or("Missing main window")?;
            window.with_webview(|platform_webview| {
                platform_webview.inner().connect_load_failed(|webview, _, failing_uri, _| {
                    webview.load_alternate_html(LOAD_ERROR_HTML, failing_uri, None);
                    true
                });
            })?;
            window.gtk_window()?.set_focus_on_map(*focus);
            window.show()?;
        }
        Ok(())
    }).invoke_handler(tauri::generate_handler![daemon_invoke, voice_configuration, voice_start, voice_stop, voice_mute, voice_suppress, new_window, open_project_directory, open_external_url, read_dropped_file]).build(context).expect("error while building piop").run(|app, event| {
        if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
            let app = app.clone(); let label = label.clone();
            tauri::async_runtime::spawn(async move { app.state::<desktop_daemon::DesktopDaemon>().close_window(&app, &label).await; });
        }
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<voice::VoiceRuntime>().shutdown();
        }
    });
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
