import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "linux") {
  const dependencies = spawnSync("pkg-config", ["--print-errors", "--exists", "gstreamer-1.0 >= 1.28", "gstreamer-app-1.0 >= 1.28", "gstreamer-audio-1.0 >= 1.28", "alsa"], { encoding: "utf8" });
  if (dependencies.error || dependencies.status !== 0) {
    console.error("Piop voice requires the GStreamer 1.28+ and ALSA development packages.");
    console.error("On Ubuntu/Debian: sudo apt install pkg-config libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libasound2-dev liborc-0.4-dev");
    console.error(dependencies.error?.message || dependencies.stderr.trim());
    process.exit(1);
  }
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
};
const triple = run("rustc", ["-vV"], { encoding: "utf8", stdio: "pipe" }).stdout.match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("Could not determine the native Rust target");
run("cargo", ["build", "--manifest-path", "src-tauri/voice-host/Cargo.toml", "--release", "--locked"]);
const extension = process.platform === "win32" ? ".exe" : "";
mkdirSync(new URL("../src-tauri/binaries/", import.meta.url), { recursive: true });
copyFileSync(new URL(`../src-tauri/voice-host/target/release/piop-voice-host${extension}`, import.meta.url), new URL(`../src-tauri/binaries/piop-voice-host-${triple}${extension}`, import.meta.url));
