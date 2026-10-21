fn main() {
    println!("cargo:rerun-if-changed=../../dist/index.html");
    let dictation = tauri_build::InlinedPlugin::new()
        .commands(&["dictation_configuration", "dictation_find_engines", "dictation_stream_start", "dictation_stream_feed", "dictation_stream_finish", "dictation_stream_cancel"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("dictation", dictation)).expect("failed to run tauri-build")
}
