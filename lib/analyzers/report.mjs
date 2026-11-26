import { analyzeKeyword } from "./keyword.mjs";
import { analyzePublishReadiness } from "./publish-readiness.mjs";
import { analyzeReadability } from "./readability.mjs";
import { analyzeStructure } from "./structure.mjs";

export function analyzeDraftContent(content, explicitKeyword = "") {
  const readability = analyzeReadability(content);
  const structure = analyzeStructure(content);
  const publishReadiness = analyzePublishReadiness(content);
  const keywordReport = analyzeKeyword(
    content,
    explicitKeyword || structure.metadata["Primary Keyword"],
  );
  const summary = buildSummary({
    readability,
    structure,
    keywordReport,
    publishReadiness,
  });

  return {
    readability,
    structure,
    publishReadiness,
    keyword: keywordReport,
    summary,
  };
}

export function buildSummary({
  readability,
  structure,
  keywordReport,
  publishReadiness,
}) {
  const issues = [];
  const wins = [];

  if (structure.h1Count === 1) wins.push("Single H1 present.");
  if (structure.headingIssues.length > 0)
    issues.push(...structure.headingIssues);
  if (structure.internalLinks === 0) issues.push("No internal links found.");
  if (structure.externalLinks === 0) issues.push("No external links found.");
  if (!structure.metadata["Meta Title"]) issues.push("Missing meta title.");
  if (!structure.metadata["Meta Description"])
    issues.push("Missing meta description.");
  if (!structure.metadata["URL Slug"]) issues.push("Missing URL slug.");
  if (readability.averageSentenceLength > 24)
    issues.push(
      `Average sentence length is ${readability.averageSentenceLength} words.`,
    );
  if (readability.longSentences > 0)
    issues.push(`${readability.longSentences} long sentences detected.`);
  if (structure.longParagraphs > 0)
    issues.push(`${structure.longParagraphs} very long paragraphs detected.`);

  if (publishReadiness) {
    issues.push(...publishReadiness.issues);
    wins.push(...publishReadiness.wins);
  }

  if (keywordReport) {
    if (keywordReport.occurrences === 0)
      issues.push("Primary keyword does not appear in the body.");
    if (!keywordReport.inTitle) issues.push("Primary keyword missing from H1.");
    if (!keywordReport.inFirst100Words)
      issues.push("Primary keyword missing from first 100 words.");
    if (!keywordReport.inMetaTitle)
      issues.push("Primary keyword missing from meta title.");
    if (!keywordReport.inMetaDescription)
      issues.push("Primary keyword missing from meta description.");
    if (keywordReport.density > 2.5)
      issues.push(
        `Keyword density may be too high at ${keywordReport.density}%.`,
      );
  }

  return { wins: [...new Set(wins)], issues: [...new Set(issues)] };
}
