fn main() {
    println!("cargo:rerun-if-env-changed=PIOP_DEV");
    let development = std::env::var("DEBUG").as_deref() == Ok("true")
        || std::env::var("PIOP_DEV").as_deref() == Ok("1");
    println!("cargo:rustc-env=PIOP_STORAGE_DIRECTORY={}", if development { ".piop-dev" } else { ".piop" });
    println!("cargo:rustc-env=PIOP_DEVELOPMENT={}", if development { "1" } else { "0" });
    println!("cargo:rerun-if-changed=../dist/index.html");
    tauri_build::build()
}
