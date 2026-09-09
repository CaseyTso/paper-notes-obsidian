/**
 * Pure index and search of Topic MOC notes.
 *
 * From a list of `{ path, text }` notes under `MOCs/`, returns display
 * items sorted by title, or searches across topic titles and table content.
 * I/O stays out of this module — the Obsidian adapter feeds cached reads.
 */

import {
  extractCellVisibleText,
  parseMocNote,
  type MocEntry,
  type MocListItem,
  type ParsedMoc,
} from "./moc-parse";

export type { MocListItem, ParsedMoc };

export interface MocSearchExcerpt {
  column: "title" | "figure" | "summary" | "card";
  columnLabel: string;
  snippet: string;
  matchedTerms: string[];
}

export interface MocSearchResult {
  moc: ParsedMoc;
  titleMatched: boolean;
  matchingRowCount: number;
  excerpts: MocSearchExcerpt[];
}

/**
 * Pure parser & indexer of Topic MOC notes.
 * Parses all notes directly under `MOCs/`, discarding non-MOC notes,
 * and sorts them by title via localeCompare zh-CN.
 */
export function indexTopicMocs(
  notes: ReadonlyArray<{ path: string; text: string }>,
): ParsedMoc[] {
  const items: ParsedMoc[] = [];
  for (const note of notes) {
    // v1 is flat: only paths whose parent segment is "MOCs"
    const parts = note.path.split("/");
    const parentSegment = parts.length >= 2 ? parts[parts.length - 2] : "";
    if (parentSegment !== "MOCs") {
      continue;
    }
    const parsed = parseMocNote(note.path, note.text);
    if (!parsed) {
      continue;
    }
    items.push(parsed);
  }
  items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return items;
}

/**
 * Returns basic path & title list items sorted by zh-CN title.
 */
export function listTopicMocs(
  notes: ReadonlyArray<{ path: string; text: string }>,
): MocListItem[] {
  return indexTopicMocs(notes).map((item) => ({
    path: item.path,
    title: item.title,
  }));
}

const COLUMN_LABELS: Record<MocSearchExcerpt["column"], string> = {
  summary: "总结",
  title: "论文",
  card: "卡片",
  figure: "Figure",
};

/**
 * Extract a concise snippet centered around the first occurrence of any matched term.
 */
export function createSnippet(
  text: string,
  terms: string[],
  maxLen = 80,
): { snippet: string; matchedTerms: string[] } {
  if (!text) return { snippet: "", matchedTerms: [] };
  const lower = text.toLowerCase();
  const matchedTerms = terms.filter((t) => lower.includes(t));
  if (matchedTerms.length === 0) {
    return {
      snippet: text.length > maxLen ? text.slice(0, maxLen).trim() + "…" : text,
      matchedTerms: [],
    };
  }

  // Find the position of the earliest matched term
  let earliestIdx = text.length;
  let earliestTerm = matchedTerms[0];
  for (const term of matchedTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && idx < earliestIdx) {
      earliestIdx = idx;
      earliestTerm = term;
    }
  }

  // Ensure snippet budget accommodates the full matched term if it exceeds normal budget
  const budget = Math.max(maxLen, earliestTerm.length);
  if (text.length <= budget) {
    return { snippet: text, matchedTerms };
  }

  // Window centered on earliest term
  const beforeLen = Math.floor((budget - earliestTerm.length) / 2);
  const start = Math.max(0, earliestIdx - beforeLen);
  const end = Math.min(
    text.length,
    Math.max(start + budget, earliestIdx + earliestTerm.length),
  );
  const adjustedStart = Math.min(earliestIdx, Math.max(0, end - budget));

  const prefix = adjustedStart > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = prefix + text.slice(adjustedStart, end).trim() + suffix;

  return { snippet, matchedTerms };
}

interface ColumnCandidate {
  column: MocSearchExcerpt["column"];
  text: string;
}

function getEntryColumns(entry: MocEntry): ColumnCandidate[] {
  return [
    { column: "summary", text: extractCellVisibleText(entry.summaryText) },
    { column: "title", text: extractCellVisibleText(entry.titleText) },
    { column: "card", text: entry.cardText ?? "" },
    { column: "figure", text: entry.figureText ?? "" },
  ];
}

/**
 * Search across Topic MOC names and visible text of all four Topic Table columns.
 *
 * Rules:
 * - Terms are whitespace-separated, case-insensitive substrings.
 * - Terms must be ANDed within a single Topic Entry plus shared Topic MOC name.
 * - Words from different rows in the same MOC never combine to form a match.
 * - If the topic name alone satisfies all terms, the topic is included (even if empty).
 * - Results stay grouped one card per topic, retaining zh-CN title order.
 * - For matches with table content, at most TWO short excerpts highlighting terms are provided.
 * - For title-only matches, matchingRowCount is 0 and excerpts is empty (no fake 0-row excerpts).
 */
export function searchTopicMocs(
  mocs: ReadonlyArray<ParsedMoc>,
  query: string,
): MocSearchResult[] {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  if (terms.length === 0) {
    return mocs.map((moc) => ({
      moc,
      titleMatched: false,
      matchingRowCount: 0,
      excerpts: [],
    }));
  }

  const results: MocSearchResult[] = [];

  for (const moc of mocs) {
    const titleLower = moc.title.toLowerCase();
    const titleMatchesAll = terms.every((t) => titleLower.includes(t));

    // Inspect each table row
    const matchingEntries: Array<{
      entry: MocEntry;
      columns: ColumnCandidate[];
    }> = [];

    for (const entry of moc.entries) {
      const columns = getEntryColumns(entry);
      const rowCombined = columns.map((c) => c.text).join(" ").toLowerCase();

      // For this entry + topic title to match:
      // Every search term must appear in either the topic title or this row's content
      const entrySatisfiesAll = terms.every(
        (t) => titleLower.includes(t) || rowCombined.includes(t),
      );

      // And this row must contain at least one search term in its own text
      const entryHasContentMatch = terms.some((t) => rowCombined.includes(t));

      if (entrySatisfiesAll && entryHasContentMatch) {
        matchingEntries.push({ entry, columns });
      }
    }

    if (!titleMatchesAll && matchingEntries.length === 0) {
      continue;
    }

    // Build excerpts (up to 2)
    const excerpts: MocSearchExcerpt[] = [];
    if (matchingEntries.length > 0) {
      // Pick best matching columns from matching entries
      for (const { columns } of matchingEntries) {
        if (excerpts.length >= 2) break;

        // Find the column with the highest number of matched terms
        let bestCol: ColumnCandidate | undefined;
        let maxMatched = 0;
        for (const col of columns) {
          const colLower = col.text.toLowerCase();
          const matchCount = terms.filter((t) => colLower.includes(t)).length;
          if (matchCount > maxMatched) {
            maxMatched = matchCount;
            bestCol = col;
          }
        }

        if (bestCol && maxMatched > 0) {
          const { snippet, matchedTerms } = createSnippet(bestCol.text, terms);
          excerpts.push({
            column: bestCol.column,
            columnLabel: COLUMN_LABELS[bestCol.column],
            snippet,
            matchedTerms,
          });
        }
      }

      // If only 1 entry matched, but it had a second matching column, provide a second excerpt if available
      if (excerpts.length === 1 && matchingEntries.length === 1) {
        const { columns } = matchingEntries[0];
        const firstCol = excerpts[0].column;
        for (const col of columns) {
          if (col.column === firstCol) continue;
          const colLower = col.text.toLowerCase();
          const matchCount = terms.filter((t) => colLower.includes(t)).length;
          if (matchCount > 0) {
            const { snippet, matchedTerms } = createSnippet(col.text, terms);
            excerpts.push({
              column: col.column,
              columnLabel: COLUMN_LABELS[col.column],
              snippet,
              matchedTerms,
            });
            break;
          }
        }
      }
    }

    results.push({
      moc,
      titleMatched: titleMatchesAll,
      matchingRowCount: matchingEntries.length,
      excerpts,
    });
  }

  return results;
}
