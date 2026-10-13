// Test-only entry of the E2E build: imports run in order, so the bridge loads before the app.
import "./tauri-core";
import "../../../clients/ui/main";
