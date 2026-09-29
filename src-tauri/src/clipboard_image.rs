#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        use base64::Engine;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_image(move |_, image| {
                let result = image.map(|image| image.save_to_bufferv("png", &[])
                    .map_err(|error| error.to_string()).and_then(|bytes| {
                        if bytes.len() > 10 * 1024 * 1024 { return Err("Screenshot exceeds the 10 MB image limit".into()); }
                        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
                    })).transpose();
                let _ = sender.send(result);
            });
        }).map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(5), receiver).await
            .map_err(|_| "Clipboard image request timed out".to_string())?
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = app; Ok(None) }
}
