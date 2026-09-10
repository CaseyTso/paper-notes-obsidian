import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

vi.mock("obsidian", () => import("./obsidian.mock"));
import { registeredEvents, resetRegistries } from "./obsidian.mock";

import PaperNotesPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { PaperRecord } from "../src/types/paper";
import {
  classifyOpenedFile,
  deserializeRecentActivity,
  RecentActivityStore,
  type ActivityStorageBridge,
  type RecentActivityData,
} from "../src/services/recent-activity";

function makePaperRecord(
  key: string,
  overrides?: Partial<PaperRecord>,
): PaperRecord {
  return {
    path: `05 Literature/${key}/${key}.md`,
    key,
    paperId: `00000000-0000-0000-0000-${key.padEnd(12, "0").slice(0, 12)}`,
    title: `Title for ${key}`,
    authors: [{ family: "Author" }],
    identifiers: {},
    citationKeyAliases: [],
    titleAliases: [],
    ...overrides,
  };
}

class MemoryStorageBridge implements ActivityStorageBridge {
  data: Record<string, unknown> = {};
  loadCalls = 0;
  saveCalls = 0;
  delayMs = 0;

  async loadData(): Promise<unknown> {
    this.loadCalls++;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return JSON.parse(JSON.stringify(this.data));
  }

  async saveData(data: unknown): Promise<void> {
    this.saveCalls++;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.data = JSON.parse(JSON.stringify(data));
  }
}

describe("R2 Recent Activity - Path Classification (Contract 2 & 3)", () => {
  const ROOT = "05 Literature";

  it("hits Primary PDF with strict canonical key matching", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/smith2024.pdf");
    expect(result).toEqual({ key: "smith2024", kind: "pdf" });
  });

  it("hits Figure note with strict canonical key matching", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/Figure解读_smith2024.md");
    expect(result).toEqual({ key: "smith2024", kind: "figure" });
  });

  it("ignores regular literature note (<key>/<key>.md)", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/smith2024.md");
    expect(result).toBeNull();
  });

  it("ignores MinerU output (minerUmd_*.md)", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/minerUmd_smith2024.md");
    expect(result).toBeNull();
  });

  it("ignores card notes under cards/", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/cards/card1.md");
    expect(result).toBeNull();
  });

  it("ignores path shape mismatch with PDF directly in root", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/random.pdf");
    expect(result).toBeNull();
  });

  it("ignores PDF filename that does not match directory key", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/other.pdf");
    expect(result).toBeNull();
  });

  it("ignores Figure note when prefix is present but key does not match directory", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/smith2024/Figure解读_other.md");
    expect(result).toBeNull();
  });

  it("ignores MOC files", () => {
    const result = classifyOpenedFile(ROOT, "05 Literature/MOCs/Biology.md");
    expect(result).toBeNull();
  });

  it("ignores files outside literature root", () => {
    const result = classifyOpenedFile(ROOT, "Notes/smith2024/smith2024.pdf");
    expect(result).toBeNull();
  });

  it("handles trailing and leading slashes in literatureRoot cleanly", () => {
    expect(classifyOpenedFile("/05 Literature/", "05 Literature/paper1/paper1.pdf")).toEqual({
      key: "paper1",
      kind: "pdf",
    });
    expect(classifyOpenedFile("05 Literature", "05 Literature/paper1/paper1.pdf")).toEqual({
      key: "paper1",
      kind: "pdf",
    });
  });

  it("returns null on empty or non-string paths", () => {
    expect(classifyOpenedFile(ROOT, "")).toBeNull();
    expect(classifyOpenedFile(ROOT, undefined as unknown as string)).toBeNull();
  });
});

describe("R2 Recent Activity - Store Unit Tests", () => {
  it("records reading events and deduplicates same paper keeping latest timestamp", async () => {
    const store = new RecentActivityStore();

    await store.recordRead({
      key: "paperA",
      path: "05 Literature/paperA/paperA.md",
      timestamp: 1000,
      kind: "pdf",
    });
    expect(store.readCount).toBe(1);

    await store.recordRead({
      key: "paperB",
      path: "05 Literature/paperB/paperB.md",
      timestamp: 2000,
      kind: "figure",
    });
    expect(store.readCount).toBe(2);

    // Reading paperA again with later timestamp should deduplicate and promote it
    await store.recordRead({
      key: "paperA",
      path: "05 Literature/paperA/paperA.md",
      timestamp: 3000,
      kind: "figure",
    });
    expect(store.readCount).toBe(2);

    const reads = store.getRecentReads(10);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toEqual({
      key: "paperA",
      path: "05 Literature/paperA/paperA.md",
      timestamp: 3000,
      kind: "figure",
    });
    expect(reads[1]).toEqual({
      key: "paperB",
      path: "05 Literature/paperB/paperB.md",
      timestamp: 2000,
      kind: "figure",
    });
  });

  it("orders records by timestamp descending regardless of insertion order", async () => {
    const store = new RecentActivityStore();

    await store.recordRead({ key: "p1", path: "path1", timestamp: 100 });
    await store.recordRead({ key: "p3", path: "path3", timestamp: 300 });
    await store.recordRead({ key: "p2", path: "path2", timestamp: 200 });

    const reads = store.getRecentReads(5);
    expect(reads.map((r) => r.key)).toEqual(["p3", "p2", "p1"]);
  });

  it("enforces capacity cap when records exceed limit", async () => {
    const store = new RecentActivityStore({ maxCapacity: 3 });

    await store.recordRead({ key: "p1", path: "path1", timestamp: 100 });
    await store.recordRead({ key: "p2", path: "path2", timestamp: 200 });
    await store.recordRead({ key: "p3", path: "path3", timestamp: 300 });
    await store.recordRead({ key: "p4", path: "path4", timestamp: 400 });

    expect(store.readCount).toBe(3);
    const reads = store.getRecentReads(10);
    expect(reads.map((r) => r.key)).toEqual(["p4", "p3", "p2"]);
    expect(reads.some((r) => r.key === "p1")).toBe(false);
  });

  it("supports persistence roundtrip via storage bridge", async () => {
    const bridge = new MemoryStorageBridge();
    const store1 = new RecentActivityStore({ bridge });

    await store1.recordRead({
      key: "paper1",
      path: "05 Literature/paper1/paper1.md",
      timestamp: 1000,
      kind: "pdf",
    });
    await store1.recordImport({
      key: "paper2",
      path: "05 Literature/paper2/paper2.md",
      createdAt: "2026-09-08T10:00:00Z",
      timestamp: Date.parse("2026-09-08T10:00:00Z"),
    });

    expect(bridge.saveCalls).toBe(2);

    // Create a new store instance with the same bridge and load
    const store2 = new RecentActivityStore({ bridge });
    await store2.load();

    expect(store2.readCount).toBe(1);
    expect(store2.importCount).toBe(1);

    const reads = store2.getRecentReads();
    expect(reads[0].key).toBe("paper1");
    expect(reads[0].kind).toBe("pdf");

    const imports = store2.getRecentImports();
    expect(imports[0].key).toBe("paper2");
    expect(imports[0].createdAt).toBe("2026-09-08T10:00:00Z");
  });

  it("gracefully tolerates corrupted, malformed, or missing data on deserialize", () => {
    expect(deserializeRecentActivity(null)).toEqual({
      version: 1,
      reads: [],
      imports: [],
    });
    expect(deserializeRecentActivity(undefined)).toEqual({
      version: 1,
      reads: [],
      imports: [],
    });
    expect(deserializeRecentActivity("not-json-at-all")).toEqual({
      version: 1,
      reads: [],
      imports: [],
    });
    expect(deserializeRecentActivity(12345)).toEqual({
      version: 1,
      reads: [],
      imports: [],
    });

    // Object with corrupt reads array
    const corruptObject = {
      reads: [
        null,
        "string",
        { key: "", path: "p" }, // empty key
        { key: "k", path: "" }, // empty path
        { key: "k", path: "p", timestamp: "not-a-number" }, // invalid timestamp
        { key: "valid1", path: "p1", timestamp: 100 },
        { key: "valid1", path: "p1", timestamp: 200 }, // duplicate key: keeps higher timestamp 200
      ],
      imports: [
        { key: "imp1", path: "p", createdAt: "invalid-date" }, // invalid date
        { key: "imp2", path: "p", createdAt: "2026-09-09T00:00:00Z" },
      ],
    };

    const parsed = deserializeRecentActivity(corruptObject);
    expect(parsed.reads).toHaveLength(1);
    expect(parsed.reads[0]).toEqual({
      key: "valid1",
      path: "p1",
      timestamp: 200,
      kind: undefined,
    });

    expect(parsed.imports).toHaveLength(1);
    expect(parsed.imports[0].key).toBe("imp2");
  });

  it("tolerates legacy data formats (e.g. raw array of reads)", () => {
    const legacyArray = [
      { key: "legacy1", path: "path1", timestamp: 500, kind: "pdf" },
      { key: "legacy2", path: "path2", timestamp: 800 },
    ];
    const parsed = deserializeRecentActivity(legacyArray);
    expect(parsed.reads).toHaveLength(2);
    expect(parsed.reads[0].key).toBe("legacy2");
    expect(parsed.reads[1].key).toBe("legacy1");
    expect(parsed.imports).toHaveLength(0);
  });
});

describe("R2 Recent Activity - Recent Imports Logic (Contract 5)", () => {
  it("sorts by real created_at descending and excludes historical papers without created_at", () => {
    const store = new RecentActivityStore();

    const records: PaperRecord[] = [
      makePaperRecord("paperEarly", { createdAt: "2026-08-01T12:00:00Z" }),
      makePaperRecord("paperHistorical", { createdAt: undefined }), // No created_at!
      makePaperRecord("paperLate", { createdAt: "2026-08-03T18:00:00Z" }),
      makePaperRecord("paperMid", { createdAt: "2026-08-02T10:00:00Z" }),
    ];

    const imports = store.getRecentImports(10, records);

    expect(imports).toHaveLength(3);
    // Real created_at sort: late -> mid -> early
    expect(imports[0].key).toBe("paperLate");
    expect(imports[1].key).toBe("paperMid");
    expect(imports[2].key).toBe("paperEarly");

    // Historical paper MUST NOT appear
    expect(imports.some((i) => i.key === "paperHistorical")).toBe(false);
  });

  it("does not infer import time from file modification time or order", () => {
    const store = new RecentActivityStore();

    // 2 papers with explicit created_at, 1 without
    const records: PaperRecord[] = [
      makePaperRecord("firstInArray", { createdAt: undefined }),
      makePaperRecord("secondInArray", { createdAt: "2026-09-01T00:00:00Z" }),
    ];

    const imports = store.getRecentImports(10, records);
    expect(imports).toHaveLength(1);
    expect(imports[0].key).toBe("secondInArray");
  });

  it("filters out deleted papers from recent reads and imports when records are supplied", async () => {
    const store = new RecentActivityStore();

    await store.recordRead({
      key: "paperActive",
      path: "05 Literature/paperActive/paperActive.md",
      timestamp: 1000,
    });
    await store.recordRead({
      key: "paperDeleted",
      path: "05 Literature/paperDeleted/paperDeleted.md",
      timestamp: 2000,
    });

    const activeRecords = [makePaperRecord("paperActive")];

    const reads = store.getRecentReads(10, activeRecords);
    expect(reads).toHaveLength(1);
    expect(reads[0].key).toBe("paperActive");
    expect(reads.some((r) => r.key === "paperDeleted")).toBe(false);
  });
});

describe("R2 Recent Activity - Concurrency (Contract 7)", () => {
  it("serializes concurrent writes so rapid consecutive reads are not lost", async () => {
    const bridge = new MemoryStorageBridge();
    bridge.delayMs = 25; // Simulate I/O latency

    const store = new RecentActivityStore({ bridge });

    // Fire two recordRead calls almost simultaneously
    const p1 = store.recordRead({
      key: "paperOne",
      path: "05 Literature/paperOne/paperOne.md",
      timestamp: 1000,
      kind: "pdf",
    });
    const p2 = store.recordRead({
      key: "paperTwo",
      path: "05 Literature/paperTwo/paperTwo.md",
      timestamp: 2000,
      kind: "figure",
    });

    await Promise.all([p1, p2]);

    // Inspect persisted data in bridge
    const rawSaved = bridge.data.recentActivity as RecentActivityData;
    expect(rawSaved).toBeDefined();
    expect(rawSaved.reads).toHaveLength(2);
    expect(rawSaved.reads.map((r) => r.key)).toContain("paperOne");
    expect(rawSaved.reads.map((r) => r.key)).toContain("paperTwo");
  });
});

describe("R2 Recent Activity - Plugin Lifecycle & File-Open Events", () => {
  function createMockApp(options?: {
    layoutReady?: boolean;
    onLayoutReady?: (cb: () => void) => void;
  }): {
    app: App;
    listeners: Map<string, Array<(data: unknown) => void>>;
    trigger: (event: string, data: unknown) => void;
  } {
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const trigger = (event: string, data: unknown) => {
      const list = listeners.get(event) ?? [];
      for (const cb of list) {
        cb(data);
      }
    };

    const app = {
      workspace: {
        layoutReady: options?.layoutReady ?? true,
        onLayoutReady: options?.onLayoutReady ?? ((cb: () => void) => cb()),
        on: vi.fn((event: string, callback: (data: unknown) => void) => {
          const list = listeners.get(event) ?? [];
          list.push(callback);
          listeners.set(event, list);
          return { event, callback };
        }),
      },
    } as unknown as App;

    return { app, listeners, trigger };
  }

  it("records read when Primary PDF is opened in workspace", async () => {
    resetRegistries();
    const { app, trigger } = createMockApp();
    const plugin = new PaperNotesPlugin(app, { id: "paper-notes" } as PluginManifest);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.onload();

    trigger("file-open", { path: "05 Literature/alpha2024/alpha2024.pdf" });

    const store = plugin.getRecentActivityStore();
    expect(store).toBeDefined();
    expect(store?.readCount).toBe(1);

    const reads = plugin.getRecentReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].key).toBe("alpha2024");
    expect(reads[0].kind).toBe("pdf");
  });

  it("records read when Figure note is opened in workspace", async () => {
    resetRegistries();
    const { app, trigger } = createMockApp();
    const plugin = new PaperNotesPlugin(app, { id: "paper-notes" } as PluginManifest);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.onload();

    trigger("file-open", { path: "05 Literature/beta2024/Figure解读_beta2024.md" });

    const store = plugin.getRecentActivityStore();
    expect(store?.readCount).toBe(1);
    const reads = plugin.getRecentReads();
    expect(reads[0].key).toBe("beta2024");
    expect(reads[0].kind).toBe("figure");
  });

  it("ignores startup and layout-restore file-open events before layoutReady", async () => {
    resetRegistries();
    let onLayoutReadyCallback: (() => void) | undefined;
    const { app, trigger } = createMockApp({
      layoutReady: false,
      onLayoutReady: (cb) => {
        onLayoutReadyCallback = cb;
      },
    });

    const plugin = new PaperNotesPlugin(app, { id: "paper-notes" } as PluginManifest);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.onload();

    // 1. File open occurs during startup layout restoration (layoutReady is false)
    trigger("file-open", { path: "05 Literature/startup2024/startup2024.pdf" });

    const store = plugin.getRecentActivityStore();
    expect(store?.readCount).toBe(0); // MUST NOT record!

    // 2. Layout becomes ready
    expect(onLayoutReadyCallback).toBeDefined();
    onLayoutReadyCallback!();

    // 3. Subsequent user file-open interaction occurs
    trigger("file-open", { path: "05 Literature/user2024/user2024.pdf" });

    expect(store?.readCount).toBe(1);
    expect(plugin.getRecentReads()[0].key).toBe("user2024");
  });

  it("registers file-open listener via registerEvent for automatic detachment on unload", async () => {
    resetRegistries();
    const { app } = createMockApp();
    const plugin = new PaperNotesPlugin(app, { id: "paper-notes" } as PluginManifest);

    await plugin.onload();

    // Verify that registerEvent recorded the file-open event ref
    expect(registeredEvents.length).toBeGreaterThan(0);
    const fileOpenRef = registeredEvents.find(
      (ref) => typeof ref === "object" && ref !== null && (ref as { event?: string }).event === "file-open",
    );
    expect(fileOpenRef).toBeDefined();

    // Unload plugin
    await plugin.onunload();
    expect(plugin.getRecentActivityStore()).toBeUndefined();
  });
});
