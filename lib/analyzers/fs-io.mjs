import fs from "node:fs";

export function readMarkdown(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function writeMarkdown(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}
