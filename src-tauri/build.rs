fn main() {
    #[cfg(feature = "desktop")]
    {
        println!("cargo:rerun-if-changed=../dist/index.html");
        tauri_build::build()
    }
}
