import { describe, expect, it } from "vitest";
import { matchProviderBindings, projectProviderMatcherInput } from "../src/routing/provider-matchers.js";

describe("provider routing matchers", () => {
  it("matches a canonical GitHub repository from an allowlisted argument and safe Git context", () => {
    const input = projectProviderMatcherInput(
      "github__search_issues",
      {
        repository: "acme/miftah",
        nested: { repository: "other/private" },
        accessToken: "must-not-reach-a-matcher"
      },
      { githubRepositories: ["acme/miftah"] }
    );

    expect(input).toEqual({
      signals: [
        { provider: "github", kind: "repository", value: "acme/miftah", source: "argument" },
        { provider: "github", kind: "repository", value: "acme/miftah", source: "context" }
      ]
    });
    expect(JSON.stringify(input)).not.toContain("must-not-reach-a-matcher");
    expect(matchProviderBindings({ work: { routing: { match: { github: { repositories: ["acme/miftah"] } } } } }, input)).toEqual([
      {
        profile: "work",
        evidence: { provider: "github", kind: "repository", value: "acme/miftah" }
      }
    ]);
  });

  it("matches a GitHub organization only for a GitHub-namespaced tool", () => {
    const input = projectProviderMatcherInput("github__get_organization", { organization: "acme" });

    expect(matchProviderBindings({ work: { routing: { match: { github: { organizations: ["acme"] } } } } }, input)).toEqual([
      {
        profile: "work",
        evidence: { provider: "github", kind: "organization", value: "acme" }
      }
    ]);
    expect(
      matchProviderBindings(
        { work: { routing: { match: { github: { organizations: ["acme"] } } } } },
        projectProviderMatcherInput("search_organizations", { organization: "acme" })
      )
    ).toEqual([]);
  });

  it("uses a canonical GitHub issue URL as a stronger repository signal without a provider tool name", () => {
    const input = projectProviderMatcherInput("fetch_context", {
      url: "https://github.com/acme/miftah/issues/22"
    });

    expect(input).toEqual({
      signals: [{ provider: "github", kind: "repository", value: "acme/miftah", source: "url" }]
    });
    expect(matchProviderBindings({ work: { routing: { match: { github: { repositories: ["acme/miftah"] } } } } }, input)).toEqual([
      {
        profile: "work",
        evidence: { provider: "github", kind: "repository", value: "acme/miftah" }
      }
    ]);
  });

  it("matches Sentry organization, project, and environment declarations from allowlisted arguments", () => {
    const input = projectProviderMatcherInput("sentry__get_issue", {
      organization: "acme",
      project: "api",
      environment: "production"
    });

    expect(matchProviderBindings({ work: { routing: { match: { sentry: { organizations: ["acme"], projects: ["acme/api"], environments: ["production"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "sentry", kind: "environment", value: "production" } },
      { profile: "work", evidence: { provider: "sentry", kind: "organization", value: "acme" } },
      { profile: "work", evidence: { provider: "sentry", kind: "project", value: "acme/api" } }
    ]);
  });

  it("matches Jira site and project declarations from allowlisted arguments", () => {
    const input = projectProviderMatcherInput("jira__get_issue", {
      site: "https://acme.atlassian.net",
      project: "OPS"
    });

    expect(matchProviderBindings({ work: { routing: { match: { jira: { sites: ["https://acme.atlassian.net"], projects: ["OPS"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "jira", kind: "project", value: "OPS" } },
      { profile: "work", evidence: { provider: "jira", kind: "site", value: "https://acme.atlassian.net" } }
    ]);
  });

  it("matches Linear workspace and team declarations from allowlisted arguments", () => {
    const input = projectProviderMatcherInput("linear__get_issue", { workspace: "acme", team: "eng" });

    expect(matchProviderBindings({ work: { routing: { match: { linear: { workspaces: ["acme"], teams: ["eng"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "linear", kind: "team", value: "eng" } },
      { profile: "work", evidence: { provider: "linear", kind: "workspace", value: "acme" } }
    ]);
  });

  it("matches PostHog host and project declarations from allowlisted arguments", () => {
    const input = projectProviderMatcherInput("posthog__query", { host: "https://app.posthog.com", project: "123" });

    expect(matchProviderBindings({ work: { routing: { match: { posthog: { hosts: ["https://app.posthog.com"], projects: ["123"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "posthog", kind: "host", value: "https://app.posthog.com" } },
      { profile: "work", evidence: { provider: "posthog", kind: "project", value: "123" } }
    ]);
  });

  it("uses a canonical Sentry issue URL as a stronger organization signal without a provider tool name", () => {
    const input = projectProviderMatcherInput("fetch_context", { url: "https://acme.sentry.io/issues/12345/" });

    expect(input).toEqual({
      signals: [{ provider: "sentry", kind: "organization", value: "acme", source: "url" }]
    });
    expect(matchProviderBindings({ work: { routing: { match: { sentry: { organizations: ["acme"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "sentry", kind: "organization", value: "acme" } }
    ]);
  });

  it("uses a canonical Jira Cloud issue URL as stronger site and project signals", () => {
    const input = projectProviderMatcherInput("fetch_context", { url: "https://acme.atlassian.net/browse/OPS-22" });

    expect(input).toEqual({
      signals: [
        { provider: "jira", kind: "site", value: "https://acme.atlassian.net", source: "url" },
        { provider: "jira", kind: "project", value: "OPS", source: "url" }
      ]
    });
    expect(matchProviderBindings({ work: { routing: { match: { jira: { sites: ["https://acme.atlassian.net"], projects: ["OPS"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "jira", kind: "project", value: "OPS" } },
      { profile: "work", evidence: { provider: "jira", kind: "site", value: "https://acme.atlassian.net" } }
    ]);
  });

  it("uses a canonical Linear issue URL as a stronger workspace signal", () => {
    const input = projectProviderMatcherInput("fetch_context", { url: "https://linear.app/acme/issue/ENG-22" });

    expect(input).toEqual({
      signals: [{ provider: "linear", kind: "workspace", value: "acme", source: "url" }]
    });
    expect(matchProviderBindings({ work: { routing: { match: { linear: { workspaces: ["acme"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "linear", kind: "workspace", value: "acme" } }
    ]);
  });

  it("uses a canonical PostHog project URL as stronger host and project signals", () => {
    const input = projectProviderMatcherInput("fetch_context", { url: "https://app.posthog.com/project/123/insights" });

    expect(input).toEqual({
      signals: [
        { provider: "posthog", kind: "host", value: "https://app.posthog.com", source: "url" },
        { provider: "posthog", kind: "project", value: "123", source: "url" }
      ]
    });
    expect(matchProviderBindings({ work: { routing: { match: { posthog: { hosts: ["https://app.posthog.com"], projects: ["123"] } } } } }, input)).toEqual([
      { profile: "work", evidence: { provider: "posthog", kind: "host", value: "https://app.posthog.com" } },
      { profile: "work", evidence: { provider: "posthog", kind: "project", value: "123" } }
    ]);
  });

  it("omits generic, nested, oversized, and credential-bearing input before matcher evaluation", () => {
    const input = projectProviderMatcherInput(
      "search_context",
      {
        repo: "acme/miftah",
        url: "https://admin:secret@github.com/acme/miftah/issues/22?token=secret",
        nested: { repository: "acme/miftah" },
        accessToken: "must-not-reach-a-matcher"
      },
      {
        githubRepositories: [
          ...Array.from({ length: 32 }, () => "not-a-repository"),
          "acme/miftah"
        ]
      }
    );

    expect(input).toEqual({ signals: [] });
    expect(JSON.stringify(input)).not.toContain("secret");
    expect(JSON.stringify(input)).not.toContain("must-not-reach-a-matcher");
  });
});
