const REQUIRED_PATHS = [
  "LICENSE",
  "README.md",
  "dist/cli/main.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/plugin-api.d.ts",
  "dist/plugin-api.js",
  "dist/plugin-host.js",
  "docs/cli.md",
  "docs/library-api.md",
  "docs/plugins.md",
  "examples/generic.miftah.json",
  "examples/plugins.miftah.json",
  "examples/plugins/file-secret-provider.mjs",
  "examples/plugins/github-owner-routing-matcher.mjs",
  "package.json"
];

const ALLOWED_ROOT_PATHS = new Set(["LICENSE", "README.md", "package.json"]);
const ALLOWED_PATH_PATTERNS = [
  /^dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:d\.ts|d\.ts\.map|js|js\.map)$/u,
  /^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/u,
  /^examples\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:miftah\.json|mjs)$/u
];

/**
 * Formats package paths as an indented list for actionable verification errors.
 *
 * @param {readonly string[]} paths package-relative paths
 * @returns {string} newline-delimited diagnostic text
 */
function formatPaths(paths) {
  return paths.map((path) => `  - ${path}`).join("\n");
}

/**
 * Checks that a package-relative path is normalized and matches an intentional publish allowlist.
 *
 * @param {string} path package-relative path reported by npm
 * @returns {boolean} whether the path is safe and expected
 */
function isAllowedPath(path) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) {
    return false;
  }
  return ALLOWED_ROOT_PATHS.has(path) || ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Enforces the package path contract, including required entries, allowed patterns, and uniqueness.
 *
 * @param {readonly string[]} paths package-relative paths reported by npm
 * @returns {string[]} a copy of the verified paths
 * @throws {TypeError} when the input is not an array of strings
 * @throws {Error} when paths are missing, duplicated, unsafe, or unexpected
 */
export function verifyPackPaths(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("Package paths must be an array of strings.");
  }

  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))].sort();
  const unexpected = paths.filter((path) => !isAllowedPath(path)).sort();
  const missing = REQUIRED_PATHS.filter((path) => !paths.includes(path));
  const problems = [];

  if (duplicates.length > 0) {
    problems.push(`duplicate package paths:\n${formatPaths(duplicates)}`);
  }
  if (unexpected.length > 0) {
    problems.push(`unexpected package paths:\n${formatPaths(unexpected)}`);
  }
  if (missing.length > 0) {
    problems.push(`missing required package paths:\n${formatPaths(missing)}`);
  }

  if (problems.length > 0) {
    throw new Error(`Package contract verification failed:\n${problems.join("\n")}`);
  }

  return [...paths];
}

/**
 * Parses one `npm pack --json` result from either the list format used by npm 10/11 or npm 12's keyed-object format.
 *
 * @param {string} output JSON emitted by npm pack
 * @returns {{ files: unknown[] } & Record<string, unknown>} the single normalized packed-artifact result
 * @throws {Error} when npm emits invalid JSON or an unexpected result shape
 */
export function parsePackResult(output) {
  let results;
  try {
    const parsed = JSON.parse(output);
    results = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.values(parsed) : undefined;
  } catch (error) {
    throw new Error("npm pack returned invalid JSON.", { cause: error });
  }

  if (!Array.isArray(results) || results.length !== 1 || !isRecord(results[0]) || !Array.isArray(results[0].files)) {
    throw new Error("npm pack must return exactly one package with a files array.");
  }

  return results[0];
}

/**
 * Parses one normalized `npm pack --dry-run --json` result and extracts its package-relative paths.
 *
 * @param {string} output JSON emitted by npm pack
 * @returns {string[]} package-relative paths from the single packed artifact
 * @throws {Error} when npm emits invalid JSON or an unexpected result shape
 */
export function parsePackOutput(output) {
  const result = parsePackResult(output);

  return result.files.map((file) => {
    if (typeof file?.path !== "string") {
      throw new Error("npm pack returned a file entry without a string path.");
    }
    return file.path;
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
