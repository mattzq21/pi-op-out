import { parallelBuilds, runBuild } from "./build-cache.mjs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { debug: { type: "boolean" } } });

await runBuild(process.execPath, ["scripts/build-extensions.mjs"]);

await parallelBuilds([
  runBuild(process.execPath, ["scripts/build-frontend.mjs"]),
  runBuild(process.execPath, ["scripts/build-daemon.mjs", "--skip-extensions", ...(values.debug ? ["--debug"] : [])]),
]);
