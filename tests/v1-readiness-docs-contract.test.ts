import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const packageVersion = JSON.parse(read("package.json")).version as string;

describe("v1 readiness documentation contract", () => {
  it("links the evaluator and independent-review entry points from the README", () => {
    const readme = read("README.md");

    expect(readme).toContain(`@lubab/miftah@${packageVersion}`);
    expect(readme).toContain("[v1 external evaluation](docs/v1-evaluation.md)");
    expect(readme).toContain(
      "[independent security review brief](docs/independent-security-review.md)",
    );
  });

  it("defines version-pinned, privacy-safe external evaluation evidence", () => {
    const guide = read("docs/v1-evaluation.md");

    expect(guide).toContain(`@lubab/miftah@${packageVersion}`);
    expect(guide).toContain("Evaluator baseline: `@lubab/miftah@0.5.8`");
    expect(guide).toContain("maintainer attestation");
    expect(guide).toContain("not independently inspected");
    expect(guide).toMatch(/issues? #25, #88, #202, and #290/i);
    expect(guide).toMatch(/five completed multi-account workflows/i);
    expect(guide).toMatch(/three returning users/i);
    expect(guide).toMatch(/three unaided evaluators/i);
    expect(guide).toMatch(/two named profiles for the same provider/i);
    expect(guide).toMatch(/no tokens, OAuth codes, raw configuration/i);
    expect(guide).toMatch(/deidentified evidence template/i);
    expect(guide).toContain("--profile <profile-a>");
    expect(guide).toContain("--profile <profile-b>");
    expect(guide).toMatch(/issue #39:.*independent security review/i);

    for (const command of [
      "miftah version",
      "miftah validate",
      "miftah doctor",
      "miftah test-profile",
      "miftah_current_profile",
      "miftah_use_profile",
    ]) {
      expect(guide).toContain(command);
    }
  });

  it("defines an independent security review with actionable closure gates", () => {
    const brief = read("docs/independent-security-review.md");

    expect(brief).toContain(`@lubab/miftah@${packageVersion}`);
    expect(brief).toMatch(/issues? #37 and #39/i);
    expect(brief).toContain("SECURITY.md");
    expect(brief).toContain("threat-model.md");
    expect(brief).toMatch(/exact commit and package version/i);
    expect(brief).toMatch(/independence declaration/i);
    expect(brief).toMatch(/private report/i);
    expect(brief).toMatch(/public completion summary/i);
    expect(brief).toMatch(/no unresolved critical or high-severity finding/i);
    expect(brief).toContain("maintainer attestation");
    expect(brief).toContain("not independently inspected");
  });

  it("keeps status pages explicit about attested but uninspected external evidence", () => {
    const validation = read("docs/oauth-console-validation.md");
    const threatModel = read("docs/threat-model.md");

    expect(validation).toContain("[v1 external evaluation](v1-evaluation.md)");
    expect(validation).toContain(`@lubab/miftah@${packageVersion}`);
    expect(validation).toContain("Recorded completed external workflows: 5");
    expect(validation).toContain("Recorded returning external users: 3");
    expect(validation).toContain("Recorded unaided README evaluators: 3");
    expect(validation).toContain("not independently inspected");
    expect(threatModel).toContain(
      "[independent security review brief](independent-security-review.md)",
    );
    expect(threatModel).toMatch(/maintainer attestation/i);
    expect(threatModel).toMatch(/not independently inspected/i);
  });
});
