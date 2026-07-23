import * as module from "node:module";

if (typeof module.enableCompileCache === "function") {
  module.enableCompileCache();
}

await import("./fake-upstream-bundled.mjs");

if (typeof module.flushCompileCache === "function") {
  module.flushCompileCache();
}
