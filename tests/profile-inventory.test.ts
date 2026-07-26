import { describe, expect, it } from "vitest";
import { profileInventory } from "../src/profiles/profile-inventory.js";
import type { MiftahConfig } from "../src/config/types.js";

describe("profile inventory", () => {
  it("returns only stable account metadata and omits secret-bearing launch configuration", () => {
    const config: MiftahConfig = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: {
        transport: "stdio",
        command: "node",
        args: ["server.mjs"]
      },
      profiles: {
        work: {
          description: "Work analytics account",
          tags: ["production", "team"],
          policy: "readonly",
          env: { API_TOKEN: "secretref:env://WORK_API_TOKEN" },
          headers: { Authorization: "Bearer secretref:env://WORK_HEADER" },
          args: ["--workspace=work"],
          cwd: "/private/work",
          upstreams: {
            default: { env: { CHILD_TOKEN: "secretref:env://CHILD_TOKEN" } }
          }
        },
        personal: {
          description: "Personal analytics account"
        }
      }
    };

    const inventory = profileInventory(config);

    expect(inventory).toEqual({
      defaultProfile: "work",
      profiles: [
        { name: "personal", description: "Personal analytics account" },
        {
          name: "work",
          description: "Work analytics account",
          tags: ["production", "team"],
          policy: "readonly",
          upstreams: ["default"]
        }
      ]
    });
    expect(JSON.stringify(inventory)).not.toContain("secretref:");
    expect(JSON.stringify(inventory)).not.toContain("/private/work");
    expect(JSON.stringify(inventory)).not.toContain("--workspace=work");
  });
});
