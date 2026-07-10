import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/main": "src/cli/main.ts",
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node"
  }
});
