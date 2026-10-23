fn main() {
    unsafe { std::env::set_var("GTK_OVERLAY_SCROLLING", "0") };
    piop_desktop::run();
}
