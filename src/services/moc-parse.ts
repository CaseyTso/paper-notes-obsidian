/**
 * Pure parser for Topic MOC notes.
 *
 * Turns markdown text + filename into a structured {@link ParsedMoc} (or
 * `undefined` when the note is not a Topic MOC). No Obsidian imports —
 * all functions are pure and unit-testable.
 */

export interface MocEntry {
  titleText: string;
  figureLink: string | undefined;
  figureKey: string | undefined;
  summaryText: string;
  cardLinks: string[];
}

export interface MocListItem {
  path: string;
  title: string;
}

export interface ParsedMoc {
  path: string;
  title: string;
  entries: MocEntry[];
}

const FIGURE_PREFIX = "Figure解读_";

/**
 * Parse a wikilink target into a citation key.
 *
 * `Figure解读_fooBar2024` → `fooBar2024`
 * `Figure解读_fooBar2024.md` → `fooBar2024`
 * Anything not starting with `Figure解读_` → `undefined`
 */
export function figureKeyOf(target: string): string | undefined {
  const stem = target.replace(/\.md$/u, "");
  if (!stem.startsWith(FIGURE_PREFIX)) {
    return undefined;
  }
  return stem.slice(FIGURE_PREFIX.length) || undefined;
}

/**
 * Extract all `[[target]]` or `[[target|label]]` wikilink targets from a cell.
 */
export function extractWikilinks(cell: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) {
    // Unescape escaped pipes (\| → |) before splitting on the alias separator
    const inner = m[1].replace(/\\\|/gu, "|");
    const target = inner.split("|")[0].trim();
    if (target) {
      links.push(target);
    }
  }
  return links;
}

function parseFrontmatter(text: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) {
    return fm;
  }
  const body = match[1];
  for (const line of body.split(/\r?\n/u)) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // strip surrounding quotes
    value = value.replace(/^["']|["']$/gu, "");
    fm[key] = value;
  }
  return fm;
}

function splitTableRow(row: string): string[] {
  // Remove leading/trailing pipes, split by unescaped pipes
  const trimmed = row.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
      // keep the backslash — we don't unescape, just skip the next char
      current += ch;
    } else if (ch === "|") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function isSeparatorRow(row: string): boolean {
  const trimmed = row.trim();
  if (!trimmed.startsWith("|")) {
    return false;
  }
  const inner = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").trim();
  return /^[\s\-|]+$/u.test(inner);
}

function normalizeHeader(cells: string[]): string[] {
  return cells.map((c) => c.replace(/\s+/gu, " ").trim());
}

const EXPECTED_HEADERS = ["Title", "Figure解读", "总结", "卡片"];

function isFourColumnHeader(cells: string[]): boolean {
  if (cells.length < 4) {
    return false;
  }
  const norm = normalizeHeader(cells);
  return (
    norm[0] === EXPECTED_HEADERS[0] &&
    norm[1] === EXPECTED_HEADERS[1] &&
    norm[2] === EXPECTED_HEADERS[2] &&
    norm[3] === EXPECTED_HEADERS[3]
  );
}

function cleanSummary(cell: string): string {
  // Convert <br> / <br/> / <br /> to newline
  let result = cell.replace(/<br\s*\/?>/giu, "\n");
  // Strip any other HTML tags (keep visible text)
  result = result.replace(/<[^>]+>/gu, "");
  return result;
}

function isCellEmpty(cell: string): boolean {
  return cell.replace(/<br\s*\/?>/giu, "").trim() === "";
}

/**
 * Parse a Topic MOC note from its full markdown text and vault path.
 *
 * Returns `undefined` when the note is not a Topic MOC (missing
 * `kind: topic-moc` frontmatter, or no valid four-column table).
 */
export function parseMocNote(path: string, text: string): ParsedMoc | undefined {
  const fm = parseFrontmatter(text);
  if ((fm["kind"] ?? "").trim() !== "topic-moc") {
    return undefined;
  }

  const title = fm["title"]?.trim() || path.replace(/\.md$/u, "").split("/").pop() || path;

  // Find the first four-column table
  const lines = text.split(/\r?\n/u);
  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    if (isFourColumnHeader(cells)) {
      tableStart = i + 1;
      break;
    }
  }
  if (tableStart < 0) {
    return { path, title, entries: [] };
  }

  // Skip separator row
  if (tableStart < lines.length && isSeparatorRow(lines[tableStart])) {
    tableStart++;
  }

  const entries: MocEntry[] = [];
  for (let i = tableStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      // End of table
      break;
    }
    const cells = splitTableRow(line);
    if (cells.length < 4) {
      break;
    }

    const titleCell = cells[0];
    const figureCell = cells[1];
    const summaryCell = cells[2];
    const cardCell = cells[3];

    // Drop fully empty rows (every cell empty/whitespace)
    if (
      isCellEmpty(titleCell) &&
      isCellEmpty(figureCell) &&
      isCellEmpty(summaryCell) &&
      isCellEmpty(cardCell)
    ) {
      continue;
    }

    // Figure cell: first wikilink
    const figureLinks = extractWikilinks(figureCell);
    const figureLink = figureLinks.length > 0 ? figureLinks[0] : undefined;
    const figureKey = figureLink ? figureKeyOf(figureLink) : undefined;

    // Card cell: all wikilinks
    const cardLinks = extractWikilinks(cardCell);

    entries.push({
      titleText: titleCell,
      figureLink,
      figureKey,
      summaryText: cleanSummary(summaryCell),
      cardLinks,
    });
  }

  return { path, title, entries };
}
