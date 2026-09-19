fn main() {
    piop_lib::run_session_worker();
    // Keep WebKitGTK scrollbars at their declared CSS size instead of expanding
    // an overlay scrollbar when the pointer moves over it.
    unsafe { std::env::set_var("GTK_OVERLAY_SCROLLING", "0") };
    piop_lib::run();
}
