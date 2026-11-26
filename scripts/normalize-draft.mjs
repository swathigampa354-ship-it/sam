#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readMarkdown, writeMarkdown } from "../lib/analyzers/fs-io.mjs";
import { normalizeContent } from "../lib/analyzers/normalize.mjs";

export { normalizeContent };

if (isCli()) {
  main(process.argv.slice(2));
}

function main(args) {
  const filePath = args[0];

  if (!filePath) {
    console.error("Usage: node ./scripts/normalize-draft.mjs <file>");
    process.exit(1);
  }

  const content = readMarkdown(filePath);
  const normalized = normalizeContent(content);

  writeMarkdown(filePath, normalized.content);
  console.log(
    JSON.stringify({ file: filePath, changes: normalized.changes }, null, 2),
  );
}

function isCli() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
  );
}
