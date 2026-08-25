fn main() {
    #[cfg(target_os = "linux")]
    std::env::set_var("GTK_OVERLAY_SCROLLING", "0");
    pi_desktop_lib::run();
}
