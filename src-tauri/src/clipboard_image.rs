pub fn configure_image_copy(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    window.with_webview(|webview| {
        use webkit2gtk::{ContextMenuAction, ContextMenuExt, ContextMenuItem, ContextMenuItemExt, HitTestResultExt, WebViewExt};
        webview.inner().connect_context_menu(|_, menu, _, hit| {
            let Some((position, item)) = menu.items().into_iter().enumerate()
                .find(|(_, item)| item.stock_action() == ContextMenuAction::CopyImageToClipboard) else { return false; };
            let Some(image) = hit.image_uri().and_then(|uri| embedded_image(&uri)) else { return false; };
            let action = gtk::gio::SimpleAction::new("copy-image", None);
            action.connect_activate(move |_, _| {
                let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
                clipboard.set_image(&image);
                clipboard.store();
            });
            menu.remove(&item);
            menu.insert(&ContextMenuItem::from_gaction(&action, "Copy Image", None), position as i32);
            false
        });
    }).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

#[cfg(target_os = "linux")]
fn embedded_image(uri: &str) -> Option<gtk::gdk_pixbuf::Pixbuf> {
    use base64::Engine;
    let (mime_type, data) = uri.strip_prefix("data:")?.split_once(";base64,")?;
    if !matches!(mime_type, "image/png" | "image/jpeg" | "image/gif" | "image/webp") { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    gtk::gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(bytes)).ok()
}

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
