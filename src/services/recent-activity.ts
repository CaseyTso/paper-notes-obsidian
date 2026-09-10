/**
 * Recent Activity data layer (Task: R2 Recent Literature Data Layer).
 *
 * Tracks:
 * 1. Recent Reads: Primary PDF or Figure notes opened in Obsidian.
 *    - Deduplicated per paper (latest read time wins).
 *    - Strict canonical path classification (no guessing/fuzzy matching).
 * 2. Recent Imports: Papers imported into the library with real `created_at` timestamp.
 *    - Prioritizes `created_at` from canonical frontmatter written by core CLI.
 *    - Never backfills or infers from file mtime/ctime for legacy papers.
 *
 * Storage & Concurrency:
 * - Persisted under dedicated `recentActivity` key in plugin data.json.
 * - Merge-save pattern preserves sibling settings and caches (metricsCache, columnWidths).
 * - Writes are serialized through an internal promise chain to prevent race conditions.
 */

import type { PaperRecord } from "../types/paper";

export const RECENT_ACTIVITY_STORAGE_KEY = "recentActivity";
export const RECENT_ACTIVITY_VERSION = 1;
export const DEFAULT_RECENT_LIMIT = 3;
export const MAX_RECENT_RECORDS = 50;

export interface RecentReadEntry {
  key: string;
  path: string;
  timestamp: number;
  kind?: "pdf" | "figure";
}

export interface RecentImportEntry {
  key: string;
  path: string;
  createdAt: string;
  timestamp: number;
}

export interface RecentActivityData {
  version: 1;
  reads: RecentReadEntry[];
  imports: RecentImportEntry[];
}

export interface ActivityStorageBridge {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface RecordReadOptions {
  key: string;
  path: string;
  timestamp?: number;
  kind?: "pdf" | "figure";
}

export interface RecordImportOptions {
  key: string;
  path: string;
  createdAt: string;
  timestamp?: number;
}

export interface RecentQueryOptions {
  limit?: number;
  records?: PaperRecord[];
}

export interface ClassifiedOpenFile {
  key: string;
  kind: "pdf" | "figure";
}

const FIGURE_PREFIX = "Figure解读_";

/**
 * Classify an opened file path.
 *
 * Strictly adheres to canonical paper directory structure:
 * - Primary PDF: `<root>/<key>/<key>.pdf` -> `{ key, kind: "pdf" }`
 * - Figure note: `<root>/<key>/Figure解读_<key>.md` -> `{ key, kind: "figure" }`
 * Any other path (or mismatch between key and filename) returns `null`.
 */
export function classifyOpenedFile(
  literatureRoot: string,
  path: string,
): ClassifiedOpenFile | null {
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  const cleanRoot = literatureRoot.replace(/^\/+|\/+$/g, "");
  const prefix = cleanRoot.length > 0 ? `${cleanRoot}/` : "";
  if (prefix.length > 0 && !path.startsWith(prefix)) {
    return null;
  }
  const rel = path.slice(prefix.length);
  const parts = rel.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [dir, file] = parts;
  if (!dir || !file) {
    return null;
  }

  // Primary PDF: <root>/<key>/<key>.pdf
  if (file.endsWith(".pdf")) {
    const stem = file.slice(0, -4);
    if (stem === dir && stem.length > 0) {
      return { key: dir, kind: "pdf" };
    }
    return null;
  }

  // Figure note: <root>/<key>/Figure解读_<key>.md
  if (file.startsWith(FIGURE_PREFIX) && file.endsWith(".md")) {
    const stem = file.slice(FIGURE_PREFIX.length, -3);
    if (stem === dir && stem.length > 0) {
      return { key: dir, kind: "figure" };
    }
    return null;
  }

  return null;
}

/**
 * Deserialize recent activity data with strict fault tolerance.
 * Handles corrupt payloads, missing fields, or legacy formats gracefully.
 */
export function deserializeRecentActivity(
  raw: unknown,
  maxCapacity = MAX_RECENT_RECORDS,
): RecentActivityData {
  const empty: RecentActivityData = {
    version: RECENT_ACTIVITY_VERSION,
    reads: [],
    imports: [],
  };

  if (raw === null || raw === undefined) {
    return empty;
  }

  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return empty;
    }
  }

  // Support legacy format where raw was just an array of reads
  if (Array.isArray(source)) {
    source = { reads: source, imports: [] };
  }

  if (typeof source !== "object" || source === null) {
    return empty;
  }

  const rawObj = source as Record<string, unknown>;

  // Parse reads
  const validReadsMap = new Map<string, RecentReadEntry>();
  if (Array.isArray(rawObj.reads)) {
    for (const item of rawObj.reads) {
      if (typeof item === "object" && item !== null) {
        const r = item as Record<string, unknown>;
        const key = typeof r.key === "string" ? r.key.trim() : "";
        const path = typeof r.path === "string" ? r.path.trim() : "";
        const timestamp =
          typeof r.timestamp === "number" && Number.isFinite(r.timestamp)
            ? r.timestamp
            : undefined;
        const kind =
          r.kind === "pdf" || r.kind === "figure" ? r.kind : undefined;

        if (key.length > 0 && path.length > 0 && timestamp !== undefined) {
          const existing = validReadsMap.get(key);
          if (!existing || existing.timestamp < timestamp) {
            validReadsMap.set(key, { key, path, timestamp, kind });
          }
        }
      }
    }
  }

  // Parse imports
  const validImportsMap = new Map<string, RecentImportEntry>();
  if (Array.isArray(rawObj.imports)) {
    for (const item of rawObj.imports) {
      if (typeof item === "object" && item !== null) {
        const imp = item as Record<string, unknown>;
        const key = typeof imp.key === "string" ? imp.key.trim() : "";
        const path = typeof imp.path === "string" ? imp.path.trim() : "";
        const createdAt =
          typeof imp.createdAt === "string" ? imp.createdAt.trim() : "";
        const parsedCreatedAt = Date.parse(createdAt);
        const timestamp =
          typeof imp.timestamp === "number" && Number.isFinite(imp.timestamp)
            ? imp.timestamp
            : !isNaN(parsedCreatedAt)
            ? parsedCreatedAt
            : undefined;

        if (
          key.length > 0 &&
          createdAt.length > 0 &&
          !isNaN(parsedCreatedAt) &&
          timestamp !== undefined
        ) {
          const existing = validImportsMap.get(key);
          if (!existing || existing.timestamp < timestamp) {
            validImportsMap.set(key, { key, path, createdAt, timestamp });
          }
        }
      }
    }
  }

  const reads = Array.from(validReadsMap.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxCapacity);

  const imports = Array.from(validImportsMap.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxCapacity);

  return {
    version: RECENT_ACTIVITY_VERSION,
    reads,
    imports,
  };
}

export class RecentActivityStore {
  private reads: RecentReadEntry[] = [];
  private imports: RecentImportEntry[] = [];
  private readonly bridge?: ActivityStorageBridge;
  private readonly maxCapacity: number;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options?: {
    bridge?: ActivityStorageBridge;
    maxCapacity?: number;
    initialData?: RecentActivityData;
  }) {
    this.bridge = options?.bridge;
    this.maxCapacity = options?.maxCapacity ?? MAX_RECENT_RECORDS;
    if (options?.initialData) {
      this.reads = options.initialData.reads.slice(0, this.maxCapacity);
      this.imports = options.initialData.imports.slice(0, this.maxCapacity);
    }
  }

  /** Current in-memory reads count (for diagnostics/tests). */
  get readCount(): number {
    return this.reads.length;
  }

  /** Current in-memory imports count (for diagnostics/tests). */
  get importCount(): number {
    return this.imports.length;
  }

  /** Load persisted recent activity from storage bridge. */
  async load(): Promise<void> {
    if (!this.bridge) {
      return;
    }
    try {
      const data = await this.bridge.loadData();
      if (typeof data === "object" && data !== null) {
        const raw = (data as Record<string, unknown>)[RECENT_ACTIVITY_STORAGE_KEY];
        const parsed = deserializeRecentActivity(raw, this.maxCapacity);
        this.reads = parsed.reads;
        this.imports = parsed.imports;
      }
    } catch {
      // Safe fallback: keep current in-memory state on read failure
    }
  }

  /**
   * Serialize recent activity payload to storage bridge.
   * All writes are serialized sequentially through `saveQueue` to prevent lost updates.
   */
  async save(): Promise<void> {
    if (!this.bridge) {
      return;
    }

    const saveTask = async () => {
      const current =
        ((await this.bridge!.loadData().catch(() => ({}))) as Record<string, unknown> | null) ?? {};
      const merged =
        typeof current === "object" && current !== null
          ? { ...current, [RECENT_ACTIVITY_STORAGE_KEY]: this.serialize() }
          : { [RECENT_ACTIVITY_STORAGE_KEY]: this.serialize() };
      await this.bridge!.saveData(merged);
    };

    const next = this.saveQueue.then(saveTask, saveTask);
    this.saveQueue = next.catch(() => {});
    return next;
  }

  /**
   * Record a reading event (Primary PDF or Figure note).
   * Deduplicates by paper citation key, updates timestamp, sorts descending,
   * enforces capacity limit, and persists asynchronously.
   */
  async recordRead(options: RecordReadOptions): Promise<RecentReadEntry | undefined> {
    const key = options.key?.trim();
    const path = options.path?.trim();
    if (!key || !path) {
      return undefined;
    }
    const timestamp =
      typeof options.timestamp === "number" && Number.isFinite(options.timestamp)
        ? options.timestamp
        : Date.now();

    const entry: RecentReadEntry = {
      key,
      path,
      timestamp,
      ...(options.kind ? { kind: options.kind } : {}),
    };

    this.reads = this.reads.filter((r) => r.key !== key);
    this.reads.unshift(entry);
    this.reads.sort((a, b) => b.timestamp - a.timestamp);
    if (this.reads.length > this.maxCapacity) {
      this.reads = this.reads.slice(0, this.maxCapacity);
    }

    await this.save();
    return entry;
  }

  /**
   * Record an import event.
   * Deduplicates by citation key, updates timestamp, sorts descending,
   * enforces capacity limit, and persists asynchronously.
   */
  async recordImport(options: RecordImportOptions): Promise<RecentImportEntry | undefined> {
    const key = options.key?.trim();
    const path = options.path?.trim();
    const createdAt = options.createdAt?.trim();
    if (!key || !path || !createdAt) {
      return undefined;
    }
    const parsedCreatedAt = Date.parse(createdAt);
    const timestamp =
      typeof options.timestamp === "number" && Number.isFinite(options.timestamp)
        ? options.timestamp
        : !isNaN(parsedCreatedAt)
        ? parsedCreatedAt
        : Date.now();

    const entry: RecentImportEntry = {
      key,
      path,
      createdAt,
      timestamp,
    };

    this.imports = this.imports.filter((i) => i.key !== key);
    this.imports.unshift(entry);
    this.imports.sort((a, b) => b.timestamp - a.timestamp);
    if (this.imports.length > this.maxCapacity) {
      this.imports = this.imports.slice(0, this.maxCapacity);
    }

    await this.save();
    return entry;
  }

  /**
   * Query recent reads.
   * If `records` are provided, only returns papers present in the active index
   * (filtering out deleted papers and keeping canonical paths up to date).
   */
  getRecentReads(
    limitOrOptions?: number | RecentQueryOptions,
    maybeRecords?: PaperRecord[],
  ): RecentReadEntry[] {
    let limit = DEFAULT_RECENT_LIMIT;
    let records: PaperRecord[] | undefined;

    if (typeof limitOrOptions === "number") {
      limit = limitOrOptions;
      records = maybeRecords;
    } else if (typeof limitOrOptions === "object" && limitOrOptions !== null) {
      if (typeof limitOrOptions.limit === "number") {
        limit = limitOrOptions.limit;
      }
      records = limitOrOptions.records ?? maybeRecords;
    }

    if (records !== undefined) {
      const recordMap = new Map<string, PaperRecord>();
      for (const record of records) {
        recordMap.set(record.key, record);
      }
      const matched: RecentReadEntry[] = [];
      for (const read of this.reads) {
        const record = recordMap.get(read.key);
        if (record) {
          matched.push({
            ...read,
            path: record.path,
          });
        }
      }
      return matched.slice(0, limit);
    }

    return this.reads.slice(0, limit).map((r) => ({ ...r }));
  }

  /**
   * Query recent imports.
   * If `records` are provided, dynamically sources papers with valid `createdAt`
   * timestamps from the active index plus any explicitly recorded imports.
   * Historical papers without `createdAt` are never returned.
   */
  getRecentImports(
    limitOrOptions?: number | RecentQueryOptions,
    maybeRecords?: PaperRecord[],
  ): RecentImportEntry[] {
    let limit = DEFAULT_RECENT_LIMIT;
    let records: PaperRecord[] | undefined;

    if (typeof limitOrOptions === "number") {
      limit = limitOrOptions;
      records = maybeRecords;
    } else if (typeof limitOrOptions === "object" && limitOrOptions !== null) {
      if (typeof limitOrOptions.limit === "number") {
        limit = limitOrOptions.limit;
      }
      records = limitOrOptions.records ?? maybeRecords;
    }

    if (records !== undefined) {
      const recordMap = new Map<string, PaperRecord>();
      for (const record of records) {
        recordMap.set(record.key, record);
      }

      const entriesMap = new Map<string, RecentImportEntry>();

      // 1. Papers in index that have real createdAt
      for (const record of records) {
        if (record.createdAt) {
          const ts = Date.parse(record.createdAt);
          if (!isNaN(ts)) {
            entriesMap.set(record.key, {
              key: record.key,
              path: record.path,
              createdAt: record.createdAt,
              timestamp: ts,
            });
          }
        }
      }

      // 2. Explicitly recorded imports, but only if they exist in active records
      for (const stored of this.imports) {
        const record = recordMap.get(stored.key);
        if (record && !entriesMap.has(stored.key)) {
          entriesMap.set(stored.key, {
            key: stored.key,
            path: record.path,
            createdAt: stored.createdAt,
            timestamp: stored.timestamp,
          });
        }
      }

      const results = Array.from(entriesMap.values());
      results.sort((a, b) => b.timestamp - a.timestamp);
      return results.slice(0, limit);
    }

    return this.imports.slice(0, limit).map((i) => ({ ...i }));
  }

  /** Return serializable snapshot of data. */
  serialize(): RecentActivityData {
    return {
      version: RECENT_ACTIVITY_VERSION,
      reads: this.reads.map((r) => ({ ...r })),
      imports: this.imports.map((i) => ({ ...i })),
    };
  }

  /** Deserialize and replace in-memory state. */
  deserialize(raw: unknown): void {
    const parsed = deserializeRecentActivity(raw, this.maxCapacity);
    this.reads = parsed.reads;
    this.imports = parsed.imports;
  }

  /** Reset all in-memory records and persist empty state. */
  async clear(): Promise<void> {
    this.reads = [];
    this.imports = [];
    await this.save();
  }
}
