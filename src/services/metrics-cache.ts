/**
 * EasyScholar metric cache (Task 26).
 *
 * Volatile, UI-only journal metrics (design spec §10): the cache holds
 * EasyScholar results keyed by normalized journal identity/ISSN, renders
 * cached values immediately, refreshes missing/expired journals in the
 * background with deduplication and backoff, and retains stale values on
 * failure.
 *
 * Hard boundaries (mirrored by tests):
 * - The only CLI operation ever issued is `metrics query` — never a paper
 *   write command.
 * - Only non-sensitive fields are persisted through the injected `save`
 *   callback (the plugin's `data.json`); secrets never enter this module
 *   (the EasyScholar SecretKey lives in the core CLI's private config).
 * - Nothing here touches the filesystem or Markdown directly.
 */

import type { PaperMetrics } from "../components/library-table";
import type { CliClient } from "./cli-client";
import type { ProtocolEnvelope } from "../types/protocol";

/** One of the four volatile metric columns displayed as a badge. */
export type MetricErrorCode = "rate_limited" | "cli_error" | "empty";

/** Non-sensitive cached journal metrics (persisted to `data.json`). */
export interface CachedMetricsEntry {
  /** Normalized cache key: `issn:<compact>` or `journal:<normalized>`. */
  key: string;
  /** Normalized journal name used to query (when queried by name). */
  journal?: string;
  /** Normalized ISSN used to query (when queried by ISSN). */
  issn?: string;
  /** Volatile EasyScholar results; UI data only, never paper metadata. */
  metrics: PaperMetrics;
  /** Epoch-ms time of the last successful refresh. */
  fetchedAtMs: number;
  /** True when the last refresh failed and this value is being retained. */
  stale: boolean;
  /** Rate-limit/backoff deadline: no refresh attempts before this time. */
  retryAfterMs?: number;
  /** Last failure code (never a raw CLI message). */
  lastErrorCode?: MetricErrorCode;
}

/** A journal identity to look up: either/both of journal name and ISSN. */
export interface MetricQueryTarget {
  journal?: string;
  issn?: string;
}

export type RefreshStatus =
  | "refreshed"
  | "failed"
  | "backoff"
  | "no_key"
  | "disabled";

export interface RefreshResult {
  key: string;
  status: RefreshStatus;
  entry?: CachedMetricsEntry;
}

export interface MetricsCacheOptions {
  /** CLI bridge; only the read-only `metrics query` subcommand is used. */
  client: Pick<CliClient, "run">;
  /** Cache lifetime in days (settings `metricTtlDays`, design: 30). */
  ttlDays: () => number;
  /** Whether metric badges are enabled (settings `metricsEnabled`). */
  enabled: () => boolean;
  /** Load the persisted cache namespace from plugin `data.json`. */
  load: () => Promise<unknown>;
  /** Persist the cache namespace back into plugin `data.json`. */
  save: (payload: unknown) => Promise<void>;
  /** Injectable clock (epoch ms) for deterministic stale/backoff tests. */
  now?: () => number;
  /** Backoff window after a failed refresh (defaults to 60 seconds). */
  backoffMs?: number;
}

const DEFAULT_BACKOFF_MS = 60_000;
const MS_PER_DAY = 86_400_000;
const METRICS_CACHE_VERSION = 1;

/**
 * Normalize a journal name for cache-key identity: trim, collapse
 * internal whitespace, lowercase.
 */
export function normalizeJournalName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalize an ISSN for cache-key identity: strip separators, uppercase
 * the check digit. Returns undefined for anything that is not a valid
 * 8-character ISSN (7 digits plus digit or X).
 */
export function normalizeIssn(issn: string): string | undefined {
  const compact = issn.replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^\d{7}[\dX]$/.test(compact) ? compact : undefined;
}

/**
 * Deterministic cache key for a journal identity. ISSN wins when valid
 * (more precise identity); the two key spaces never collide thanks to
 * their prefixes. Returns undefined when there is no usable identity.
 */
export function metricKeyOf(target: MetricQueryTarget): string | undefined {
  const normalizedIssn = target.issn !== undefined ? normalizeIssn(target.issn) : undefined;
  if (normalizedIssn !== undefined) {
    return `issn:${normalizedIssn}`;
  }
  if (target.journal !== undefined) {
    const journal = normalizeJournalName(target.journal);
    if (journal.length > 0) {
      return `journal:${journal}`;
    }
  }
  return undefined;
}

/** True when the entry is older than the configured TTL. */
export function isExpired(
  entry: CachedMetricsEntry,
  now: number,
  ttlDays: number,
): boolean {
  const ttlMs = Math.max(0, ttlDays) * MS_PER_DAY;
  return now - entry.fetchedAtMs >= ttlMs;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Pull CAS/JCR/IF/JCI from one record-like object. Accepts both the CLI
 * field names (`cas_partition` / `jcr_partition`) and the UI cache names
 * (`cas` / `jcr`) so envelope parsing and cache reloads share one path.
 */
function paperMetricsFromRecord(
  record: Record<string, unknown>,
): PaperMetrics | undefined {
  const metrics: PaperMetrics = {};
  const cas =
    nonEmptyString(record.cas_partition) ?? nonEmptyString(record.cas);
  if (cas !== undefined) {
    metrics.cas = cas;
  }
  const jcr =
    nonEmptyString(record.jcr_partition) ?? nonEmptyString(record.jcr);
  if (jcr !== undefined) {
    metrics.jcr = jcr;
  }
  const ifValue = toFiniteNumber(record.if);
  if (ifValue !== undefined) {
    metrics.if = ifValue;
  }
  const jciValue = toFiniteNumber(record.jci);
  if (jciValue !== undefined) {
    metrics.jci = jciValue;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/**
 * Map a CLI `metrics query` success payload onto the volatile
 * `PaperMetrics` UI shape.
 *
 * Live CLI success shape (protocol v1):
 *   envelope.data.metrics = {
 *     source, journal, issn, level,
 *     metrics: { if, if5, jci, jcr_partition, cas_partition },
 *     queried_at,
 *   }
 *
 * Callers pass `envelope.data.metrics` (the adapter wrapper). This helper
 * also tolerates a flat partition object, a double-wrapped `data` object,
 * and the already-normalized UI field names. Unknown fields are dropped;
 * undefined is returned when nothing usable remains.
 */
export function metricsFromEnvelope(payload: unknown): PaperMetrics | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const root = payload as Record<string, unknown>;
  // Deepest-first: official metrics block → adapter wrapper → root.
  const candidates: Record<string, unknown>[] = [root];
  const nested = root.metrics;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>;
    candidates.unshift(nestedRecord);
    const deeper = nestedRecord.metrics;
    if (typeof deeper === "object" && deeper !== null && !Array.isArray(deeper)) {
      candidates.unshift(deeper as Record<string, unknown>);
    }
  }
  for (const record of candidates) {
    const metrics = paperMetricsFromRecord(record);
    if (metrics !== undefined) {
      return metrics;
    }
  }
  return undefined;
}

function errorCodeOf(envelope: ProtocolEnvelope): MetricErrorCode {
  const code = envelope.errors[0]?.code ?? envelope.status;
  return /rate/i.test(code) ? "rate_limited" : "cli_error";
}

const METRIC_ERROR_CODES: readonly MetricErrorCode[] = [
  "rate_limited",
  "cli_error",
  "empty",
];

function parseMetrics(value: unknown): PaperMetrics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const metrics: PaperMetrics = {};
  const cas = nonEmptyString(record.cas);
  if (cas !== undefined) {
    metrics.cas = cas;
  }
  const jcr = nonEmptyString(record.jcr);
  if (jcr !== undefined) {
    metrics.jcr = jcr;
  }
  const ifValue = toFiniteNumber(record.if);
  if (ifValue !== undefined) {
    metrics.if = ifValue;
  }
  const jciValue = toFiniteNumber(record.jci);
  if (jciValue !== undefined) {
    metrics.jci = jciValue;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function parsePersistedEntry(raw: unknown): CachedMetricsEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const key = nonEmptyString(record.key);
  const fetchedAtMs = toFiniteNumber(record.fetchedAtMs);
  const stale = typeof record.stale === "boolean" ? record.stale : undefined;
  const metrics = parseMetrics(record.metrics);
  if (key === undefined || fetchedAtMs === undefined || stale === undefined || metrics === undefined) {
    return undefined;
  }
  const entry: CachedMetricsEntry = {
    key,
    metrics,
    fetchedAtMs,
    stale,
  };
  const journal = nonEmptyString(record.journal);
  if (journal !== undefined) {
    entry.journal = journal;
  }
  const issn = nonEmptyString(record.issn);
  if (issn !== undefined) {
    entry.issn = issn;
  }
  const retryAfterMs = toFiniteNumber(record.retryAfterMs);
  if (retryAfterMs !== undefined) {
    entry.retryAfterMs = retryAfterMs;
  }
  const lastErrorCode = nonEmptyString(record.lastErrorCode);
  if (
    lastErrorCode !== undefined &&
    (METRIC_ERROR_CODES as readonly string[]).includes(lastErrorCode)
  ) {
    entry.lastErrorCode = lastErrorCode as MetricErrorCode;
  }
  return entry;
}

/**
 * Parse the persisted cache namespace from plugin `data.json`.
 * Strictly whitelisted: unknown or secret-like fields are dropped and
 * malformed entries are rejected. Never throws — bad payloads yield [].
 */
export function parsePersistedCache(loaded: unknown): CachedMetricsEntry[] {
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    return [];
  }
  const root = loaded as Record<string, unknown>;
  if (!Array.isArray(root.entries)) {
    return [];
  }
  const entries: CachedMetricsEntry[] = [];
  for (const raw of root.entries) {
    const entry = parsePersistedEntry(raw);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Serialize the cache for `data.json`: versioned, key-sorted, and
 * containing only the non-sensitive whitelisted fields.
 */
export function serializeCache(
  entries: readonly CachedMetricsEntry[],
): unknown {
  return {
    version: METRICS_CACHE_VERSION,
    entries: [...entries]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((entry) => ({
        key: entry.key,
        ...(entry.journal !== undefined ? { journal: entry.journal } : {}),
        ...(entry.issn !== undefined ? { issn: entry.issn } : {}),
        metrics: {
          ...(entry.metrics.cas !== undefined ? { cas: entry.metrics.cas } : {}),
          ...(entry.metrics.jcr !== undefined ? { jcr: entry.metrics.jcr } : {}),
          ...(entry.metrics.if !== undefined ? { if: entry.metrics.if } : {}),
          ...(entry.metrics.jci !== undefined ? { jci: entry.metrics.jci } : {}),
        },
        fetchedAtMs: entry.fetchedAtMs,
        stale: entry.stale,
        ...(entry.retryAfterMs !== undefined
          ? { retryAfterMs: entry.retryAfterMs }
          : {}),
        ...(entry.lastErrorCode !== undefined
          ? { lastErrorCode: entry.lastErrorCode }
          : {}),
      })),
  };
}

/**
 * In-memory EasyScholar metric cache. UI-only volatile data: cached
 * values render immediately, refreshes are deduplicated and back off
 * after failures, and persistence flows exclusively through the injected
 * `load`/`save` callbacks (plugin `data.json`).
 */
export class MetricsCache {
  private readonly entries = new Map<string, CachedMetricsEntry>();
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();
  private initialized = false;

  constructor(private readonly options: MetricsCacheOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private backoffMs(): number {
    return this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /**
   * Load and validate the persisted cache namespace once. A missing or
   * malformed payload leaves the cache empty (volatile data).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const loaded = await this.options.load();
      for (const entry of parsePersistedCache(loaded)) {
        this.entries.set(entry.key, entry);
      }
    } catch {
      // Volatile UI data: never let a read failure break the library.
    }
  }

  /**
   * Synchronous lookup for immediate cached display. Returns the entry
   * even when it is expired or marked stale (the UI renders a stale
   * badge while a background refresh runs). Respects the enabled toggle.
   */
  getEntryFor(target: MetricQueryTarget): CachedMetricsEntry | undefined {
    if (!this.options.enabled()) {
      return undefined;
    }
    const key = metricKeyOf(target);
    return key === undefined ? undefined : this.entries.get(key);
  }

  /** True while the entry is parked by the rate-limit backoff window. */
  isBackedOff(entry: CachedMetricsEntry, now: number): boolean {
    return entry.retryAfterMs !== undefined && entry.retryAfterMs > now;
  }

  private async persist(): Promise<void> {
    try {
      await this.options.save(
        serializeCache([...this.entries.values()]),
      );
    } catch {
      // A failed data.json write never breaks a refresh (volatile data).
    }
  }

  /**
   * Refresh one journal identity. Concurrent calls for the same key share
   * a single CLI run (deduplication); a key parked by the backoff window
   * is skipped without contacting the CLI; failures retain stale values.
   */
  refresh(target: MetricQueryTarget): Promise<RefreshResult> {
    if (!this.options.enabled()) {
      return Promise.resolve({ key: "<disabled>", status: "disabled" });
    }
    const key = metricKeyOf(target);
    if (key === undefined) {
      return Promise.resolve({ key: "<none>", status: "no_key" });
    }
    const existing = this.entries.get(key);
    if (existing !== undefined && this.isBackedOff(existing, this.now())) {
      return Promise.resolve({ key, status: "backoff", entry: existing });
    }
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const promise = this.runRefresh(key, target);
    this.inFlight.set(key, promise);
    void promise.finally(() => {
      this.inFlight.delete(key);
    });
    return promise;
  }

  private queryArgs(target: MetricQueryTarget): string[] {
    const issn = target.issn !== undefined ? normalizeIssn(target.issn) : undefined;
    if (issn !== undefined) {
      // Pass the ISSN through as provided (the key itself stays normalized).
      return ["metrics", "query", "--issn", target.issn!.trim()];
    }
    return ["metrics", "query", "--journal", (target.journal ?? "").trim()];
  }

  private async runRefresh(
    key: string,
    target: MetricQueryTarget,
  ): Promise<RefreshResult> {
    const now = this.now();
    try {
      const { envelope } = await this.options.client.run(this.queryArgs(target));
      if (envelope.status !== "success") {
        return this.recordFailure(key, now, errorCodeOf(envelope));
      }
      const metrics = metricsFromEnvelope(envelope.data.metrics);
      if (metrics === undefined) {
        return this.recordFailure(key, now, "empty");
      }
      const entry: CachedMetricsEntry = {
        key,
        metrics,
        fetchedAtMs: now,
        stale: false,
      };
      const journal = normalizeJournalName(target.journal ?? "");
      if (journal.length > 0) {
        entry.journal = journal;
      }
      const issn = target.issn !== undefined ? target.issn.trim() : undefined;
      if (issn !== undefined && issn.length > 0) {
        entry.issn = issn;
      }
      this.entries.set(key, entry);
      await this.persist();
      return { key, status: "refreshed", entry };
    } catch {
      return this.recordFailure(key, now, "cli_error");
    }
  }

  private async recordFailure(
    key: string,
    now: number,
    code: MetricErrorCode,
  ): Promise<RefreshResult> {
    const existing = this.entries.get(key);
    if (existing === undefined) {
      // Nothing to retain; a first failure caches nothing.
      return { key, status: "failed" };
    }
    const entry: CachedMetricsEntry = {
      ...existing,
      stale: true,
      retryAfterMs: now + this.backoffMs(),
      lastErrorCode: code,
    };
    this.entries.set(key, entry);
    await this.persist();
    return { key, status: "failed", entry };
  }

  /**
   * Refresh every journal that is missing or older than the TTL, skipping
   * entries parked by the backoff window. Overlapping calls deduplicate
   * through the shared in-flight map. Returns only attempted refreshes.
   */
  async refreshExpired(
    targets: readonly MetricQueryTarget[],
  ): Promise<RefreshResult[]> {
    const now = this.now();
    const results: RefreshResult[] = [];
    for (const target of targets) {
      const key = metricKeyOf(target);
      if (key === undefined) {
        continue;
      }
      const existing = this.entries.get(key);
      if (existing !== undefined && !isExpired(existing, now, this.options.ttlDays())) {
        continue;
      }
      if (existing !== undefined && this.isBackedOff(existing, now)) {
        continue;
      }
      results.push(await this.refresh(target));
    }
    return results;
  }
}
