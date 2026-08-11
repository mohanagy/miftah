import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

describe("MCP TypeScript SDK v2 migration contract", () => {
  it("ships only the stable split SDK packages required by Miftah", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
    const dependencies = manifest.dependencies ?? {};

    expect(dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(dependencies).not.toHaveProperty("@modelcontextprotocol/server-legacy");
    expect(dependencies).toMatchObject({
      "@modelcontextprotocol/client": "^2.0.0",
      "@modelcontextprotocol/core": "^2.0.0",
      "@modelcontextprotocol/server": "^2.0.0",
      zod: "^4.2.0"
    });
    expect(manifest.devDependencies).toMatchObject({
      "@hono/node-server": "2.0.10",
      "@modelcontextprotocol/node": "^2.0.0",
      "@modelcontextprotocol/server-legacy": "^2.0.0",
      hono: "4.12.34"
    });
  });
});
