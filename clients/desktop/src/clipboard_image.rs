pub fn configure_image_copy(window: &tauri::WebviewWindow) -> Result<(), String> {
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
    Ok(())
}

fn embedded_image(uri: &str) -> Option<gtk::gdk_pixbuf::Pixbuf> {
    use base64::Engine;
    let (mime_type, data) = uri.strip_prefix("data:")?.split_once(";base64,")?;
    if !matches!(mime_type, "image/png" | "image/jpeg" | "image/gif" | "image/webp") { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    gtk::gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(bytes)).ok()
}

#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use base64::Engine;
    const RAW_IMAGE_LIMIT: usize = 256 * 1024 * 1024;
    const ENCODED_IMAGE_LIMIT: usize = 10 * 1024 * 1024;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_image(move |_, image| {
            let result = image.map(|image| {
                let (width, height, stride) = (image.width(), image.height(), image.rowstride());
                if width <= 0 || height <= 0 || stride <= 0 {
                    return Err("Screenshot has invalid image dimensions".to_string());
                }
                if (stride as usize).checked_mul(height as usize).is_none_or(|size| size > RAW_IMAGE_LIMIT) || image.byte_length() > RAW_IMAGE_LIMIT {
                    return Err("Screenshot exceeds the 256 MiB raw image limit".to_string());
                }
                Ok((image.read_pixel_bytes().as_ref().to_vec(), image.has_alpha(), image.bits_per_sample(), width, height, stride))
            }).transpose();
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;
    let image = tokio::time::timeout(std::time::Duration::from_secs(5), receiver).await
        .map_err(|_| "Clipboard image request timed out".to_string())?
        .map_err(|error| error.to_string())??;
    let Some((pixels, alpha, bits, width, height, stride)) = image else { return Ok(None); };
    tauri::async_runtime::spawn_blocking(move || {
        let image = gtk::gdk_pixbuf::Pixbuf::from_bytes(&gtk::glib::Bytes::from_owned(pixels), gtk::gdk_pixbuf::Colorspace::Rgb, alpha, bits, width, height, stride);
        let bytes = image.save_to_bufferv("png", &[]).map_err(|error| error.to_string())?;
        if bytes.len() > ENCODED_IMAGE_LIMIT { return Err("Screenshot exceeds the 10 MiB encoded PNG limit".to_string()); }
        Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(|error| error.to_string())?
}
