/**
 * EasyScholar metric cache and UI badges (Task 26).
 *
 * Covers `src/services/metrics-cache.ts`, `src/components/metric-cell.ts`
 * and the Task 26 settings change:
 *
 * - Cache key normalization by ISSN/journal.
 * - Immediate cached display (cached values render before any refresh).
 * - 30-day stale calculation (TTL comes from settings).
 * - Deduplicated background refresh (concurrent calls share one CLI run).
 * - Current-journal and all-expired refresh.
 * - Rate-limit backoff (failed refresh parks the key for a window).
 * - Stale values retained on failure.
 * - Plugin `data.json` stores non-sensitive results only.
 * - No CLI operation other than `metrics query`; no paper write calls;
 *   the cache itself never touches the filesystem or Markdown.
 *
 * All EasyScholar interaction is mocked/offline: the client `run` is a
 * spy or the local fake-CLI fixture; no live endpoint is ever contacted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CliRunResult } from "../src/services/cli-client";
import { CliClient, CliError } from "../src/services/cli-client";
import type { ProtocolEnvelope } from "../src/types/protocol";
import {
  MetricsCache,
  isExpired,
  metricKeyOf,
  metricsFromEnvelope,
  normalizeIssn,
  normalizeJournalName,
  parsePersistedCache,
  serializeCache,
  type CachedMetricsEntry,
} from "../src/services/metrics-cache";
import {
  metricBadgeStateOf,
  metricLabelOf,
  renderMetricBadge,
  type MetricBadgeState,
} from "../src/components/metric-cell";
import {
  DEFAULT_SETTINGS,
  metricsEnabledOf,
  normalizeSettings,
} from "../src/settings";
import { writeFakeCli } from "./fixtures/fake-paper-notes";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TTL_DAYS = 30;

const DEFAULT_METRICS = {
  metrics: {
    cas_partition: "中科院1区",
    jcr_partition: "Q1",
    if: 82.9,
    jci: 8.1,
    if5: 60,
  },
};

function successEnvelope(payload: unknown): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status: "success",
    data: { metrics: payload },
    warnings: [],
    errors: [],
  };
}

function errorEnvelope(code: string): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status: "error",
    data: {},
    warnings: [],
    errors: [{ code, message: "easyscholar error", path: null, field: null }],
  };
}

function entry(overrides: Partial<CachedMetricsEntry> = {}): CachedMetricsEntry {
  return {
    key: "journal:nature medicine",
    journal: "nature medicine",
    metrics: { cas: "中科院1区", jcr: "Q1", if: 82.9, jci: 8.1 },
    fetchedAtMs: NOW,
    stale: false,
    ...overrides,
  };
}

interface MakeCacheOptions {
  load?: () => Promise<unknown>;
  now?: () => number;
  ttlDays?: () => number;
  enabled?: () => boolean;
  backoffMs?: number;
}

function makeCache(options: MakeCacheOptions = {}) {
  const run = vi.fn(
    async (_args: string[]): Promise<CliRunResult> => ({
      envelope: successEnvelope(DEFAULT_METRICS),
      exitCode: 0,
      stderr: "",
    }),
  );
  const save = vi.fn(async (_payload: unknown) => {});
  const load = options.load ?? (async () => undefined);
  const cache = new MetricsCache({
    client: { run } as unknown as Pick<CliClient, "run">,
    ttlDays: options.ttlDays ?? (() => TTL_DAYS),
    enabled: options.enabled ?? (() => true),
    load,
    save,
    now: options.now ?? (() => NOW),
    backoffMs: options.backoffMs,
  });
  return { cache, run, save, load };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Minimal element stub mirroring the Obsidian element API subset used. */
class ElStub {
  textContent = "";
  title = "";
  classes: string[] = [];
  children: ElStub[] = [];

  addClass(cls: string): void {
    this.classes.push(cls);
  }

  createEl(
    _tag: string,
    opts: { cls?: string; text?: string } = {},
  ): ElStub {
    const el = new ElStub();
    el.textContent = opts.text ?? "";
    if (opts.cls !== undefined) {
      el.classes.push(opts.cls);
    }
    this.children.push(el);
    return el;
  }

  createDiv(opts: { cls?: string; text?: string } = {}): ElStub {
    return this.createEl("div", opts);
  }
}

describe("cache key normalization by ISSN/journal", () => {
  it("normalizes journal names: trim, collapse whitespace, lowercase", () => {
    expect(normalizeJournalName("  Nature   MEDICINE ")).toBe("nature medicine");
    expect(normalizeJournalName("Nature Medicine")).toBe("nature medicine");
    expect(normalizeJournalName("  \tNew England Journal of Medicine\t ")).toBe(
      "new england journal of medicine",
    );
  });

  it("normalizes ISSNs: strip separators, uppercase check digit, reject junk", () => {
    expect(normalizeIssn("1078-8956")).toBe("10788956");
    expect(normalizeIssn(" 1078 8956 ")).toBe("10788956");
    expect(normalizeIssn("0028-083x")).toBe("0028083X");
    expect(normalizeIssn("12345")).toBeUndefined();
    expect(normalizeIssn("")).toBeUndefined();
    expect(normalizeIssn("not-an-issn")).toBeUndefined();
    expect(normalizeIssn("1078-89561")).toBeUndefined();
  });

  it("builds a key preferring ISSN over journal, with distinct prefixes", () => {
    expect(metricKeyOf({ journal: "Nature Medicine" })).toBe(
      "journal:nature medicine",
    );
    expect(metricKeyOf({ issn: "1078-8956" })).toBe("issn:10788956");
    expect(metricKeyOf({ journal: "Nature Medicine", issn: "0040-4020" })).toBe(
      "issn:00404020",
    );
    expect(metricKeyOf({ journal: "Nature Medicine", issn: "junk" })).toBe(
      "journal:nature medicine",
    );
    expect(metricKeyOf({})).toBeUndefined();
    expect(metricKeyOf({ journal: "  " })).toBeUndefined();
  });
});

describe("30-day stale calculation", () => {
  it("treats a fresh entry as not expired", () => {
    const cached = entry({ fetchedAtMs: NOW - DAY });
    expect(isExpired(cached, NOW, TTL_DAYS)).toBe(false);
  });

  it("expires exactly at the TTL boundary (30 days)", () => {
    const cached = entry({ fetchedAtMs: NOW - 30 * DAY });
    expect(isExpired(cached, NOW, TTL_DAYS)).toBe(true);
  });

  it("keeps 29-day-old entries fresh", () => {
    const cached = entry({ fetchedAtMs: NOW - 29 * DAY });
    expect(isExpired(cached, NOW, TTL_DAYS)).toBe(false);
  });

  it("honors a custom TTL from settings", () => {
    const cached = entry({ fetchedAtMs: NOW - 8 * DAY });
    expect(isExpired(cached, NOW, 7)).toBe(true);
    expect(isExpired(cached, NOW, 30)).toBe(false);
  });
});

describe("immediate cached display", () => {
  it("renders persisted cached metrics right after loading data.json, with zero CLI calls", async () => {
    const persisted = serializeCache([entry()]);
    const { cache, run } = makeCache({ load: async () => persisted });
    await cache.initialize();

    expect(run).not.toHaveBeenCalled();
    const got = cache.getEntryFor({ journal: "Nature Medicine" });
    expect(got?.metrics).toEqual({ cas: "中科院1区", jcr: "Q1", if: 82.9, jci: 8.1 });
    expect(got?.stale).toBe(false);
  });

  it("keeps showing cached values even after they expire (stale display)", async () => {
    const persisted = serializeCache([
      entry({ fetchedAtMs: NOW - 31 * DAY }),
    ]);
    const { cache } = makeCache({ load: async () => persisted });
    await cache.initialize();

    const got = cache.getEntryFor({ journal: "Nature Medicine" });
    expect(got?.metrics.if).toBe(82.9);
    expect(isExpired(got as CachedMetricsEntry, NOW, TTL_DAYS)).toBe(true);
  });

  it("makes a freshly refreshed value visible immediately", async () => {
    const { cache } = makeCache();
    const result = await cache.refresh({ journal: "Nature Medicine" });
    expect(result.status).toBe("refreshed");
    expect(cache.getEntryFor({ journal: "nature medicine" })?.metrics.if).toBe(
      82.9,
    );
  });
});

describe("deduplicated background refresh", () => {
  it("shares one CLI run between concurrent refreshes of the same journal", async () => {
    const { cache, run } = makeCache();
    const pending = deferred<CliRunResult>();
    run.mockReturnValueOnce(pending.promise);

    const first = cache.refresh({ journal: "Nature Medicine" });
    const second = cache.refresh({ journal: "nature medicine" });
    expect(first).toBe(second);

    pending.resolve({
      envelope: successEnvelope(DEFAULT_METRICS),
      exitCode: 0,
      stderr: "",
    });
    expect((await first).status).toBe("refreshed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("deduplicates refreshExpired against an in-flight refresh", async () => {
    const { cache, run } = makeCache();
    const pending = deferred<CliRunResult>();
    run.mockReturnValueOnce(pending.promise);

    const all = cache.refreshExpired([{ journal: "Nature" }, { journal: "nature" }]);
    const single = cache.refresh({ journal: "NATURE" });
    pending.resolve({
      envelope: successEnvelope(DEFAULT_METRICS),
      exitCode: 0,
      stderr: "",
    });
    await Promise.all([all, single]);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("current-journal and all-expired refresh", () => {
  it("refreshes the current journal via --journal", async () => {
    const { cache, run } = makeCache();
    const result = await cache.refresh({ journal: "Nature Medicine" });
    expect(result.status).toBe("refreshed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual([
      "metrics",
      "query",
      "--journal",
      "Nature Medicine",
    ]);
  });

  it("prefers --issn when an ISSN is present", async () => {
    const { cache, run } = makeCache();
    await cache.refresh({ journal: "Nature Medicine", issn: "0028-0836" });
    expect(run.mock.calls[0][0]).toEqual([
      "metrics",
      "query",
      "--issn",
      "0028-0836",
    ]);
  });

  it("refreshes only missing or expired journals, skipping fresh ones", async () => {
    const expired = entry({
      key: "journal:expired journal",
      journal: "expired journal",
      fetchedAtMs: NOW - 31 * DAY,
    });
    const fresh = entry({
      key: "journal:fresh journal",
      journal: "fresh journal",
      fetchedAtMs: NOW - DAY,
    });
    const { cache, run } = makeCache({
      load: async () => serializeCache([expired, fresh]),
    });
    await cache.initialize();

    const results = await cache.refreshExpired([
      { journal: "Expired Journal" },
      { journal: "Fresh Journal" },
      { journal: "Missing Journal" },
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "refreshed",
      "refreshed",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual([
      "metrics",
      "query",
      "--journal",
      "Expired Journal",
    ]);
    expect(run.mock.calls[1][0]).toEqual([
      "metrics",
      "query",
      "--journal",
      "Missing Journal",
    ]);
  });

  it("skips journals without an identity and reports nothing to refresh", async () => {
    const { cache, run } = makeCache();
    const results = await cache.refreshExpired([{ journal: "  " }, {}]);
    expect(results).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect((await cache.refresh({})).status).toBe("no_key");
  });
});

describe("rate-limit backoff", () => {
  it("parks a key for the backoff window after a failed refresh", async () => {
    let clock = NOW;
    const prior = entry({ key: "journal:nature" });
    const { cache, run } = makeCache({
      load: async () => serializeCache([prior]),
      now: () => clock,
      backoffMs: 60_000,
    });
    await cache.initialize();
    run.mockImplementationOnce(async () => ({
      envelope: errorEnvelope("rate_limited"),
      exitCode: 1,
      stderr: "",
    }));

    const failed = await cache.refresh({ journal: "Nature" });
    expect(failed.status).toBe("failed");
    expect(failed.entry?.stale).toBe(true);
    expect(failed.entry?.lastErrorCode).toBe("rate_limited");
    expect(failed.entry?.retryAfterMs).toBe(NOW + 60_000);

    clock = NOW + 30_000;
    const within = await cache.refresh({ journal: "Nature" });
    expect(within.status).toBe("backoff");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries once the backoff window has passed and clears it on success", async () => {
    let clock = NOW;
    const prior = entry({ key: "journal:nature" });
    const { cache, run } = makeCache({
      load: async () => serializeCache([prior]),
      now: () => clock,
      backoffMs: 60_000,
    });
    await cache.initialize();
    run.mockImplementationOnce(async () => ({
      envelope: errorEnvelope("easyscholar_error"),
      exitCode: 1,
      stderr: "",
    }));

    await cache.refresh({ journal: "Nature" });
    expect(run).toHaveBeenCalledTimes(1);

    clock = NOW + 120_000;
    const again = await cache.refresh({ journal: "Nature" });
    expect(again.status).toBe("refreshed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(cache.getEntryFor({ journal: "Nature" })?.retryAfterMs).toBeUndefined();
    expect(cache.getEntryFor({ journal: "Nature" })?.stale).toBe(false);
  });

  it("skips backed-off expired journals during all-expired refresh", async () => {
    const prior = entry({
      key: "journal:nature",
      fetchedAtMs: NOW - 31 * DAY,
      retryAfterMs: NOW + 60_000,
      lastErrorCode: "rate_limited",
      stale: true,
    });
    const { cache, run } = makeCache({
      load: async () => serializeCache([prior]),
    });
    await cache.initialize();

    const results = await cache.refreshExpired([{ journal: "Nature" }]);
    expect(results).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("stale values retained on failure", () => {
  it("keeps the cached value, marks it stale and records the error", async () => {
    const prior = entry({ key: "journal:nature medicine" });
    const { cache, run } = makeCache({
      load: async () => serializeCache([prior]),
    });
    await cache.initialize();
    run.mockImplementationOnce(async () => {
      throw new CliError({ code: "cli_error", message: "CLI exploded" });
    });

    const result = await cache.refresh({ journal: "Nature Medicine" });
    expect(result.status).toBe("failed");

    const got = cache.getEntryFor({ journal: "Nature Medicine" });
    expect(got?.metrics.if).toBe(82.9);
    expect(got?.stale).toBe(true);
    expect(got?.lastErrorCode).toBe("cli_error");
    expect(got?.retryAfterMs).toBe(NOW + 60_000);
  });

  it("persists the retained stale value to data.json", async () => {
    const prior = entry({ key: "journal:nature medicine" });
    const { cache, run, save } = makeCache({
      load: async () => serializeCache([prior]),
    });
    await cache.initialize();
    run.mockImplementationOnce(async () => ({
      envelope: errorEnvelope("easyscholar_error"),
      exitCode: 1,
      stderr: "",
    }));

    await cache.refresh({ journal: "Nature Medicine" });
    expect(save).toHaveBeenCalledTimes(1);
    const persisted = save.mock.calls[0][0] as {
      entries: Array<Record<string, unknown>>;
    };
    expect(persisted.entries[0].metrics).toEqual({
      cas: "中科院1区",
      jcr: "Q1",
      if: 82.9,
      jci: 8.1,
    });
    expect(persisted.entries[0].stale).toBe(true);
  });

  it("caches nothing when a first refresh fails (no value to retain)", async () => {
    const { cache, run, save } = makeCache();
    run.mockImplementationOnce(async () => {
      throw new CliError({ code: "timeout", message: "slow CLI" });
    });

    const result = await cache.refresh({ journal: "Nature Medicine" });
    expect(result.status).toBe("failed");
    expect(cache.getEntryFor({ journal: "Nature Medicine" })).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("treats an error envelope and an empty result as failures", async () => {
    let clock = NOW;
    const prior = entry({ key: "journal:nature" });
    const { cache, run } = makeCache({
      load: async () => serializeCache([prior]),
      now: () => clock,
      backoffMs: 60_000,
    });
    await cache.initialize();

    run.mockImplementationOnce(async () => ({
      envelope: errorEnvelope("easyscholar_error"),
      exitCode: 1,
      stderr: "",
    }));
    const errorStatus = await cache.refresh({ journal: "Nature" });
    expect(errorStatus.status).toBe("failed");
    expect(errorStatus.entry?.lastErrorCode).toBe("cli_error");

    clock = NOW + 120_000;
    run.mockImplementationOnce(async () => ({
      envelope: {
        protocol_version: 1,
        status: "success",
        data: {},
        warnings: [],
        errors: [],
      },
      exitCode: 0,
      stderr: "",
    }));
    const empty = await cache.refresh({ journal: "Nature" });
    expect(empty.status).toBe("failed");
    expect(empty.entry?.lastErrorCode).toBe("empty");
    expect(cache.getEntryFor({ journal: "Nature" })?.metrics.if).toBe(82.9);
    expect(cache.getEntryFor({ journal: "Nature" })?.stale).toBe(true);
  });
});

describe("data.json stores non-sensitive results only", () => {
  it("serializes exactly the whitelisted fields", () => {
    const cached = entry({
      key: "issn:10788956",
      issn: "10788956",
      journal: undefined,
    });
    const serialized = serializeCache([cached]) as {
      version: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(serialized.version).toBe(1);
    expect(serialized.entries).toEqual([
      {
        key: "issn:10788956",
        issn: "10788956",
        metrics: { cas: "中科院1区", jcr: "Q1", if: 82.9, jci: 8.1 },
        fetchedAtMs: NOW,
        stale: false,
      },
    ]);
  });

  it("drops unknown or secret-like fields when loading persisted data", () => {
    const parsed = parsePersistedCache({
      version: 1,
      entries: [
        {
          key: "journal:nature medicine",
          journal: "nature medicine",
          metrics: { if: 82.9, cas: "中科院1区" },
          fetchedAtMs: NOW,
          stale: false,
          secret: "sk-abc123def456",
          apiKey: "hunter2",
          easyscholarSecretKey: "zzz",
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      key: "journal:nature medicine",
      journal: "nature medicine",
      metrics: { if: 82.9, cas: "中科院1区" },
      fetchedAtMs: NOW,
      stale: false,
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-abc123def456");
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  it("rejects malformed persisted payloads and entries", () => {
    expect(parsePersistedCache(null)).toEqual([]);
    expect(parsePersistedCache([])).toEqual([]);
    expect(parsePersistedCache({})).toEqual([]);
    expect(parsePersistedCache({ entries: "nope" })).toEqual([]);
    expect(
      parsePersistedCache({
        entries: [
          null,
          "x",
          { key: "" },
          { key: "k", metrics: {}, fetchedAtMs: NOW, stale: false },
          { key: "k", metrics: { if: NaN }, fetchedAtMs: NOW, stale: false },
          { key: "k", metrics: { if: 1 }, fetchedAtMs: "later", stale: false },
          { key: "k", metrics: { if: 1 }, fetchedAtMs: NOW, stale: "yes" },
          { key: "k", metrics: { if: 1 }, fetchedAtMs: NOW, stale: false },
        ],
      }),
    ).toEqual([
      {
        key: "k",
        metrics: { if: 1 },
        fetchedAtMs: NOW,
        stale: false,
      },
    ]);
  });

  it("round-trips serialized entries through the parser losslessly", () => {
    const cached = entry();
    const parsed = parsePersistedCache(serializeCache([cached]));
    expect(parsed).toEqual([cached]);
  });
});

describe("CLI contract: only `metrics query`, never a paper write", () => {
  it("only ever invokes metrics query subcommands", async () => {
    const { cache, run } = makeCache();
    await cache.refresh({ journal: "Nature Medicine" });
    await cache.refresh({ issn: "1078-8956" });
    await cache.refresh({ journal: "Both", issn: "0040-4020" });

    expect(run).toHaveBeenCalledTimes(3);
    const args = run.mock.calls.map((call) => call[0]);
    expect(args[0]).toEqual(["metrics", "query", "--journal", "Nature Medicine"]);
    expect(args[1]).toEqual(["metrics", "query", "--issn", "1078-8956"]);
    expect(args[2]).toEqual(["metrics", "query", "--issn", "0040-4020"]);
    for (const invocation of args) {
      expect(invocation[0]).toBe("metrics");
      expect(invocation[1]).toBe("query");
      expect(invocation).toHaveLength(4);
      expect(invocation[2]).toMatch(/^--(journal|issn)$/);
    }
  });

  it("maps normalized EasyScholar fields onto PaperMetrics, dropping extras", () => {
    expect(
      metricsFromEnvelope({
        metrics: {
          cas_partition: "中科院1区",
          jcr_partition: "Q1",
          if: 82.9,
          jci: 8.1,
          if5: 60,
          bogus: "x",
        },
      }),
    ).toEqual({ cas: "中科院1区", jcr: "Q1", if: 82.9, jci: 8.1 });

    expect(metricsFromEnvelope(undefined)).toBeUndefined();
    expect(metricsFromEnvelope({})).toBeUndefined();
    expect(metricsFromEnvelope({ metrics: {} })).toBeUndefined();
    expect(metricsFromEnvelope({ metrics: { if: "69.5" } })).toEqual({
      if: 69.5,
    });
  });

  it("spawns the real CLI once and maps its envelope (offline fake CLI)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-verify-"));
    try {
      const script = writeFakeCli(directory, {
        stdoutRaw:
          JSON.stringify({
            protocol_version: 1,
            status: "success",
            data: {
              metrics: {
                source: "easyscholar",
                journal: "Nature Medicine",
                issn: "0028-0836",
                level: "nature",
                metrics: {
                  if: 69.5,
                  if5: 60,
                  jci: 15.2,
                  jcr_partition: "Q1",
                  cas_partition: "中科院1区",
                },
              },
            },
            warnings: [],
            errors: [],
          }) + "\n",
      });
      const save = vi.fn(async (_payload: unknown) => {});
      const cache = new MetricsCache({
        client: new CliClient(script),
        ttlDays: () => TTL_DAYS,
        enabled: () => true,
        load: async () => undefined,
        save,
        now: () => NOW,
      });

      const result = await cache.refresh({ journal: "Nature Medicine" });
      expect(result.status).toBe("refreshed");
      expect(result.entry?.metrics).toEqual({
        cas: "中科院1区",
        jcr: "Q1",
        if: 69.5,
        jci: 15.2,
      });
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("settings: metrics toggle", () => {
  it("defaults metric badges to enabled (absent/legacy data.json keeps them on)", () => {
    expect(metricsEnabledOf(DEFAULT_SETTINGS)).toBe(true);
    expect(normalizeSettings({}).metricsEnabled).toBeUndefined();
    expect(metricsEnabledOf(normalizeSettings({}))).toBe(true);
  });

  it("normalizes an explicit metricsEnabled toggle", () => {
    expect(normalizeSettings({ metricsEnabled: false }).metricsEnabled).toBe(
      false,
    );
    expect(metricsEnabledOf(normalizeSettings({ metricsEnabled: false }))).toBe(
      false,
    );
    expect(normalizeSettings({ metricsEnabled: 1 }).metricsEnabled).toBe(
      undefined,
    );
    expect(normalizeSettings({ metricsEnabled: "no" }).metricsEnabled).toBe(
      undefined,
    );
  });

  it("refuses to refresh or display metrics when disabled", async () => {
    const { cache, run } = makeCache({ enabled: () => false });
    const result = await cache.refresh({ journal: "Nature Medicine" });
    expect(result.status).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
    expect(cache.getEntryFor({ journal: "Nature Medicine" })).toBeUndefined();
  });
});

describe("metric cell badges", () => {
  it("maps each metric kind to its column label", () => {
    expect(metricLabelOf("cas")).toBe("CAS");
    expect(metricLabelOf("jcr")).toBe("JCR");
    expect(metricLabelOf("if")).toBe("IF");
    expect(metricLabelOf("jci")).toBe("JCI");
  });

  it("formats badge values per kind", () => {
    const cached = entry();
    const ifState = metricBadgeStateOf("if", cached, NOW, TTL_DAYS);
    expect(ifState?.value).toBe("82.9");
    expect(ifState?.label).toBe("IF");
    const casState = metricBadgeStateOf("cas", cached, NOW, TTL_DAYS);
    expect(casState?.value).toBe("中科院1区");
    const jciState = metricBadgeStateOf("jci", cached, NOW, TTL_DAYS);
    expect(jciState?.value).toBe("8.1");
  });

  it("flags stale badges from failed refreshes and expiry", () => {
    const failed = entry({ key: "k", stale: true, lastErrorCode: "cli_error" });
    expect(metricBadgeStateOf("if", failed, NOW, TTL_DAYS)?.stale).toBe(true);
    const expired = entry({ key: "k", fetchedAtMs: NOW - 31 * DAY });
    expect(metricBadgeStateOf("if", expired, NOW, TTL_DAYS)?.stale).toBe(true);
    const fresh = entry({ key: "k" });
    expect(metricBadgeStateOf("if", fresh, NOW, TTL_DAYS)?.stale).toBe(false);
  });

  it("omits badges for missing entries or missing values", () => {
    expect(metricBadgeStateOf("if", undefined, NOW, TTL_DAYS)).toBeUndefined();
    const noIf = entry({ key: "k", metrics: { cas: "中科院1区" } });
    expect(metricBadgeStateOf("if", noIf, NOW, TTL_DAYS)).toBeUndefined();
    expect(metricBadgeStateOf("cas", noIf, NOW, TTL_DAYS)?.value).toBe(
      "中科院1区",
    );
  });

  it("includes cache provenance in the tooltip", () => {
    const failed = entry({ key: "k", stale: true, lastErrorCode: "cli_error" });
    const staleState = metricBadgeStateOf("if", failed, NOW, TTL_DAYS) as MetricBadgeState;
    expect(staleState.tooltip.toLowerCase()).toContain("failed");
    expect(staleState.tooltip.toLowerCase()).toContain("cached");
    const freshState = metricBadgeStateOf(
      "if",
      entry({ key: "k" }),
      NOW,
      TTL_DAYS,
    ) as MetricBadgeState;
    expect(freshState.tooltip.toLowerCase()).toContain("cached");
    expect(freshState.tooltip.toLowerCase()).not.toContain("failed");
  });

  it("renders a badge element with value text, classes and title", () => {
    const host = new ElStub();
    const badge = renderMetricBadge(host as unknown as HTMLElement, {
      kind: "if",
      label: "IF",
      value: "82.9",
      stale: true,
      tooltip: "Stale — cached 2027-01-01",
    });
    expect(badge).toBe(host.children[0]);
    expect(host.children[0].textContent).toBe("82.9");
    expect(host.children[0].classes).toContain("paper-notes-metric-badge");
    expect(host.children[0].classes).toContain("paper-notes-metric-badge-stale");
    expect(host.children[0].title).toBe("Stale — cached 2027-01-01");

    const freshHost = new ElStub();
    renderMetricBadge(freshHost as unknown as HTMLElement, {
      kind: "cas",
      label: "CAS",
      value: "中科院1区",
      stale: false,
      tooltip: "Cached 2027-01-01",
    });
    expect(freshHost.children[0].classes).not.toContain(
      "paper-notes-metric-badge-stale",
    );
  });
});
