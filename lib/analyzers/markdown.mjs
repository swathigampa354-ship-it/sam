export function getWordCount(content) {
  const words = content.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  return words.length;
}

export function getSentences(content) {
  return content
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getParagraphs(content) {
  return content
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getHeadings(content) {
  const headings = [];
  let inFence = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();

    if (isFenceDelimiter(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence || !/^#{1,6}\s+/.test(line)) {
      continue;
    }

    const hashes = line.match(/^#+/)?.[0] ?? "#";
    headings.push({
      level: hashes.length,
      text: line.replace(/^#{1,6}\s+/, "").trim(),
    });
  }

  return headings;
}

export function extractMetadata(content) {
  const fields = [
    "Meta Title",
    "Meta Description",
    "Primary Keyword",
    "Secondary Keywords",
    "URL Slug",
    "Category",
    "Tags",
  ];

  const yamlMap = parseYamlFrontmatter(content);
  const yamlAliases = {
    "Meta Title": ["meta_title", "metatitle", "title"],
    "Meta Description": ["meta_description", "metadescription", "description"],
    "Primary Keyword": ["primary_keyword", "keyword", "focus_keyword"],
    "Secondary Keywords": ["secondary_keywords", "keywords"],
    "URL Slug": ["url_slug", "slug"],
    Category: ["category"],
    Tags: ["tags"],
  };

  const result = {};

  for (const field of fields) {
    const pattern = new RegExp(
      `\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+)`,
      "i",
    );
    const match = content.match(pattern);
    let value = match?.[1]?.trim() ?? "";

    if (!value && yamlMap) {
      for (const alias of yamlAliases[field] ?? []) {
        if (yamlMap[alias]) {
          value = yamlMap[alias];
          break;
        }
      }
    }

    result[field] = value;
  }

  return result;
}

export function stripMetadata(content) {
  const withoutYaml = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return withoutYaml
    .split("\n")
    .filter(
      (line) =>
        !/^\*\*(Meta Title|Meta Description|Primary Keyword|Secondary Keywords|URL Slug|Category|Tags)\*\*:/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  const map = {};
  let currentKey = "";
  let listItems = [];

  const flushList = () => {
    if (currentKey && listItems.length > 0) {
      map[currentKey] = listItems.join(", ");
      listItems = [];
    }
  };

  for (const rawLine of match[1].split(/\r?\n/)) {
    const listMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      listItems.push(unquoteYaml(listMatch[1].trim()));
      continue;
    }

    const kvMatch = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      flushList();
      currentKey = kvMatch[1].trim().toLowerCase();
      const val = kvMatch[2].trim();
      if (val) {
        map[currentKey] = unquoteYaml(val);
        currentKey = "";
      }
    }
  }
  flushList();
  return map;
}

function unquoteYaml(val) {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1).trim();
  }
  if (val.startsWith("[") && val.endsWith("]")) {
    return val
      .slice(1, -1)
      .split(",")
      .map((s) => unquoteYaml(s.trim()))
      .filter(Boolean)
      .join(", ");
  }
  return val;
}

export function countLinks(content) {
  const links = [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(
    (match) => ({
      text: match[1],
      url: match[2],
    }),
  );

  const internal = links.filter(
    (link) => link.url.startsWith("/") || link.url.startsWith("#"),
  );
  const external = links.filter((link) => /^https?:\/\//i.test(link.url));

  return {
    total: links.length,
    internal: internal.length,
    external: external.length,
    links,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFenceDelimiter(line) {
  return /^(```|~~~)/.test(line);
}
