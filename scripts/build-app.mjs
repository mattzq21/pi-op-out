import { runBuild } from "./build-cache.mjs";

const args = process.argv.slice(2);
const all = args[0] === "all";
if (all) args.shift();

await runBuild(process.execPath, ["scripts/tauri.mjs", "build", ...args]);
if (all) await runBuild(process.execPath, ["run", "android:build"]);
