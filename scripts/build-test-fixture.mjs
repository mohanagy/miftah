import { error as logError } from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "tests", "fixtures", "fake-upstream-bundled.mjs");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["tests/fixtures/fake-upstream-runtime.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  write: false
});
const bundledSource = result.outputFiles[0].text;

if (process.argv.includes("--check")) {
  let currentSource;
  try {
    currentSource = await readFile(outputPath, "utf8");
  } catch {
    currentSource = undefined;
  }

  if (currentSource !== bundledSource) {
    logError("The bundled fake upstream fixture is stale. Run `npm run build:test-fixture`.");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, bundledSource);
}
