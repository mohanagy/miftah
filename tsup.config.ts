import { defineConfig } from "tsup";
import { packageVersion } from "./build/package-version.js";

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
  publicDir: "assets",
  sourcemap: true,
  define: {
    __MIFTAH_VERSION__: JSON.stringify(packageVersion)
  },
  banner: {
    js: "#!/usr/bin/env node"
  }
});
