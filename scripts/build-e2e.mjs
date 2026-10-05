import { parallelBuilds, runBuild } from "./build-cache.mjs";

const cargo = ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--release"];

await runBuild(process.execPath, ["scripts/build-extensions.mjs"]);

await parallelBuilds([
  runBuild(process.execPath, ["scripts/build-frontend.mjs", "--mode", "e2e"]),
  runBuild("cargo", [...cargo, "--no-default-features", "--features", "daemon,test-home", "--bin", "piopd"]),
]);

await runBuild("cargo", [...cargo, "--features", "webdriver", "--bin", "piop"], {
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({
      bundle: { externalBin: [] },
      build: { devUrl: null },
      app: { windows: [{ title: "piop", width: 1440, height: 900, minWidth: 900, minHeight: 640, focus: false, decorations: false, transparent: false }] },
    }),
  },
});
