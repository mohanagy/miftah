import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig } from "tsup";
import { packageVersion } from "./build/package-version.js";

async function copyBundledDependencyLicenses(): Promise<void> {
  const destination = new URL("./dist/third-party/", import.meta.url);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    copyFile(
      new URL("./node_modules/@modelcontextprotocol/node/LICENSE", import.meta.url),
      new URL("./modelcontextprotocol-node.LICENSE", destination)
    ),
    copyFile(
      new URL("./node_modules/@hono/node-server/LICENSE", import.meta.url),
      new URL("./hono-node-server.LICENSE", destination)
    ),
    copyFile(
      new URL("./node_modules/hono/LICENSE", import.meta.url),
      new URL("./hono.LICENSE", destination)
    )
  ]);
}

export default defineConfig({
  entry: {
    "cli/main": "src/cli/main.ts",
    index: "src/index.ts",
    "plugin-api": "src/plugins/plugin-api.ts",
    "plugin-host": "src/plugin-host.mjs"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // The v2 Node adapter still constrains @hono/node-server to vulnerable 1.x.
  // Bundle the tested patched adapter into the CLI instead of exporting that
  // unsatisfied transitive range to Miftah's installed production tree.
  noExternal: ["@modelcontextprotocol/node", "@hono/node-server", "hono"],
  onSuccess: copyBundledDependencyLicenses,
  publicDir: "assets",
  sourcemap: true,
  define: {
    __MIFTAH_VERSION__: JSON.stringify(packageVersion)
  },
  banner: {
    js: "#!/usr/bin/env node"
  }
});
