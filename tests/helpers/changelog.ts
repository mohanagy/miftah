const unreleasedHeadingPattern = /^## \[Unreleased\]\s*$/mu;
const releaseHeadingPattern = /^## \[/mu;
const nonReleaseHeadingPattern = /\n## (?!\[)/u;

/** Returns the exact one-line changelog bullet for a tracked issue. */
export function changelogIssueEntry(changelog: string, issue: number): string {
  const entry = new RegExp(`^- \\[#${issue}\\]\\([^\\n]+\\).*$`, "mu").exec(changelog)?.[0];
  if (entry === undefined) throw new Error(`CHANGELOG.md must contain an entry for #${issue}.`);
  return entry;
}

/** Returns pending changes, or all released changes once a release empties Unreleased. */
export function documentedChangesSection(changelog: string): string {
  const afterHeading = changelog.split(unreleasedHeadingPattern)[1];
  if (afterHeading === undefined) throw new Error("CHANGELOG.md must contain an Unreleased section.");
  const nextRelease = afterHeading.search(releaseHeadingPattern);
  const unreleased = nextRelease === -1 ? afterHeading : afterHeading.slice(0, nextRelease);
  if (unreleased.trim() !== "" || nextRelease === -1) return unreleased;

  const releasedChanges = afterHeading.slice(nextRelease);
  const end = releasedChanges.search(nonReleaseHeadingPattern);
  return end === -1 ? releasedChanges : releasedChanges.slice(0, end);
}
