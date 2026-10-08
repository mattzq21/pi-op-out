import { parallelBuilds, runBuild } from "./build-cache.mjs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { mode: { type: "string", default: "desktop" }, debug: { type: "boolean" } } });

if (!["desktop", "e2e"].includes(values.mode)) throw new Error(`Unknown build mode: ${values.mode}`);

if (values.mode === "e2e" && values.debug) throw new Error("E2E builds require release mode");

await runBuild(process.execPath, ["scripts/build-extensions.mjs"]);

async function desktop() {
  await parallelBuilds([
    runBuild(process.execPath, ["scripts/build-frontend.mjs"]),
    runBuild(process.execPath, ["scripts/build-daemon.mjs", "--skip-extensions", ...(values.debug ? ["--debug"] : [])]),
  ]);
}

async function e2e() {
  const cargo = ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--release"];

  await parallelBuilds([
    runBuild(process.execPath, ["scripts/build-frontend.mjs", "--mode", "e2e"]),
    runBuild("cargo", [...cargo, "-p", "piop-daemon", "--features", "test-home", "--bin", "piopd"]),
  ]);

  await runBuild("cargo", [...cargo, "-p", "piop-desktop", "--features", "webdriver", "--bin", "piop"], {
    env: {
      ...process.env,
      TAURI_CONFIG: JSON.stringify({
        bundle: { externalBin: [] },
        build: { devUrl: null },
        app: { windows: [{ title: "piop", width: 1440, height: 900, minWidth: 900, minHeight: 640, focus: false, decorations: false, transparent: false }] },
      }),
    },
  });
}

await (values.mode === "e2e" ? e2e() : desktop());
