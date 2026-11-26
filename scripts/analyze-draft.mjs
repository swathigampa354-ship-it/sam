#!/usr/bin/env node

import path from "node:path";
import { readMarkdown } from "../lib/analyzers/fs-io.mjs";
import { analyzeDraftContent } from "../lib/analyzers/report.mjs";

const { filePath, keyword } = parseArgs(process.argv.slice(2));

if (!filePath) {
  console.error(
    'Usage: node ./scripts/analyze-draft.mjs <file> [--keyword "primary keyword"]',
  );
  process.exit(1);
}

const content = readMarkdown(filePath);
const report = analyzeDraftContent(content, keyword);

console.log(
  JSON.stringify(
    {
      file: path.resolve(filePath),
      ...report,
    },
    null,
    2,
  ),
);

function parseArgs(args) {
  const result = { filePath: "", keyword: "" };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (!value) continue;

    if (value === "--keyword") {
      result.keyword = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (!result.filePath) {
      result.filePath = value;
    }
  }

  return result;
}
