import { buildInParallel } from "./incremental-build.mjs";

await buildInParallel([
  import("./build-mcp-bridge.mjs"),
  import("./build-fast-mode.mjs"),
  import("./build-backend-scripts.mjs"),
]);
