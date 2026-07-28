import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/presets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/presets.js")>();
  return {
    ...actual,
    buildPresetConfig(...args: Parameters<typeof actual.buildPresetConfig>) {
      const config = actual.buildPresetConfig(...args);
      return {
        ...config,
        upstream: config.upstream === undefined
          ? undefined
          : { ...config.upstream, headers: { "x-test": "static" } }
      };
    }
  };
});

import {
  ClientEntryImportError,
  createImportedClientConfiguration
} from "../src/setup/client-entry-import.js";

describe("client entry import builder boundary", () => {
  it("rejects credential-bearing upstream fields introduced by a future preset builder", () => {
    expect(() => createImportedClientConfiguration({
      configurationName: "remote-analytics",
      document: JSON.stringify({
        mcpServers: {
          analytics: { type: "http", url: "https://mcp.example.test/mcp" }
        }
      }),
      entry: "analytics"
    })).toThrow(ClientEntryImportError);
  });
});
