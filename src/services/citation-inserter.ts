/**
 * Keyboard citation picker support (Task 27).
 *
 * Pure, Obsidian-free logic for the `paper-notes-insert-citation` command:
 *
 * - `searchCitationCandidates` searches title, authors, year, journal,
 *   identifiers (DOI/PMID/PMCID/arXiv), current citation key, aliases and
 *   abstract — the same default-search contract as the library index
 *   (design spec 17.3). The `paper_id` UUID is deliberately not searchable
 *   and is never part of any label or inserted prose.
 * - `citationLabelOf` renders result rows as `title — first author, year,
 *   journal` with graceful fallbacks.
 * - `toggleCitationSelection` keeps the user's click order, which is the
 *   order used for multi-citation insertion.
 * - `buildCitationText` produces Pandoc-style `[@key]` / `[@key1; @key2]`
 *   citations; `insertCitation` applies them through the editor port
 *   (`replaceSelection` inserts at the cursor or replaces the selection,
 *   per the Obsidian editor contract).
 */
import type { PaperRecord } from "../types/paper";
import { matchesAllTokens, tokenizeQuery } from "./search-tokens";

/** Minimal editor surface needed to insert citations. */
export interface CitationEditorPort {
  replaceSelection(text: string): void;
}

/**
 * Default search over picker candidates: title, authors, journal, year,
 * identifiers, citation key, aliases and abstract. An empty/whitespace query
 * returns every candidate. The `paper_id` UUID is never searched.
 */
export function searchCitationCandidates(
  records: PaperRecord[],
  query: string,
): PaperRecord[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return records;
  }
  return records.filter((record) =>
    matchesAllTokens(citationSearchText(record), tokens),
  );
}

function citationSearchText(record: PaperRecord): string {
  const parts = [
    record.title,
    record.journal ?? "",
    record.year !== undefined ? String(record.year) : "",
    record.key,
    record.abstract ?? "",
    ...record.authors.flatMap((author) => [
      author.family ?? "",
      author.given ?? "",
      author.literal ?? "",
    ]),
    ...record.citationKeyAliases,
    ...record.titleAliases,
    ...Object.values(record.identifiers),
  ];
  return parts.filter((part) => part.length > 0).join(" ").toLowerCase();
}

/** First author display name (family, or literal, or given). */
export function firstAuthorName(record: PaperRecord): string {
  const author = record.authors[0];
  if (author === undefined) {
    return "";
  }
  return author.family ?? author.literal ?? author.given ?? "";
}

/**
 * Result-row label: `title — first author, year, journal`. Missing detail
 * fields are simply omitted; the label never contains the `paper_id`.
 */
export function citationLabelOf(record: PaperRecord): string {
  const details = [
    firstAuthorName(record),
    record.year !== undefined ? String(record.year) : "",
    record.journal ?? "",
  ].filter((part) => part.length > 0);
  const meta = details.join(", ");
  return meta.length > 0 ? `${record.title} — ${meta}` : record.title;
}

/**
 * Toggle a record in/out of the selection. Selection order is the order in
 * which records were picked (the citation order for multi-insertion).
 */
export function toggleCitationSelection(
  selected: PaperRecord[],
  record: PaperRecord,
): PaperRecord[] {
  const index = selected.findIndex((item) => item.paperId === record.paperId);
  if (index >= 0) {
    return [...selected.slice(0, index), ...selected.slice(index + 1)];
  }
  return [...selected, record];
}

/**
 * Build the Pandoc citation text: `[@key]` for one record,
 * `[@key1; @key2]` for several, in the given (selection) order.
 * Returns an empty string for an empty selection.
 */
export function buildCitationText(records: PaperRecord[]): string {
  if (records.length === 0) {
    return "";
  }
  if (records.length === 1) {
    return `[@${records[0].key}]`;
  }
  return `[@${records.map((record) => record.key).join("; @")}]`;
}

/**
 * Insert the citation text through the editor port. `replaceSelection`
 * inserts at the cursor when there is no selection and replaces the
 * selection otherwise. No-op for an empty selection.
 */
export function insertCitation(
  editor: CitationEditorPort,
  records: PaperRecord[],
): string {
  const text = buildCitationText(records);
  if (text.length > 0) {
    editor.replaceSelection(text);
  }
  return text;
}
