import {
  countLinks,
  extractMetadata,
  getHeadings,
  getParagraphs,
  stripMetadata,
} from "./markdown.mjs";

export function analyzeStructure(content) {
  const body = stripMetadata(content);
  const headings = getHeadings(body);
  const metadata = extractMetadata(content);
  const links = countLinks(body);
  const paragraphs = getParagraphs(body);

  const h1Count = headings.filter((heading) => heading.level === 1).length;
  const headingIssues = [];

  let lastLevel = 0;
  for (const heading of headings) {
    if (lastLevel && heading.level > lastLevel + 1) {
      headingIssues.push(
        `Heading level jumps from H${lastLevel} to H${heading.level} at "${heading.text}".`,
      );
    }
    lastLevel = heading.level;
  }

  if (h1Count === 0) {
    headingIssues.push("Missing H1 heading.");
  }
  if (h1Count > 1) {
    headingIssues.push(`Found ${h1Count} H1 headings.`);
  }

  const longParagraphs = paragraphs.filter(
    (paragraph) => paragraph.split(/\s+/).length >= 120,
  ).length;

  return {
    h1Count,
    h2Count: headings.filter((heading) => heading.level === 2).length,
    h3Count: headings.filter((heading) => heading.level === 3).length,
    headingIssues,
    longParagraphs,
    internalLinks: links.internal,
    externalLinks: links.external,
    metadata,
  };
}
