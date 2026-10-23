mod platform;
mod daemon_endpoint;
mod desktop_daemon;
mod client_settings;
#[path = "settings_concurrency.rs"]
mod settings_concurrency;
#[path = "private_fs.rs"]
mod private_fs;
use private_fs::ensure_private_dir;
mod clipboard_image;
use clipboard_image::{configure_image_copy, read_clipboard_image};
use client_settings::{load_client_settings, save_client_settings};
use desktop_daemon::{daemon_invoke, daemon_log_statuses};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, thread, time::Duration};
use crate::platform::AppHandle;
use tauri::{Emitter, Manager};
use uuid::Uuid;
const STORAGE_DIRECTORY: &str = if cfg!(debug_assertions) { ".piop-dev" } else { ".piop" };
const DEVELOPMENT: bool = cfg!(debug_assertions);
const APP_TITLE: &str = if DEVELOPMENT { "Piop Dev" } else { "piop" };

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

#[tauri::command]
fn new_window(app: AppHandle, target: Value) -> Result<String, String> {
    let (label, path) = conversation_window_target(&target)?;
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.into()))
        .decorations(false)
        .background_color(tauri::window::Color(24, 24, 23, 255))
        .title(APP_TITLE).inner_size(1280.0, 800.0).min_inner_size(900.0, 640.0)
        .build().map_err(|error| error.to_string())?;
    configure_image_copy(&window)?;
    Ok(label)
}

fn conversation_window_target(target: &Value) -> Result<(String, String), String> {
    if !target["sessionId"].as_str().is_some_and(|id| !id.trim().is_empty()) { return Err("Select a conversation to open in another window".into()); }
    let label = format!("chat-{}", Uuid::new_v4());
    let mut url = tauri::Url::parse("https://piop.invalid/").map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("target", &target.to_string());
    let path = format!("index.html{}", url.query().map(|query| format!("?{query}")).unwrap_or_default());
    Ok((label, path))
}

fn open_system_resource(target: &std::ffi::OsStr) -> Result<(), String> {
    let mut child = Command::new("xdg-open").arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy()))?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = child.wait().map_err(|error| format!("Could not wait for xdg-open: {error}"))
            .and_then(|status| if status.success() { Ok(()) } else { Err(format!("xdg-open failed ({status})")) });
        if let Err(mpsc::SendError(Err(error))) = sender.send(result) { eprintln!("{error}"); }
    });
    match receiver.recv_timeout(Duration::from_secs(3)) {
        Ok(result) => result.map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy())),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
        Err(error) => Err(format!("Could not wait for xdg-open: {error}")),
    }
}
#[tauri::command]
async fn read_dropped_file(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || read_attachment(&path)).await.map_err(|error| error.to_string())?
}

fn read_attachment(path: &str) -> Result<Value, String> {
    let path = Path::new(path);
    if !fs::metadata(path).map_err(|error| error.to_string())?.is_file() { return Err("Drop regular files only".to_string()); }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Drop regular files only".to_string()); }
    let limit = 10 * 1024 * 1024;
    if metadata.len() > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let name = path.file_name().ok_or("Attachment has no filename")?.to_string_lossy();
    Ok(json!({ "name": name, "data": data }))
}
#[tauri::command(async)]
async fn open_external_url(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_external_url_with(&url, open_system_resource)).await.map_err(|error| error.to_string())?
}

fn open_external_url_with(url: &str, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() { return Err("Only HTTP and HTTPS links can be opened in the browser".into()); }
    open(std::ffi::OsStr::new(parsed.as_str()))
}

#[tauri::command(async)]
async fn open_project_directory(cwd: String, host_id: Option<String>) -> Result<(), String> {
    if std::env::var_os("PIOP_DAEMON_URL").is_some() || host_id.as_deref().unwrap_or("local") != "local" { return Err("Opening remote project directories is not supported by the local file manager".into()); }
    let path = PathBuf::from(cwd);
    if !path.is_dir() { return Err(format!("Project directory does not exist: {}", path.display())); }
    tokio::task::spawn_blocking(move || open_system_resource(path.as_os_str())).await.map_err(|error| error.to_string())?
}

#[tauri::command(async)]
async fn open_rollout_file(path: String, host_id: Option<String>) -> Result<(), String> {
    if std::env::var_os("PIOP_DAEMON_URL").is_some() || host_id.as_deref().unwrap_or("local") != "local" { return Err("Opening remote rollout files is not supported by the local file manager".into()); }
    let path = PathBuf::from(path);
    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") || !path.is_file() { return Err("Session rollout file does not exist or is not a JSONL file".into()); }
    tokio::task::spawn_blocking(move || open_system_resource(path.as_os_str())).await.map_err(|error| error.to_string())?
}

#[tauri::command(async)]
async fn open_local_file(path: String, host_id: Option<String>) -> Result<(), String> {
    if std::env::var_os("PIOP_DAEMON_URL").is_some() || host_id.as_deref().unwrap_or("local") != "local" { return Err("This file is on another host. Piop can open only files on this computer".into()); }
    // A path that starts with ~ is in the home directory of this computer.
    let path = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set, thus ~ cannot be found")?).join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    };
    if !path.is_absolute() { return Err(format!("File path is not absolute: {}", path.display())); }
    if !path.exists() { return Err(format!("File does not exist: {}", path.display())); }
    tokio::task::spawn_blocking(move || open_system_resource(path.as_os_str())).await.map_err(|error| error.to_string())?
}

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

#[tauri::command]
async fn reload_development_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !DEVELOPMENT { return Err("Development reload is unavailable".into()); }
    let daemon = app.state::<desktop_daemon::DesktopDaemon>();
    daemon.close_window(&app, window.label()).await;
    daemon.connect(&app, window.label()).await?;
    window.reload().map_err(|error| error.to_string())
}

pub fn run() {
    let mut context = tauri::generate_context!();
    if DEVELOPMENT {
        let config = context.config_mut();
        config.identifier = "dev.pi.desktop.debug".into();
        config.product_name = Some(APP_TITLE.into());
        for window in &mut config.app.windows { window.title = APP_TITLE.into(); }
    }
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
    builder.manage(desktop_daemon::DesktopDaemon::default()).setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
        for window in app.webview_windows().values() {
            configure_image_copy(window)?;
            let handle = app.handle().clone();
            let label = window.label().to_owned();
            tauri::async_runtime::spawn(async move {
                let _ = handle.state::<desktop_daemon::DesktopDaemon>().connect(&handle, &label).await;
            });
        }
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
    }).invoke_handler(tauri::generate_handler![daemon_invoke, daemon_log_statuses, reload_development_window, load_client_settings, save_client_settings, new_window, open_project_directory, open_rollout_file, open_local_file, open_external_url, read_dropped_file, read_clipboard_image]).build(context).expect("error while building piop").run(|app, event| {
        if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
            let app = app.clone(); let label = label.clone();
            tauri::async_runtime::spawn(async move { app.state::<desktop_daemon::DesktopDaemon>().close_window(&app, &label).await; });
        }
        if matches!(event, tauri::RunEvent::Exit) {
        }
    });
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
