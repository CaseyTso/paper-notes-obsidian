/**
 * Literature Library table model (Task 24).
 *
 * Pure, vault-free query model behind the Literature Library view. Nothing
 * here touches Obsidian or the vault: records plus injected volatile data
 * (reading status from frontmatter, artifact availability from the paper
 * directory listing, EasyScholar metrics from a provider) are assembled into
 * display items, then searched, filtered and sorted deterministically.
 *
 * Metrics are UI-layer data only (design spec §10): they are injected per
 * paper id and must never be written back to paper YAML. The paper record
 * itself stays untouched.
 */

import type { PaperRecord } from "../types/paper";
import { matchesAllTokens, tokenizeQuery } from "../services/search-tokens";

/** Approved reading-status vocabulary (design spec §6.1). */
export type ReadingStatus = "unread" | "reading" | "read";

/** Actual file presence inside the paper directory (`<key>/`). */
export interface ArtifactAvailability {
  pdf: boolean;
  minerU: boolean;
  figure: boolean;
}

/**
 * Volatile EasyScholar metrics (UI only, never paper metadata).
 * Supplied by a metrics provider; absent until Task 26 wires the cache.
 */
export interface PaperMetrics {
  cas?: string;
  jcr?: string;
  if?: number;
  jci?: number;
}

export type LibraryColumnId =
  | "title"
  | "firstAuthor"
  | "year"
  | "journal"
  | "cas"
  | "jcr"
  | "if"
  | "jci"
  | "artifacts"
  | "readingStatus";

export interface LibraryColumn {
  id: LibraryColumnId;
  label: string;
  visible: boolean;
  width: number;
}

/**
 * Column-width drag rules (Batch 3): dragging or persisting a width has no
 * 720px ceiling any more — only a minimum floor and an absurd-value safety
 * valve so corrupt persisted data can never freeze the table. Normal
 * dragging never reaches the valve.
 */
export const COLUMN_WIDTH_MIN_PX = 48;
export const COLUMN_WIDTH_SAFETY_MAX_PX = 100000;

/**
 * Default column list (plan Task 24): the ten approved columns in order.
 * Batch 2 D raised the defaults so titles, journals, artifact chips and
 * reading-status chips read comfortably without hiding any column.
 */
export const DEFAULT_LIBRARY_COLUMNS: LibraryColumn[] = [
  { id: "title", label: "Title", visible: true, width: 340 },
  { id: "firstAuthor", label: "First author", visible: true, width: 150 },
  { id: "year", label: "Year", visible: true, width: 70 },
  { id: "journal", label: "Journal", visible: true, width: 200 },
  { id: "cas", label: "CAS", visible: true, width: 100 },
  { id: "jcr", label: "JCR", visible: true, width: 70 },
  { id: "if", label: "IF", visible: true, width: 70 },
  { id: "jci", label: "JCI", visible: true, width: 70 },
  { id: "artifacts", label: "PDF/MinerU/Figure", visible: true, width: 180 },
  { id: "readingStatus", label: "Reading status", visible: true, width: 130 },
];

/**
 * Clamp a column width (rounded to whole pixels): non-finite input
 * (corrupt persisted data) becomes the minimum; only absurd widths above
 * the safety valve are capped. In-range values, however wide, pass through.
 */
export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return COLUMN_WIDTH_MIN_PX;
  }
  return Math.min(
    COLUMN_WIDTH_SAFETY_MAX_PX,
    Math.max(COLUMN_WIDTH_MIN_PX, Math.round(width)),
  );
}

export interface ColumnCustomization {
  visible?: boolean;
  width?: number;
  /** Lower order = more left; customized columns precede uncustomized ones. */
  order?: number;
}

export type ColumnCustomizations = Partial<
  Record<LibraryColumnId, ColumnCustomization>
>;

/**
 * Resolve the effective column list: hide customized-off columns, apply
 * custom widths, and order columns by explicit `order` first (ties by
 * default order), with uncustomized columns keeping their default relative
 * order after them. Deterministic for any input.
 */
export function resolveColumns(
  customizations: ColumnCustomizations = {},
): LibraryColumn[] {
  const defaultIndex = new Map(
    DEFAULT_LIBRARY_COLUMNS.map((column, index) => [column.id, index]),
  );
  const columns = [...DEFAULT_LIBRARY_COLUMNS].sort((a, b) => {
    const orderA = customizations[a.id]?.order;
    const orderB = customizations[b.id]?.order;
    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }
    if (orderA !== undefined) {
      return -1;
    }
    if (orderB !== undefined) {
      return 1;
    }
    return (defaultIndex.get(a.id) ?? 0) - (defaultIndex.get(b.id) ?? 0);
  });
  return columns
    .filter((column) => customizations[column.id]?.visible ?? true)
    .map((column) => ({
      ...column,
      width: customizations[column.id]?.width ?? column.width,
    }));
}

/**
 * A display row: the paper record plus derived/volatile UI data.
 * `record` is absent for invalid-metadata rows (they keep only diagnostics).
 */
export interface LibraryItem {
  path: string;
  key: string;
  paperId: string;
  title: string;
  firstAuthor: string;
  year?: number;
  journal?: string;
  readingStatus?: ReadingStatus;
  artifacts: ArtifactAvailability;
  metrics?: PaperMetrics;
  /** Present only for invalid-metadata rows (design spec §17.1). */
  invalid?: { reasons: string[] };
  record?: PaperRecord;
}

export interface LibraryItemBuildOptions {
  /** Raw frontmatter per path (reading status comes from here). */
  frontmatter?: (path: string) => Record<string, unknown> | undefined;
  /** Basenames of the paper directory (`<root>/<key>/`). */
  listDirectory?: (dir: string) => string[];
  /** Volatile EasyScholar metrics per paper id (never written anywhere). */
  metrics?: (paperId: string) => PaperMetrics | undefined;
}

export const INVALID_METADATA_TITLE = "Invalid metadata";

const READING_STATUSES: readonly string[] = ["unread", "reading", "read"];

/** Normalize frontmatter `reading_status` to the approved vocabulary. */
export function readingStatusOf(
  frontmatter: Record<string, unknown> | undefined,
): ReadingStatus | undefined {
  const value = frontmatter?.reading_status;
  if (typeof value !== "string" || !READING_STATUSES.includes(value)) {
    return undefined;
  }
  return value as ReadingStatus;
}

/** Detect PDF/MinerU/Figure presence from the paper directory basenames. */
export function artifactStatusOf(
  key: string,
  names: string[],
): ArtifactAvailability {
  const present = new Set(names);
  return {
    pdf: present.has(`${key}.pdf`),
    minerU: present.has(`minerUmd_${key}.md`),
    figure: present.has(`Figure解读_${key}.md`),
  };
}

/** "Family Given" for structured authors, literal for group authors. */
export function formatAuthorName(
  author: PaperRecord["authors"][number],
): string {
  if (author.literal !== undefined && author.literal.length > 0) {
    return author.literal;
  }
  return [author.family, author.given].filter(Boolean).join(" ");
}

export function firstAuthorOf(record: PaperRecord): string {
  const first = record.authors[0];
  return first === undefined ? "" : formatAuthorName(first);
}

/** Fallback key for invalid rows: `<dir>/<dir>.md` → `<dir>`. */
function fallbackKeyOf(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  const file = parts[parts.length - 1] ?? "";
  const basename = file.endsWith(".md") ? file.slice(0, -3) : file;
  const dir = parts[parts.length - 2];
  return dir !== undefined && dir === basename ? dir : basename;
}

function cloneRecord(record: PaperRecord): PaperRecord {
  return {
    ...record,
    authors: record.authors.map((author) => ({ ...author })),
    identifiers: { ...record.identifiers },
    citationKeyAliases: [...record.citationKeyAliases],
    titleAliases: [...record.titleAliases],
  };
}

/**
 * Assemble display items from index records plus injected volatile data.
 * Records are cloned so view-layer mutations can never leak into the index.
 * Invalid records stay visible as `Invalid metadata` rows (never dropped).
 */
export function buildLibraryItems(
  records: PaperRecord[],
  invalidRecords: Array<{ path: string; reasons: string[] }>,
  options: LibraryItemBuildOptions = {},
): LibraryItem[] {
  const { frontmatter, listDirectory, metrics } = options;
  const items: LibraryItem[] = records.map((record) => {
    const clone = cloneRecord(record);
    const dir = clone.path.slice(0, clone.path.lastIndexOf("/"));
    const injected = metrics?.(clone.paperId);
    return {
      path: clone.path,
      key: clone.key,
      paperId: clone.paperId,
      title: clone.title,
      firstAuthor: firstAuthorOf(clone),
      year: clone.year,
      journal: clone.journal,
      readingStatus: readingStatusOf(frontmatter?.(clone.path)),
      artifacts: artifactStatusOf(
        clone.key,
        listDirectory?.(dir) ?? [],
      ),
      metrics:
        injected === undefined
          ? undefined
          : {
              ...(injected.cas !== undefined ? { cas: injected.cas } : {}),
              ...(injected.jcr !== undefined ? { jcr: injected.jcr } : {}),
              ...(injected.if !== undefined ? { if: injected.if } : {}),
              ...(injected.jci !== undefined ? { jci: injected.jci } : {}),
            },
      record: clone,
    };
  });
  const invalidItems: LibraryItem[] = [...invalidRecords]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((invalid) => ({
      path: invalid.path,
      key: fallbackKeyOf(invalid.path),
      paperId: "",
      title: INVALID_METADATA_TITLE,
      firstAuthor: "",
      artifacts: { pdf: false, minerU: false, figure: false },
      invalid: { reasons: [...invalid.reasons] },
    }));
  return [...items, ...invalidItems];
}

/** Searchable text mirroring the default search fields (design §9.4). */
function searchTextOf(item: LibraryItem): string {
  if (item.invalid !== undefined) {
    return `${item.path} ${item.invalid.reasons.join(" ")}`.toLowerCase();
  }
  const record = item.record!;
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

/** Default text search over title/authors/journal/year/IDs/key/aliases/abstract. */
export function searchLibraryItems(
  items: LibraryItem[],
  query: string,
): LibraryItem[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return items;
  }
  return items.filter((item) =>
    matchesAllTokens(searchTextOf(item), tokens),
  );
}

export interface LibrarySort {
  columnId: LibraryColumnId;
  direction: "asc" | "desc";
}

function isMissing(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    (typeof value === "string" && value.length === 0)
  );
}

function compareCell(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Cell value used for sorting; missing values always sort last. */
function sortValueOf(item: LibraryItem, columnId: LibraryColumnId): unknown {
  switch (columnId) {
    case "year":
      return item.year;
    case "if":
      return item.metrics?.if;
    case "jci":
      return item.metrics?.jci;
    default:
      return formatColumnValue(item, columnId);
  }
}

/**
 * Stable sort: equal cells keep input order in both directions, missing
 * values stay last regardless of direction. Returns a new array; the input
 * is never mutated.
 */
export function sortLibraryItems(
  items: LibraryItem[],
  sort: LibrarySort,
): LibraryItem[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const direction = sort.direction === "asc" ? 1 : -1;
  indexed.sort((a, b) => {
    const valueA = sortValueOf(a.item, sort.columnId);
    const valueB = sortValueOf(b.item, sort.columnId);
    const missingA = isMissing(valueA);
    const missingB = isMissing(valueB);
    if (missingA && missingB) {
      return a.index - b.index;
    }
    if (missingA) {
      return 1;
    }
    if (missingB) {
      return -1;
    }
    const compared = compareCell(valueA, valueB);
    return compared !== 0 ? compared * direction : a.index - b.index;
  });
  return indexed.map((entry) => entry.item);
}

const ARTIFACT_LABELS: Array<[keyof ArtifactAvailability, string]> = [
  ["pdf", "PDF"],
  ["minerU", "MinerU"],
  ["figure", "Figure"],
];

/** Deterministic cell text for every column. */
export function formatColumnValue(
  item: LibraryItem,
  columnId: LibraryColumnId,
): string {
  switch (columnId) {
    case "title":
      return item.title;
    case "firstAuthor":
      return item.firstAuthor;
    case "year":
      return item.year !== undefined ? String(item.year) : "";
    case "journal":
      return item.journal ?? "";
    case "cas":
      return item.metrics?.cas ?? "";
    case "jcr":
      return item.metrics?.jcr ?? "";
    case "if":
      return item.metrics?.if !== undefined ? String(item.metrics.if) : "";
    case "jci":
      return item.metrics?.jci !== undefined ? String(item.metrics.jci) : "";
    case "artifacts":
      return ARTIFACT_LABELS.filter(([key]) => item.artifacts[key])
        .map(([, label]) => label)
        .join(" · ");
    case "readingStatus":
      return item.readingStatus ?? "";
  }
}
