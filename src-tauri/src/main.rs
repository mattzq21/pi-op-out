fn main() {
    // Keep WebKitGTK scrollbars at their declared CSS size instead of expanding
    // an overlay scrollbar when the pointer moves over it.
    unsafe { std::env::set_var("GTK_OVERLAY_SCROLLING", "0") };
    pi_desktop_lib::run();
}
