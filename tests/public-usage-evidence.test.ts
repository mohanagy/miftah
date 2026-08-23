import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const evidenceUrl = new URL(
  "./fixtures/public-usage-sample-2026-08-23.json",
  import.meta.url
);
const ledgerUrl = new URL("../docs/legacy-retirement-evidence.md", import.meta.url);

describe("bounded public usage evidence", () => {
  it("records reproducible public searches without turning zero results into absence", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8"));

    expect(evidence).toMatchObject({
      issue: 430,
      recordedAt: "2026-08-23",
      classification: "usage-sampling-record",
      evidenceStrength: "no qualifying usage-attestation",
      sampleKind: "bounded-public-source-snapshot",
      decision: "keep-and-collect",
      repeatNotBefore: "2026-09-22",
      package: {
        name: "@lubab/miftah",
        latestVersion: "1.1.3",
        publishedAt: "2026-08-23T13:20:24.632Z"
      }
    });

    expect(evidence.methodology.sources.map((source: { name: string }) => source.name)).toEqual([
      "GitHub code search REST API",
      "GitHub issues and pull requests search REST API",
      "npm downloads API"
    ]);
    expect(
      evidence.github.codeSearch.queries.every(
        (query: { incompleteResults: boolean }) => query.incompleteResults === false
      )
    ).toBe(true);

    const surfaceResults = Object.entries(evidence.surfaceResults).filter(
      ([name]) => name !== "realProviderConfiguration"
    );
    expect(surfaceResults.map(([name]) => name)).toEqual([
      "initialized2025_11_25",
      "roots",
      "resourceSubscriptionsOrListChange",
      "upstreamSse",
      "sdkV1"
    ]);
    for (const [, result] of surfaceResults) {
      expect(result).toEqual({
        qualifyingPublicSamples: 0,
        resultMeaning: "not observed in this bounded sample"
      });
    }
    expect(evidence.limitations).toContain(
      "Zero qualifying samples means not observed in this bounded sample; it is not evidence that usage does not exist."
    );
  });

  it("omits private search results and separates the public false positive", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8"));

    expect(evidence.github.issueAndPullRequestSearch.queries[1]).toMatchObject({
      totalCount: 2,
      privateResultsOmitted: 1,
      publicCandidateCount: 1,
      includedPublicSamples: 0,
      excludedPublicSamples: 1
    });
    expect(evidence.github.issueAndPullRequestSearch.privateResultDetailsRecorded).toBe(false);
    expect(evidence.github.issueAndPullRequestSearch.includedPublicSamples).toEqual([]);
    expect(evidence.surfaceResults.realProviderConfiguration).toEqual({
      qualifyingPublicSamples: 0,
      independentExternalSamples: 0,
      resultMeaning: "not observed in this bounded public sample"
    });
    expect(evidence.github.issueAndPullRequestSearch.excludedPublicSamples).toEqual([
      {
        url: "https://github.com/chaishillomnitech1/Infinite-Nexus-ScrollVerse/pull/26",
        reason:
          "Lexical false positive: Miftah is a personal name and MCP appears only in generic coding-agent guidance; the Miftah package and CLI are not referenced."
      }
    ]);
  });

  it("keeps npm activity indirect and internally consistent", async () => {
    const evidence = JSON.parse(await readFile(evidenceUrl, "utf8"));
    const downloads = evidence.npm.packageRange.daily.reduce(
      (total: number, day: { downloads: number }) => total + day.downloads,
      0
    );

    expect(downloads).toBe(147);
    expect(downloads).toBe(evidence.npm.packageRange.totalDownloads);
    expect(evidence.npm.versionWindow).toMatchObject({
      period: "last-week",
      observedVersionDownloads: { "1.1.2": 58 },
      latestVersion: "1.1.3",
      latestVersionPresent: false,
      latestVersionCountUsable: false
    });
    expect(evidence.npm.claimBoundary).toContain("do not count unique users");
  });

  it("links the record from the retirement ledger and excludes private evidence", async () => {
    const [evidenceText, ledger] = await Promise.all([
      readFile(evidenceUrl, "utf8"),
      readFile(ledgerUrl, "utf8")
    ]);

    expect(ledger).toContain("Public usage sampling — 2026-08-23");
    expect(ledger).toContain("tests/fixtures/public-usage-sample-2026-08-23.json");
    expect(ledger).toContain("zero qualifying public usage samples");
    expect(ledger).toContain("not evidence of absence");
    expect(ledger).toContain("Repeat no earlier than 2026-09-22");

    for (const privateValue of [
      "/Users/",
      "/private/tmp/",
      "craftmyletter",
      "google-craftmyletter",
      "Bearer ",
      "api_key",
      "access_token"
    ]) {
      expect(evidenceText).not.toContain(privateValue);
    }
  });
});
