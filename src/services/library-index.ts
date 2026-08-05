/**
 * In-memory literature index (Task 23).
 *
 * Scans canonical main notes at `05 Literature/<key>/<key>.md` (the root is
 * configurable through settings) and updates incrementally on vault events.
 * All reads go through the `LiteratureVaultAdapter`; the index never writes
 * notes. Obsidian's metadata cache supplies already-parsed YAML frontmatter.
 *
 * Identity rules (design spec 17.3):
 * - Current keys are path-bound and unique.
 * - `citation_key_aliases` are reserved globally; an alias may not equal
 *   another note's current key or another alias.
 * - `paper_id` (UUID) is unique per paper.
 * - Any duplicate key/alias/UUID forces the whole index into a read-only
 *   error state until the ambiguity is resolved.
 *
 * Search:
 * - Default search covers title, authors, journal, year, identifiers,
 *   citation key, aliases and abstract — never MinerU full text.
 * - `searchFullText` reads `minerUmd_<key>.md` on demand, per record, and is
 *   cancellable via `AbortSignal`.
 */

import type {
  IndexInvalidReason,
  InvalidRecord,
  PaperAuthor,
  PaperIdentifiers,
  PaperRecord,
  ReadOnlyError,
} from "../types/paper";
import { PAPER_SCHEMA_VERSION } from "../types/paper";
import { matchesAllTokens, tokenizeQuery } from "./search-tokens";

/** Read-only contract over the Obsidian vault (implemented in main.ts). */
export interface LiteratureVaultAdapter {
  /** All markdown file paths in the vault. */
  listMarkdownFiles(): string[];
  /** Parsed frontmatter from the metadata cache, or undefined when absent. */
  getFrontmatter(path: string): Record<string, unknown> | undefined;
  /**
   * Raw note text for on-demand full-text reads. Rejects with
   * `VaultFileNotFoundError` when the file does not exist and observes the
   * optional `AbortSignal` (may reject with `SearchCancelledError`).
   */
  readText(path: string, signal?: AbortSignal): Promise<string>;
}

export class VaultFileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = "VaultFileNotFoundError";
  }
}

export class SearchCancelledError extends Error {
  constructor() {
    super("Full-text search cancelled");
    this.name = "SearchCancelledError";
  }
}

export type IndexVaultEvent = "create" | "modify" | "delete" | "rename";

export interface FullTextSearchOptions {
  signal?: AbortSignal;
}

/**
 * Extract the citation key from a canonical main note path, or null when the
 * path is not exactly `<root>/<key>/<key>.md`.
 */
export function canonicalKeyOf(root: string, path: string): string | null {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rel = path.slice(prefix.length);
  const parts = rel.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [dir, file] = parts;
  if (!file.endsWith(".md")) {
    return null;
  }
  const basename = file.slice(0, -3);
  return basename.length > 0 && dir === basename ? basename : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IdentityClaim {
  path: string;
  key: string;
  paperId?: string;
  aliases: string[];
}

interface ParsedNote {
  kind: "record" | "invalid";
  record?: PaperRecord;
  reasons: IndexInvalidReason[];
  declaredKey?: string;
  declaredPaperId?: string;
  declaredAliases: string[];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  ).map((item) => item.trim());
}

function normalizeYear(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1000 &&
    value <= 9999
  ) {
    return value;
  }
  if (typeof value === "string" && /^\d{4}$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function normalizeAuthors(value: unknown): PaperAuthor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const authors: PaperAuthor[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      authors.push({ literal: item.trim() });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const source = item as Record<string, unknown>;
      const family = stringValue(source.family);
      const given = stringValue(source.given);
      const literal = stringValue(source.literal);
      if (family !== undefined || given !== undefined || literal !== undefined) {
        authors.push({ family, given, literal });
      }
    }
  }
  return authors;
}

const IDENTIFIER_FIELDS = ["doi", "pmid", "pmcid", "arxiv"] as const;

function normalizeIdentifiers(fm: Record<string, unknown>): PaperIdentifiers {
  const identifiers: PaperIdentifiers = {};
  for (const field of IDENTIFIER_FIELDS) {
    const value = stringValue(fm[field]);
    if (value !== undefined) {
      identifiers[field] = value;
    }
  }
  return identifiers;
}

function parsePaper(
  path: string,
  key: string,
  fm: Record<string, unknown> | undefined,
): ParsedNote {
  const reasons: IndexInvalidReason[] = [];
  if (fm === undefined || typeof fm !== "object") {
    return { kind: "invalid", reasons: ["missing_frontmatter"], declaredAliases: [] };
  }

  const declaredKey = stringValue(fm.citation_key);
  const declaredPaperId = stringValue(fm.paper_id);
  const paperId =
    declaredPaperId !== undefined && UUID_RE.test(declaredPaperId)
      ? declaredPaperId
      : undefined;
  const declaredAliases =
    declaredKey !== undefined ? stringList(fm.citation_key_aliases) : [];
  const title = stringValue(fm.title);

  if (fm.schema_version !== PAPER_SCHEMA_VERSION) {
    reasons.push("unsupported_schema");
  }
  if (declaredKey === undefined) {
    reasons.push("missing_citation_key");
  } else if (declaredKey !== key) {
    reasons.push("key_path_mismatch");
  }
  if (declaredPaperId === undefined) {
    reasons.push("missing_paper_id");
  } else if (paperId === undefined) {
    reasons.push("invalid_paper_id");
  }
  if (title === undefined) {
    reasons.push("missing_title");
  }

  if (reasons.length > 0) {
    return {
      kind: "invalid",
      reasons,
      declaredKey,
      declaredPaperId: paperId,
      declaredAliases,
    };
  }

  return {
    kind: "record",
    reasons: [],
    declaredAliases,
    record: {
      path,
      key,
      paperId: paperId!,
      title: title!,
      authors: normalizeAuthors(fm.authors),
      journal: stringValue(fm.journal),
      year: normalizeYear(fm.year),
      identifiers: normalizeIdentifiers(fm),
      citationKeyAliases: declaredAliases,
      titleAliases: stringList(fm.aliases),
      abstract: stringValue(fm.abstract),
    },
  };
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

export class LibraryIndex {
  private records: PaperRecord[] = [];
  private invalidRecords: InvalidRecord[] = [];
  private invalidClaims = new Map<string, IdentityClaim>();
  private readOnlyError: ReadOnlyError | null = null;

  constructor(
    private readonly adapter: LiteratureVaultAdapter,
    private readonly root: string,
  ) {}

  /** Full scan at plugin load; replaces any previous state. */
  scanAll(): void {
    this.records = [];
    this.invalidRecords = [];
    this.invalidClaims.clear();
    for (const path of this.adapter.listMarkdownFiles()) {
      this.ingestPath(path);
    }
    this.recomputeErrorState();
  }

  /**
   * Incremental update for Obsidian vault events. `rename` receives the new
   * path plus the previous path (the index handles it as delete + create).
   */
  handleVaultEvent(event: IndexVaultEvent, path: string, oldPath?: string): void {
    switch (event) {
      case "create":
      case "modify":
        this.ingestPath(path);
        break;
      case "delete":
        this.removePath(path);
        break;
      case "rename":
        this.removePath(oldPath ?? path);
        this.ingestPath(path);
        break;
    }
    this.recomputeErrorState();
  }

  getRecords(): PaperRecord[] {
    return this.records.map(cloneRecord);
  }

  /** Resolve by current key or any identity alias. */
  getRecordByKey(key: string): PaperRecord | undefined {
    const record = this.records.find(
      (r) => r.key === key || r.citationKeyAliases.includes(key),
    );
    return record === undefined ? undefined : cloneRecord(record);
  }

  getInvalidRecords(): InvalidRecord[] {
    return this.invalidRecords.map((record) => ({
      path: record.path,
      reasons: [...record.reasons],
    }));
  }

  /** Identity conflict (duplicate key/alias/UUID), or null when healthy. */
  getReadOnlyError(): ReadOnlyError | null {
    if (this.readOnlyError === null) {
      return null;
    }
    const error = this.readOnlyError;
    return {
      ...error,
      paths: [error.paths[0], error.paths[1]] as [string, string],
    };
  }

  isReadOnly(): boolean {
    return this.readOnlyError !== null;
  }

  /**
   * Default search: title, authors, journal, year, identifiers, citation
   * key, aliases and abstract. MinerU full text is never read here.
   *
   * Multi-word queries match by token AND: every whitespace-separated
   * token must appear in the record's searchable text (tokens may be
   * scattered across fields). Empty tokens from consecutive whitespace are
   * ignored; a single-token query behaves exactly like the previous
   * whole-phrase substring match.
   */
  search(query: string): PaperRecord[] {
    const tokens = tokenizeQuery(query);
    const matched =
      tokens.length === 0
        ? this.records
        : this.records.filter((record) =>
            matchesAllTokens(searchText(record), tokens),
          );
    return matched.map(cloneRecord);
  }

  /**
   * Explicit full-text search: records already matching default fields are
   * returned without reads; the remaining records are checked against their
   * `minerUmd_<key>.md` note, read on demand. Missing or unreadable MinerU
   * notes are skipped. Cancellation (via `signal`) rejects with
   * `SearchCancelledError` and stops further reads.
   */
  async searchFullText(
    query: string,
    options: FullTextSearchOptions = {},
  ): Promise<PaperRecord[]> {
    const { signal } = options;
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) {
      return this.records.map(cloneRecord);
    }
    const matched: PaperRecord[] = [];
    for (const record of this.records) {
      if (signal?.aborted) {
        throw new SearchCancelledError();
      }
      if (matchesAllTokens(searchText(record), tokens)) {
        matched.push(record);
        continue;
      }
      let content: string;
      try {
        content = await this.adapter.readText(mineruPathFor(record), signal);
      } catch (error) {
        if (error instanceof SearchCancelledError || signal?.aborted) {
          throw new SearchCancelledError();
        }
        continue;
      }
      if (signal?.aborted) {
        throw new SearchCancelledError();
      }
      if (matchesAllTokens(content.toLowerCase(), tokens)) {
        matched.push(record);
      }
    }
    return matched.map(cloneRecord);
  }

  private ingestPath(path: string): void {
    this.removePath(path);
    const key = canonicalKeyOf(this.root, path);
    if (key === null) {
      return;
    }
    const parsed = parsePaper(path, key, this.adapter.getFrontmatter(path));
    if (parsed.kind === "record") {
      this.records.push(parsed.record!);
    } else {
      this.invalidRecords.push({ path, reasons: parsed.reasons });
      if (parsed.declaredKey !== undefined) {
        this.invalidClaims.set(path, {
          path,
          key: parsed.declaredKey,
          paperId: parsed.declaredPaperId,
          aliases: parsed.declaredAliases,
        });
      }
    }
  }

  private removePath(path: string): void {
    this.records = this.records.filter((record) => record.path !== path);
    this.invalidRecords = this.invalidRecords.filter(
      (record) => record.path !== path,
    );
    this.invalidClaims.delete(path);
  }

  private recomputeErrorState(): void {
    this.readOnlyError = null;
    // Every canonical note with a usable declared identity participates:
    // valid records plus invalid notes whose citation key is still declared
    // (e.g. a key_path_mismatch note claims an identity another note holds).
    const claimants: IdentityClaim[] = this.records.map((record) => ({
      path: record.path,
      key: record.key,
      paperId: record.paperId,
      aliases: record.citationKeyAliases,
    }));
    for (const claim of this.invalidClaims.values()) {
      claimants.push(claim);
    }

    // Phase 1: current keys and UUIDs (all claimants, order-independent).
    const keys = new Map<string, string>();
    const uuids = new Map<string, string>();
    for (const claim of claimants) {
      const keyOwner = keys.get(claim.key);
      if (keyOwner !== undefined) {
        this.readOnlyError = {
          kind: "duplicate_key",
          value: claim.key,
          paths: [keyOwner, claim.path],
        };
        return;
      }
      keys.set(claim.key, claim.path);
      if (claim.paperId !== undefined) {
        const uuidOwner = uuids.get(claim.paperId);
        if (uuidOwner !== undefined) {
          this.readOnlyError = {
            kind: "duplicate_uuid",
            value: claim.paperId,
            paths: [uuidOwner, claim.path],
          };
          return;
        }
        uuids.set(claim.paperId, claim.path);
      }
    }

    // Phase 2: aliases against every current key and every other alias.
    const aliases = new Map<string, string>();
    for (const claim of claimants) {
      for (const alias of claim.aliases) {
        const keyOwner = keys.get(alias);
        const aliasOwner = aliases.get(alias);
        if (keyOwner !== undefined && keyOwner !== claim.path) {
          this.readOnlyError = {
            kind: "duplicate_alias",
            value: alias,
            paths: [keyOwner, claim.path],
          };
          return;
        }
        if (aliasOwner !== undefined) {
          this.readOnlyError = {
            kind: "duplicate_alias",
            value: alias,
            paths: [aliasOwner, claim.path],
          };
          return;
        }
        aliases.set(alias, claim.path);
      }
    }
  }
}

function searchText(record: PaperRecord): string {
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

function mineruPathFor(record: PaperRecord): string {
  const dir = record.path.slice(0, record.path.lastIndexOf("/"));
  return `${dir}/minerUmd_${record.key}.md`;
}
