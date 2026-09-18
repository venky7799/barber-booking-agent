import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function compile() {
  const tsc = require.resolve("typescript/bin/tsc");
  console.log("[boot] compiling TypeScript to dist/");
  const result = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync("dist/index.js")) {
  compile();
}

await import("./dist/index.js");
