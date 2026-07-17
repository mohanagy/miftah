const unreleasedHeadingPattern = /^## \[Unreleased\]\s*$/mu;
const releaseHeadingPattern = /^## \[/mu;
const nonReleaseHeadingPattern = /\n## (?!\[)/u;

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
