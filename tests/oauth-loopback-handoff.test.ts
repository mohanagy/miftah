import { describe, expect, it, vi } from "vitest";
import { createLoopbackOAuthAuthorizationHandoff } from "../src/oauth/loopback-authorization-handoff.js";

describe("OAuth loopback authorization handoff", () => {
  it("accepts one exact state and issuer callback without reflecting authorization data", async () => {
    let opened: URL | undefined;
    const handoff = await createLoopbackOAuthAuthorizationHandoff({
      openExternal: async (url) => {
        opened = new URL(url);
      }
    });
    const authorizationUrl = new URL("https://issuer.example.test/authorize");
    authorizationUrl.searchParams.set("state", "fixture-state-value-that-is-long-enough");
    authorizationUrl.searchParams.set("code_challenge", "fixture-code-challenge");

    try {
      const code = handoff.authorize(authorizationUrl, {
        state: "fixture-state-value-that-is-long-enough",
        issuer: "https://issuer.example.test"
      });
      await vi.waitFor(() => expect(opened).toEqual(authorizationUrl));

      const hostileOrigin = new URL(handoff.redirectUrl);
      hostileOrigin.searchParams.set("code", "hostile-origin-code");
      hostileOrigin.searchParams.set("state", "fixture-state-value-that-is-long-enough");
      hostileOrigin.searchParams.set("iss", "https://issuer.example.test");
      const hostileOriginResponse = await fetch(hostileOrigin, {
        headers: { origin: "https://hostile.example.test" }
      });
      expect(hostileOriginResponse.status).toBe(400);
      expect(await hostileOriginResponse.text()).not.toContain("hostile-origin-code");

      const wrongState = new URL(handoff.redirectUrl);
      wrongState.searchParams.set("code", "wrong-code");
      wrongState.searchParams.set("state", "wrong-state");
      wrongState.searchParams.set("iss", "https://issuer.example.test");
      const rejectedResponse = await fetch(wrongState);
      expect(rejectedResponse.status).toBe(400);
      expect(await rejectedResponse.text()).not.toContain("wrong-code");

      const callback = new URL(handoff.redirectUrl);
      callback.searchParams.set("code", "fixture-authorization-code");
      callback.searchParams.set("state", "fixture-state-value-that-is-long-enough");
      callback.searchParams.set("iss", "https://issuer.example.test");
      const acceptedResponse = await fetch(callback);
      const page = await acceptedResponse.text();

      await expect(code).resolves.toBe("fixture-authorization-code");
      expect(acceptedResponse.status).toBe(200);
      expect(page).not.toContain("fixture-authorization-code");
      expect(page).not.toContain("fixture-state-value-that-is-long-enough");
      expect(page).not.toContain("issuer.example.test");
    } finally {
      await handoff.close();
    }
  });

  it("rejects duplicate issuer parameters without consuming the pending authorization", async () => {
    const handoff = await createLoopbackOAuthAuthorizationHandoff({ openExternal: async () => undefined });
    const state = "fixture-state-value-that-is-long-enough";
    const issuer = "https://issuer.example.test";
    const authorizationUrl = new URL(`${issuer}/authorize`);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", "fixture-code-challenge");

    try {
      const code = handoff.authorize(authorizationUrl, { state, issuer });
      const duplicateIssuer = new URL(handoff.redirectUrl);
      duplicateIssuer.searchParams.set("code", "must-not-be-accepted");
      duplicateIssuer.searchParams.set("state", state);
      duplicateIssuer.searchParams.append("iss", issuer);
      duplicateIssuer.searchParams.append("iss", issuer);

      const rejectedResponse = await fetch(duplicateIssuer);
      expect(rejectedResponse.status).toBe(400);
      expect(await rejectedResponse.text()).not.toContain("must-not-be-accepted");

      const callback = new URL(handoff.redirectUrl);
      callback.searchParams.set("code", "accepted-code");
      callback.searchParams.set("state", state);
      callback.searchParams.set("iss", issuer);
      expect((await fetch(callback)).status).toBe(200);
      await expect(code).resolves.toBe("accepted-code");
    } finally {
      await handoff.close();
    }
  });

  it("rejects an exact-state provider error without reflecting provider data", async () => {
    const handoff = await createLoopbackOAuthAuthorizationHandoff({ openExternal: async () => undefined });
    const state = "fixture-state-value-that-is-long-enough";
    const issuer = "https://issuer.example.test";
    const authorizationUrl = new URL(`${issuer}/authorize`);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", "fixture-code-challenge");

    try {
      const code = handoff.authorize(authorizationUrl, { state, issuer });
      const rejectedCode = expect(code).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_FAILED" });
      const callback = new URL(handoff.redirectUrl);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "sensitive provider detail");
      callback.searchParams.set("state", state);
      callback.searchParams.set("iss", issuer);

      const response = await fetch(callback);
      const page = await response.text();
      expect(response.status).toBe(400);
      expect(page).not.toContain("access_denied");
      expect(page).not.toContain("sensitive provider detail");
      await rejectedCode;
    } finally {
      await handoff.close();
    }
  });

  it("rejects a pending authorization when closed and cannot be reused", async () => {
    const handoff = await createLoopbackOAuthAuthorizationHandoff({ openExternal: async () => undefined });
    const state = "fixture-state-value-that-is-long-enough";
    const issuer = "https://issuer.example.test";
    const authorizationUrl = new URL(`${issuer}/authorize`);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", "fixture-code-challenge");

    const pending = handoff.authorize(authorizationUrl, { state, issuer });
    const rejectedPending = expect(pending).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_FAILED" });
    await handoff.close();
    await rejectedPending;
    await expect(handoff.authorize(authorizationUrl, { state, issuer })).rejects.toMatchObject({
      code: "OAUTH_AUTHORIZATION_FAILED"
    });
  });

  it("bounds the pending authorization lifetime", async () => {
    const handoff = await createLoopbackOAuthAuthorizationHandoff({
      openExternal: async () => undefined,
      timeoutMs: 10
    });
    const state = "fixture-state-value-that-is-long-enough";
    const issuer = "https://issuer.example.test";
    const authorizationUrl = new URL(`${issuer}/authorize`);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", "fixture-code-challenge");

    try {
      await expect(handoff.authorize(authorizationUrl, { state, issuer })).rejects.toMatchObject({
        code: "OAUTH_AUTHORIZATION_FAILED"
      });
    } finally {
      await handoff.close();
    }
  });
});
