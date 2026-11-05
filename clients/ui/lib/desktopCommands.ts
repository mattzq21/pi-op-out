// The commands that the desktop app runs itself. The other commands go to the daemon.
export const DESKTOP_COMMANDS: readonly string[] = ["load_client_settings", "save_client_settings", "new_window", "open_external_url", "open_project_directory", "open_rollout_file", "open_local_file", "reveal_local_file", "read_dropped_file"];

// The desktop commands that the daemon does not have.
export type NativeCommand = "load_client_settings" | "save_client_settings" | "new_window" | "open_external_url" | "open_rollout_file" | "open_local_file" | "reveal_local_file" | "read_dropped_file";
