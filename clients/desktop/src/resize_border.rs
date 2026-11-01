pub fn keep_resize_presses_from_page(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.with_webview(|webview| {
        use gtk::{glib::Propagation, prelude::*};
        webview.inner().connect_button_press_event(|view, event| {
            if event.button() == 1 && starts_resize(view, event) { Propagation::Stop } else { Propagation::Proceed }
        });
    }).map_err(|error| error.to_string())
}

fn starts_resize(view: &webkit2gtk::WebView, event: &gtk::gdk::EventButton) -> bool {
    use gtk::prelude::*;
    const BORDER: i32 = 5;
    let Some(window) = view.parent().and_then(|parent| parent.parent()).and_then(|parent| parent.downcast::<gtk::Window>().ok()) else { return false; };
    if window.is_decorated() || !window.is_resizable() || window.is_maximized() { return false; }
    let Some(surface) = window.window() else { return false; };
    let (root_x, root_y) = event.root();
    let (left, top) = surface.position();
    let (x, y) = (root_x - f64::from(left), root_y - f64::from(top));
    let border = f64::from(surface.scale_factor() * BORDER);
    x < border || x >= f64::from(surface.width()) - border || y < border || y >= f64::from(surface.height()) - border
}
