/**
 * metrics-drawer-ui: Detail Drawer Metrics section — Refresh control,
 * empty/stale/failure/backoff status, badge reuse, command panel refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  drawerMetricsStatusOf,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import {
  MetricsCache,
  serializeCache,
  type CachedMetricsEntry,
} from "../src/services/metrics-cache";
import type { PaperRecord } from "../src/types/paper";
import type { ProtocolEnvelope } from "../src/types/protocol";
import type { CliClient, CliRunResult } from "../src/services/cli-client";

const mockNotices: string[] = [];

vi.mock("obsidian", () => {
  interface ElOpts {
    cls?: string;
    text?: string;
    value?: string;
    attr?: Record<string, unknown>;
  }

  class El {
    tag: string;
    cls = "";
    textContent = "";
    value = "";
    checked = false;
    selected = false;
    disabled = false;
    clientWidth = 1000;
    style: Record<string, string> = {};
    children: El[] = [];
    listeners: Record<string, (event?: unknown) => void> = {};
    attrs: Record<string, string> = {};

    constructor(tag: string) {
      this.tag = tag;
    }

    addEventListener(type: string, fn: (event?: unknown) => void): void {
      this.listeners[type] = fn;
    }
    addClass(cls: string): void {
      for (const token of cls.split(/\s+/).filter(Boolean)) {
        if (!this.cls.split(/\s+/).includes(token)) {
          this.cls = this.cls.length > 0 ? `${this.cls} ${token}` : token;
        }
      }
    }
    removeClass(cls: string): void {
      this.cls = this.cls
        .split(/\s+/)
        .filter((token) => token.length > 0 && token !== cls)
        .join(" ");
    }
    toggleClass(_cls: string, _on?: boolean): void {}
    empty(): void {
      this.children = [];
    }
    createDiv(opts?: ElOpts): El {
      return this.createEl("div", opts);
    }
    createEl(tag: string, opts?: ElOpts): El {
      const child = new El(tag);
      if (opts?.cls !== undefined) {
        child.addClass(opts.cls);
      }
      if (opts?.text !== undefined) {
        child.textContent = opts.text;
      }
      if (opts?.value !== undefined) {
        child.value = String(opts.value);
      }
      if (opts?.attr !== undefined) {
        for (const [key, value] of Object.entries(opts.attr)) {
          child.attrs[key] = String(value);
        }
      }
      this.children.push(child);
      return child;
    }
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
  }

  class ItemView {
    leaf: unknown;
    app: Record<string, never> = {};
    containerEl: El;
    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.containerEl = new El("div");
      this.containerEl.clientWidth = 1000;
    }
    open(): void {}
  }

  class WorkspaceLeaf {}
  class Notice {
    constructor(message: string) {
      mockNotices.push(message);
    }
  }

  return { ItemView, WorkspaceLeaf, Notice };
});

const NOTE_PATH = "05 Literature/alpha2024/alpha2024.md";
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);
const DAY = 86_400_000;

function makeRecord(): PaperRecord {
  return {
    path: NOTE_PATH,
    key: "alpha2024",
    paperId: "550e8400-e29b-41d4-a716-446655440000",
    title: "Alpha cells",
    authors: [{ family: "Shiau", given: "Wen" }],
    journal: "Nature Methods",
    year: 2024,
    identifiers: { doi: "10.1000/alpha" },
    citationKeyAliases: [],
    titleAliases: [],
    abstract: "Abstract text.",
  };
}

function makeSource(records: PaperRecord[] = [makeRecord()]): LibraryViewSource {
  return {
    getRecords: () => records,
    getInvalidRecords: () => [],
    getFrontmatter: () => undefined,
    listDirectory: () => ["alpha2024.pdf"],
    getCards: () => [],
  };
}

interface ElLike {
  tag?: string;
  cls: string;
  textContent: string;
  style: Record<string, string>;
  children: ElLike[];
  listeners: Record<string, (event?: unknown) => void>;
  attrs?: Record<string, string>;
  clientWidth?: number;
}

function findByClass(root: ElLike, cls: string): ElLike[] {
  const found: ElLike[] = [];
  const walk = (node: ElLike): void => {
    if (
      node.cls === cls ||
      node.cls.split(/\s+/).filter(Boolean).includes(cls)
    ) {
      found.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

function rowsOf(view: PaperNotesLibraryView): ElLike[] {
  const root = view.containerEl as unknown as ElLike;
  const table = findByClass(root, "paper-notes-library-table")[0];
  const tbody = table.children.find((child) => child.tag === "tbody");
  return tbody === undefined ? [] : tbody.children;
}

async function openDrawer(view: PaperNotesLibraryView): Promise<void> {
  rowsOf(view)[0].listeners["click"]?.({});
  await vi.advanceTimersByTimeAsync(300);
}

function drawerPanel(view: PaperNotesLibraryView): ElLike {
  return findByClass(
    view.containerEl as unknown as ElLike,
    "paper-notes-library-drawer-panel",
  )[0];
}

function metricsSection(view: PaperNotesLibraryView): ElLike {
  return findByClass(drawerPanel(view), "detail-section-metrics")[0];
}

function entry(overrides: Partial<CachedMetricsEntry> = {}): CachedMetricsEntry {
  return {
    key: "journal:nature methods",
    journal: "nature methods",
    metrics: { cas: "中科院1区", jcr: "Q1", if: 28.1, jci: 4.2 },
    fetchedAtMs: NOW,
    stale: false,
    ...overrides,
  };
}

function successEnvelope(metrics: Record<string, unknown>): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status: "success",
    data: { metrics },
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

interface BridgeOptions {
  run?: (args: string[]) => Promise<CliRunResult>;
  settings?: Record<string, unknown>;
  load?: () => Promise<unknown>;
  commands?: Array<{ id: string; name: string; callback: () => void }>;
}

function installMetricsBridge(
  view: PaperNotesLibraryView,
  options: BridgeOptions = {},
): {
  run: ReturnType<typeof vi.fn>;
  commands: Array<{ id: string; name: string; callback: () => void }>;
} {
  const run =
    options.run ??
    vi.fn(async (_args: string[]): Promise<CliRunResult> => ({
      envelope: successEnvelope({
        cas_partition: "中科院1区",
        jcr_partition: "Q1",
        if: 28.1,
        jci: 4.2,
      }),
      exitCode: 0,
      stderr: "",
    }));
  const commands =
    options.commands ??
    ([] as Array<{ id: string; name: string; callback: () => void }>);
  (view as unknown as { app: unknown }).app = {
    vault: { adapter: { getBasePath: () => "/vault" } },
    plugins: {
      plugins: {
        "paper-notes": {
          getCliClient: () => ({ run }) as unknown as CliClient,
          settings: {
            metricTtlDays: 30,
            metricsEnabled: true,
            ...(options.settings ?? {}),
          },
          loadData: options.load ?? (async () => ({})),
          saveData: async () => {},
          addCommand: (command: {
            id: string;
            name: string;
            callback: () => void;
          }) => {
            commands.push(command);
          },
        },
      },
    },
  };
  return { run: run as ReturnType<typeof vi.fn>, commands };
}

/** Force a pre-built MetricsCache onto the view (skips lazy bridge init). */
function injectCache(
  view: PaperNotesLibraryView,
  cache: MetricsCache,
): void {
  const target = view as unknown as {
    metricsCache: MetricsCache;
    metricsResolved: boolean;
  };
  target.metricsCache = cache;
  target.metricsResolved = true;
}

function makeCache(options: {
  load?: () => Promise<unknown>;
  run?: ReturnType<typeof vi.fn>;
  now?: () => number;
  backoffMs?: number;
}): { cache: MetricsCache; run: ReturnType<typeof vi.fn> } {
  const run =
    options.run ??
    vi.fn(async (): Promise<CliRunResult> => ({
      envelope: successEnvelope({
        cas_partition: "中科院1区",
        jcr_partition: "Q1",
        if: 99,
        jci: 9,
      }),
      exitCode: 0,
      stderr: "",
    }));
  const cache = new MetricsCache({
    client: { run } as unknown as Pick<CliClient, "run">,
    ttlDays: () => 30,
    enabled: () => true,
    load: options.load ?? (async () => undefined),
    save: async () => {},
    now: options.now ?? (() => NOW),
    backoffMs: options.backoffMs ?? 60_000,
  });
  return { cache, run };
}

describe("drawerMetricsStatusOf (pure)", () => {
  const cacheStub = {
    isBackedOff: (e: CachedMetricsEntry, now: number) =>
      e.retryAfterMs !== undefined && e.retryAfterMs > now,
  };

  it("reports empty when no entry", () => {
    const status = drawerMetricsStatusOf(undefined, cacheStub, NOW);
    expect(status.kind).toBe("empty");
    expect(status.text.toLowerCase()).toContain("no journal metrics");
  });

  it("reports backoff while retryAfterMs is in the future", () => {
    const status = drawerMetricsStatusOf(
      entry({
        stale: true,
        lastErrorCode: "rate_limited",
        retryAfterMs: NOW + 30_000,
      }),
      cacheStub,
      NOW,
    );
    expect(status.kind).toBe("backoff");
    expect(status.text.toLowerCase()).toContain("backoff");
  });

  it("reports failure when stale with lastErrorCode", () => {
    const status = drawerMetricsStatusOf(
      entry({ stale: true, lastErrorCode: "cli_error" }),
      cacheStub,
      NOW,
    );
    expect(status.kind).toBe("failure");
    expect(status.text.toLowerCase()).toContain("failed");
  });

  it("reports stale for expired TTL without failure flag", () => {
    const status = drawerMetricsStatusOf(
      entry({ fetchedAtMs: NOW - 31 * DAY }),
      cacheStub,
      NOW,
      30,
    );
    expect(status.kind).toBe("stale");
    expect(status.text.toLowerCase()).toContain("expired");
  });

  it("reports ok for a fresh entry", () => {
    const status = drawerMetricsStatusOf(entry(), cacheStub, NOW, 30);
    expect(status.kind).toBe("ok");
    expect(status.text.toLowerCase()).toContain("cached");
  });
});

describe("Drawer Metrics section UI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockNotices.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("always renders Metrics section with Refresh even when empty", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawer(view);
    const section = metricsSection(view);
    expect(section).toBeDefined();
    const refresh = findByClass(section, "paper-notes-detail-metrics-refresh")[0];
    expect(refresh?.textContent).toBe("Refresh");
    expect(refresh?.attrs?.["aria-label"]).toBe("Refresh journal metrics");
    const status = findByClass(section, "paper-notes-metrics-status--empty")[0];
    expect(status?.textContent.toLowerCase()).toContain("no journal metrics");
  });

  it("shows cache badges with tone + stale class and failure status", async () => {
    const { cache } = makeCache({
      load: async () =>
        serializeCache([
          entry({
            stale: true,
            lastErrorCode: "cli_error",
            metrics: { cas: "中科院1区", jcr: "Q1", if: 28.1, jci: 4.2 },
          }),
        ]),
    });
    await cache.initialize();
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    injectCache(view, cache);
    await view.onOpen();
    await openDrawer(view);
    const section = metricsSection(view);
    expect(
      findByClass(section, "paper-notes-metrics-status--failure")[0]?.textContent,
    ).toMatch(/failed/i);
    const badges = findByClass(section, "paper-notes-metric-badge");
    expect(badges.length).toBe(4);
    expect(
      findByClass(section, "paper-notes-metric-badge-stale").length,
    ).toBeGreaterThan(0);
    expect(
      findByClass(section, "paper-notes-metric-badge--if-ge20").length,
    ).toBe(1);
  });

  it("shows backoff status when entry is parked", async () => {
    const { cache } = makeCache({
      load: async () =>
        serializeCache([
          entry({
            stale: true,
            lastErrorCode: "rate_limited",
            retryAfterMs: NOW + 45_000,
          }),
        ]),
    });
    await cache.initialize();
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    injectCache(view, cache);
    await view.onOpen();
    await openDrawer(view);
    const section = metricsSection(view);
    const status = findByClass(section, "paper-notes-metrics-status--backoff")[0];
    expect(status?.textContent.toLowerCase()).toContain("backoff");
  });

  it("Refresh button calls cache.refresh for the current journal", async () => {
    const run = vi.fn(async (): Promise<CliRunResult> => ({
      envelope: successEnvelope({
        cas_partition: "中科院2区",
        jcr_partition: "Q2",
        if: 5.5,
        jci: 1.1,
      }),
      exitCode: 0,
      stderr: "",
    }));
    const { cache } = makeCache({ run });
    await cache.initialize();
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    // Bridge still needed for notices path after refresh re-render.
    installMetricsBridge(view, { run });
    injectCache(view, cache);
    await view.onOpen();
    await openDrawer(view);
    const section = metricsSection(view);
    const refresh = findByClass(section, "paper-notes-detail-metrics-refresh")[0];
    refresh.listeners["click"]?.({
      preventDefault() {},
      stopPropagation() {},
    });
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls.length).toBeGreaterThan(0);
    const args = (run.mock.calls[0] as unknown as [string[]])[0];
    expect(args.slice(0, 2)).toEqual(["metrics", "query"]);
    expect(args).toContain("--journal");
    expect(args).toContain("Nature Methods");
    expect(mockNotices.some((n) => /refreshed/i.test(n))).toBe(true);
    // After refresh, drawer re-renders with new badges.
    const after = metricsSection(view);
    expect(
      findByClass(after, "paper-notes-metric-badge--if")[0]?.textContent,
    ).toBe("5.5");
  });

  it("command palette refresh still works alongside drawer Refresh", async () => {
    const commands: Array<{ id: string; name: string; callback: () => void }> =
      [];
    const run = vi.fn(async (): Promise<CliRunResult> => ({
      envelope: successEnvelope({
        cas_partition: "中科院1区",
        jcr_partition: "Q1",
        if: 11,
        jci: 2,
      }),
      exitCode: 0,
      stderr: "",
    }));
    const { cache } = makeCache({ run });
    await cache.initialize();
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    installMetricsBridge(view, { run, commands });
    // Let getMetricsCache register commands once, then keep our cache.
    (view as unknown as { metricsResolved: boolean }).metricsResolved = false;
    (view as unknown as { metricsCache: undefined }).metricsCache = undefined;
    // Trigger command registration via real cache path:
    const realCache = (
      view as unknown as { getMetricsCache: () => MetricsCache | undefined }
    ).getMetricsCache();
    expect(realCache).toBeDefined();
    expect(commands.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "paper-notes-refresh-journal-metrics",
        "paper-notes-refresh-all-metrics",
      ]),
    );
    await view.onOpen();
    await openDrawer(view);
    // Select path is set by drawer open; invoke command.
    const journalCmd = commands.find(
      (c) => c.id === "paper-notes-refresh-journal-metrics",
    );
    expect(journalCmd).toBeDefined();
    journalCmd!.callback();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalled();
    expect(mockNotices.some((n) => /refreshed|backoff|failed|nothing/i.test(n))).toBe(
      true,
    );
  });

  it("Refresh failure retains values and shows backoff/failure status", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        envelope: successEnvelope({
          cas_partition: "中科院1区",
          jcr_partition: "Q1",
          if: 28.1,
          jci: 4.2,
        }),
        exitCode: 0,
        stderr: "",
      })
      .mockResolvedValueOnce({
        envelope: errorEnvelope("cli_error"),
        exitCode: 1,
        stderr: "boom",
      });
    const { cache } = makeCache({ run });
    await cache.initialize();
    // Seed a good entry first.
    await cache.refresh({ journal: "Nature Methods" });
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    installMetricsBridge(view, { run });
    injectCache(view, cache);
    await view.onOpen();
    await openDrawer(view);
    const refresh = findByClass(
      metricsSection(view),
      "paper-notes-detail-metrics-refresh",
    )[0];
    refresh.listeners["click"]?.({
      preventDefault() {},
      stopPropagation() {},
    });
    await vi.runAllTimersAsync();
    const section = metricsSection(view);
    // Immediate post-failure is parked in backoff (css token --backoff);
    // failure token appears once the window ends with stale still set.
    const backoff = findByClass(section, "paper-notes-metrics-status--backoff")[0];
    const failure = findByClass(section, "paper-notes-metrics-status--failure")[0];
    expect(backoff ?? failure).toBeDefined();
    expect(
      findByClass(section, "paper-notes-metric-badge--if")[0]?.textContent,
    ).toBe("28.1");
    expect(
      findByClass(section, "paper-notes-metric-badge-stale").length,
    ).toBeGreaterThan(0);
    expect(mockNotices.some((n) => /failed/i.test(n))).toBe(true);
  });
});
