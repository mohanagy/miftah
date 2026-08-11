import { error as logError } from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "tests", "fixtures", "fake-upstream-bundled.mjs");

function escapedWhitespace(value) {
  return [...value].map((character) => character === "\t" ? "\\t" : "\\x20").join("");
}

/** Preserves cooked template values while removing source lines that contain only whitespace. */
export function normalizeTemplateLiteralWhitespace(source) {
  const sourceFile = ts.createSourceFile("fake-upstream-bundled.mjs", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error("The bundled fake upstream fixture could not be parsed before normalization.");
  }
  const replacements = [];
  const visit = (node) => {
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const value = source.slice(node.getStart(sourceFile), node.getEnd());
      const whitespaceOnlyLines = [...value.matchAll(/^[\t ]+$/gmu)];
      if (whitespaceOnlyLines.length > 0) {
        const template = ts.isNoSubstitutionTemplateLiteral(node)
          ? node
          : ts.isTemplateExpression(node.parent)
            ? node.parent
            : node.parent.parent;
        if (ts.isTaggedTemplateExpression(template.parent)) {
          throw new Error("Cannot safely normalize whitespace inside a tagged template literal.");
        }
        for (const match of whitespaceOnlyLines) {
          if (match.index === undefined) continue;
          replacements.push({
            start: node.getStart(sourceFile) + match.index,
            end: node.getStart(sourceFile) + match.index + match[0].length,
            value: escapedWhitespace(match[0])
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((result, replacement) =>
      `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`, source);
}

/** Bundles the process fixture without leaving whitespace-only lines in template literals. */
export async function buildTestFixtureSource(entryPoint = "tests/fixtures/fake-upstream-runtime.mjs") {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    legalComments: "none",
    write: false
  });
  return normalizeTemplateLiteralWhitespace(result.outputFiles[0].text);
}

async function main() {
  const bundledSource = await buildTestFixtureSource();
  if (process.argv.includes("--check")) {
    let currentSource;
    try {
      currentSource = await readFile(outputPath, "utf8");
    } catch {
      currentSource = undefined;
    }

    if (currentSource !== bundledSource) {
      logError("The bundled fake upstream fixture is stale. Run `npm run build:test-fixture`.");
      process.exitCode = 1;
    }
  } else {
    await writeFile(outputPath, bundledSource);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
