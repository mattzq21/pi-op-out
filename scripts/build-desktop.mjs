import { parallelBuilds, runBuild } from "./build-cache.mjs";

await runBuild(process.execPath, ["scripts/build-extensions.mjs"]);

await parallelBuilds([
  runBuild(process.execPath, ["scripts/build-frontend.mjs"]),
  runBuild(process.execPath, ["scripts/build-daemon.mjs", "--skip-extensions", ...(process.argv.includes("--debug") ? ["--debug"] : [])]),
]);
