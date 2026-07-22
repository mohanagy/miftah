import { describe, expect, it } from "vitest";
import {
  OAuthConnectionCommandService,
  type OAuthCommandRuntime,
  type OAuthCommandRuntimeFactory,
  type OAuthCommandRuntimeOptions
} from "../src/oauth/connection-command-service.js";
import type { RedactedOAuthConnection, RedactedOAuthConnectionStatus } from "../src/oauth/remote-oauth-runtime.js";

const work: RedactedOAuthConnection = {
  connectionRef: "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5",
  profile: "work",
  upstream: "default",
  resource: "https://work.example.test/mcp",
  issuer: "https://work.example.test",
  clientRegistration: "dynamic",
  scopes: ["mcp:tools"]
};
const personal: RedactedOAuthConnection = {
  ...work,
  connectionRef: "oauthconn:0df64944-d110-4b94-8cb0-b2d85b98a8da",
  profile: "personal",
  resource: "https://personal.example.test/mcp",
  issuer: "https://personal.example.test"
};

function status(connection: RedactedOAuthConnection, credentialState: RedactedOAuthConnectionStatus["credentialState"] = "connected") {
  return {
    ...connection,
    credentialState,
    identityState: "verified" as const,
    updatedAt: "2026-07-22T00:00:00.000Z"
  };
}

class FakeRuntime implements OAuthCommandRuntime {
  readonly tested: Array<{ profile: string; upstream: string }> = [];
  readonly disconnected: Array<{ profile: string; upstream: string }> = [];
  closed = false;

  connections(): readonly RedactedOAuthConnection[] {
    return [personal, work];
  }

  async status(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus> {
    void upstream;
    return status(profile === "work" ? work : personal);
  }

  async disconnect(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus> {
    this.disconnected.push({ profile, upstream });
    return status(profile === "work" ? work : personal, "disconnected");
  }

  async test(profile: string, upstream: string): Promise<{ readonly toolCount: number; readonly identityStatus: string }> {
    this.tested.push({ profile, upstream });
    return { toolCount: 7, identityStatus: "verified" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFactory implements OAuthCommandRuntimeFactory {
  readonly opens: OAuthCommandRuntimeOptions[] = [];
  readonly runtimes: FakeRuntime[] = [];

  async connections(): Promise<readonly RedactedOAuthConnection[]> {
    return [personal, work];
  }

  async open(_configPath: string, options: OAuthCommandRuntimeOptions): Promise<OAuthCommandRuntime> {
    this.opens.push(options);
    const runtime = new FakeRuntime();
    this.runtimes.push(runtime);
    return runtime;
  }
}

describe("OAuth connection command service", () => {
  it("preserves legacy configurations by listing no native OAuth connections without opening a runtime", async () => {
    const factory = new FakeFactory();
    factory.connections = async () => [];
    const service = new OAuthConnectionCommandService("legacy.json", factory);

    await expect(service.list()).resolves.toEqual([]);
    expect(factory.opens).toEqual([]);
  });

  it("lists redacted status deterministically and closes its runtime", async () => {
    const factory = new FakeFactory();
    const service = new OAuthConnectionCommandService("miftah.json", factory);

    await expect(service.list()).resolves.toEqual([status(personal), status(work)]);
    expect(factory.opens).toEqual([{ interactiveAuthorization: false }]);
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect(JSON.stringify(await service.list())).not.toContain("accessToken");
  });

  it("requires an exact selector when multiple connections exist", async () => {
    const service = new OAuthConnectionCommandService("miftah.json", new FakeFactory());

    await expect(service.status({})).rejects.toMatchObject({ code: "OAUTH_CONNECTION_TARGET_REQUIRED" });
    await expect(service.status({ upstream: "default" })).rejects.toMatchObject({
      code: "OAUTH_CONNECTION_TARGET_REQUIRED"
    });
  });

  it("tests without browser authorization and connects or reauthenticates only when explicitly requested", async () => {
    const factory = new FakeFactory();
    const service = new OAuthConnectionCommandService("miftah.json", factory);
    const selector = { connectionRef: work.connectionRef };

    await expect(service.test(selector)).resolves.toMatchObject({ ok: true, toolCount: 7, connection: status(work) });
    await expect(service.connect(selector, { nonInteractive: true })).resolves.toMatchObject({
      ok: true,
      connection: status(work)
    });
    await expect(service.reauth(selector)).resolves.toMatchObject({ ok: true, connection: status(work) });

    expect(factory.opens).toEqual([
      { interactiveAuthorization: false, upstreamAccess: true },
      { interactiveAuthorization: false, upstreamAccess: true },
      {
        interactiveAuthorization: true,
        upstreamAccess: true,
        forceAuthorization: { profile: "work", upstream: "default" }
      }
    ]);
    expect(factory.runtimes.every((runtime) => runtime.closed)).toBe(true);
  });

  it("disconnects only the selected exact binding", async () => {
    const factory = new FakeFactory();
    const service = new OAuthConnectionCommandService("miftah.json", factory);

    await expect(service.disconnect({ profile: "personal", upstream: "default" })).resolves.toEqual(status(personal, "disconnected"));
    expect(factory.runtimes[0]?.disconnected).toEqual([{ profile: "personal", upstream: "default" }]);
    expect(factory.runtimes[0]?.closed).toBe(true);
  });
});
