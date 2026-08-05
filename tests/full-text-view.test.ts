/**
 * On-demand MinerU full-text search in the Library view (Repair: Task 23 R7).
 *
 * Gate D found that `LibraryIndex.searchFullText` (MinerU full text) was
 * dead code: the view search box only ran the synchronous metadata filter
 * (`searchLibraryItems`), so terms that exist only inside
 * `minerUmd_<key>.md` (e.g. "gene expression program" in xia) never
 * matched. Per design spec §9.4 MinerU full text is searched only through
 * an explicit on-demand mode:
 *
 * - the synchronous metadata filter keeps rendering immediately,
 * - a debounced (~300ms) async full-text search runs afterwards,
 * - full-text hits are appended to the metadata results (deduplicated),
 * - stale requests are cancelled via AbortController and late results for
 *   an older query are dropped,
 * - failures silently fall back to the metadata results (no crash), and
 * - a lightweight "Searching MinerU full text…" status appears while an
 *   on-demand search is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import {
  LibraryIndex,
  SearchCancelledError,
  VaultFileNotFoundError,
  type LiteratureVaultAdapter,
} from "../src/services/library-index";
import type { PaperRecord } from "../src/types/paper";

const ROOT = "05 Literature";

const state = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  notices: [] as string[],
}));

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
    style: Record<string, string> = {};
    children: El[] = [];
    listeners: Record<string, (event?: unknown) => void> = {};

    constructor(tag: string) {
      this.tag = tag;
    }

    addEventListener(type: string, fn: (event?: unknown) => void): void {
      this.listeners[type] = fn;
    }

    addClass(cls: string): void {
      if (cls.length > 0 && !this.cls.split(/\s+/).includes(cls)) {
        this.cls = this.cls.length > 0 ? `${this.cls} ${cls}` : cls;
      }
    }
    removeClass(_cls: string): void {}
    toggleClass(_cls: string, _on?: boolean): void {}

    empty(): void {
      this.children = [];
    }

    createEl(tag: string, opts: ElOpts = {}): El {
      const el = new El(tag);
      el.cls = opts.cls ?? "";
      el.textContent = opts.text ?? "";
      if (typeof opts.value === "string") {
        el.value = opts.value;
      }
      this.children.push(el);
      return el;
    }

    createDiv(opts: ElOpts = {}): El {
      return this.createEl("div", opts);
    }
  }

  class ItemView {
    leaf: unknown;
    app: Record<string, unknown>;
    containerEl: El;

    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.app = state.app;
      this.containerEl = new El("div");
    }

    /** Mirrors the real Obsidian runtime `View.open()` called by the workspace. */
    open(): void {}
  }

  class WorkspaceLeaf {}

  class Notice {
    constructor(message: string) {
      state.notices.push(message);
    }
  }

  return { ItemView, WorkspaceLeaf, Notice };
});

const XIA_PATH = `${ROOT}/xia2024/xia2024.md`;
const OSBORNE_PATH = `${ROOT}/osborne2023/osborne2023.md`;

function makeRecord(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    path: XIA_PATH,
    key: "xia2024",
    paperId: "550e8400-e29b-41d4-a716-446655440001",
    title: "Single-cell atlas of lung tumor states",
    authors: [{ family: "Xia", given: "Li" }],
    journal: "Cell",
    year: 2024,
    identifiers: {},
    citationKeyAliases: [],
    titleAliases: [],
    abstract: "",
    ...overrides,
  };
}

const xiaRecord = makeRecord();
const osborneRecord = makeRecord({
  path: OSBORNE_PATH,
  key: "osborne2023",
  paperId: "550e8400-e29b-41d4-a716-446655440002",
  title: "JAK1-mediated signaling in macrophages",
  authors: [{ family: "Osborne", given: "Ava" }],
  journal: "Immunity",
  year: 2023,
});

/** Minimal valid frontmatter mirroring what the index expects. */
function frontmatterOf(record: PaperRecord): Record<string, unknown> {
  return {
    schema_version: 1,
    citation_key: record.key,
    paper_id: record.paperId,
    title: record.title,
    authors: record.authors,
    journal: record.journal,
    year: record.year,
  };
}

/**
 * A view source backed by the REAL LibraryIndex over a recording adapter:
 * full-text results come from the production search path, and every MinerU
 * read is recorded so tests can assert exactly what was (not) read.
 */
function realIndexSource(
  records: PaperRecord[],
  minerU: Map<string, string>,
  readCalls: string[],
): LibraryViewSource {
  const files = new Set<string>();
  const frontmatter = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    files.add(record.path);
    frontmatter.set(record.path, frontmatterOf(record));
  }
  const adapter: LiteratureVaultAdapter = {
    listMarkdownFiles: () => [...files],
    getFrontmatter: (path: string) => frontmatter.get(path),
    readText: async (path: string, signal?: AbortSignal) => {
      readCalls.push(path);
      if (signal?.aborted) {
        throw new SearchCancelledError();
      }
      const content = minerU.get(path);
      if (content === undefined) {
        throw new VaultFileNotFoundError(path);
      }
      return content;
    },
  };
  const index = new LibraryIndex(adapter, ROOT);
  index.scanAll();
  return {
    getRecords: () => index.getRecords(),
    getInvalidRecords: () => index.getInvalidRecords(),
    getFrontmatter: () => undefined,
    listDirectory: () => [],
    getCards: () => [],
    searchFullText: (query: string, signal?: AbortSignal) =>
      index.searchFullText(query, { signal }),
  };
}

/** A view source with a controllable full-text implementation. */
function makeSource(
  records: PaperRecord[],
  searchFullText?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<PaperRecord[]>,
): LibraryViewSource {
  return {
    getRecords: () => records,
    getInvalidRecords: () => [],
    getFrontmatter: () => undefined,
    listDirectory: () => [],
    getCards: () => [],
    searchFullText,
  };
}

async function openView(source: LibraryViewSource): Promise<PaperNotesLibraryView> {
  const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
  await view.onOpen();
  return view;
}

/** Minimal structural view of the recording element tree. */
interface ElLike {
  tag: string;
  cls: string;
  textContent: string;
  value: string;
  children: ElLike[];
  listeners: Record<string, (event?: unknown) => void>;
}

function findByClass(root: ElLike, cls: string): ElLike[] {
  const found: ElLike[] = [];
  const walk = (node: ElLike): void => {
    if (node.cls === cls) {
      found.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** Body data rows of the (first) results table, as joined cell text.
 * The empty-state placeholder row is not a data row. */
function tableRowsOf(root: ElLike): string[] {
  const tables = findByClass(root, "paper-notes-library-table");
  if (tables.length === 0) {
    return [];
  }
  const tbody = tables[0].children.find((child) => child.tag === "tbody");
  if (tbody === undefined) {
    return [];
  }
  return tbody.children
    .filter(
      (row) =>
        !row.children.some(
          (cell) => cell.cls === "paper-notes-library-empty",
        ),
    )
    .map((row) =>
      row.children.map((cell) => cell.textContent).join(" | "),
    );
}

/** Type into the toolbar search box and fire the input event. */
function typeQuery(view: PaperNotesLibraryView, query: string): void {
  const box = findByClass(
    view.containerEl as unknown as ElLike,
    "paper-notes-library-search",
  )[0];
  box.value = query;
  box.listeners["input"]?.(undefined);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("on-demand MinerU full-text search in the library view", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.app = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders metadata hits synchronously and never reads MinerU for them", async () => {
    const readCalls: string[] = [];
    const source = realIndexSource(
      [osborneRecord, xiaRecord],
      new Map(),
      readCalls,
    );
    const view = await openView(source);

    typeQuery(view, "JAK1");
    // The synchronous metadata filter already shows the row — no debounce
    // needed for a plain metadata hit (JAK1 lives in the osborne title).
    let rows = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("JAK1-mediated signaling in macrophages");

    await vi.advanceTimersByTimeAsync(300);
    rows = tableRowsOf(view.containerEl as unknown as ElLike);
    // The full-text pass must not duplicate the metadata hit.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("JAK1-mediated signaling in macrophages");
    // searchFullText skips MinerU reads for records already matched by
    // default fields: the osborne MinerU note is never read.
    expect(readCalls).not.toContain(
      `${ROOT}/osborne2023/minerUmd_osborne2023.md`,
    );
  });

  it("searches MinerU full text on demand and appends full-text hits", async () => {
    const readCalls: string[] = [];
    const minerU = new Map<string, string>([
      [
        `${ROOT}/xia2024/minerUmd_xia2024.md`,
        "Gene-expression programs shape the tumor microenvironment.",
      ],
    ]);
    const source = realIndexSource([osborneRecord, xiaRecord], minerU, readCalls);
    const view = await openView(source);

    // "gene expression program" never appears in any record metadata:
    // the synchronous pass renders nothing.
    typeQuery(view, "gene expression program");
    expect(
      tableRowsOf(view.containerEl as unknown as ElLike),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300);
    const rows = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Single-cell atlas of lung tumor states");
    // Both records missed the metadata pass, so both MinerU notes were
    // probed; xia's note held the token AND hit.
    expect(readCalls).toContain(`${ROOT}/xia2024/minerUmd_xia2024.md`);
    expect(readCalls).toContain(
      `${ROOT}/osborne2023/minerUmd_osborne2023.md`,
    );
  });

  it("keeps the empty state when neither metadata nor full text matches", async () => {
    const source = realIndexSource(
      [osborneRecord, xiaRecord],
      new Map(),
      [],
    );
    const view = await openView(source);

    typeQuery(view, "zzzz");
    await vi.advanceTimersByTimeAsync(300);

    const rows = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(rows).toHaveLength(0);
    const empty = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-empty",
    );
    expect(
      empty.some((el) => el.textContent.includes("No papers match")),
    ).toBe(true);
  });

  it("debounces rapid queries into a single full-text search", async () => {
    const calls: string[] = [];
    const source = makeSource(
      [osborneRecord, xiaRecord],
      async (query: string) => {
        calls.push(query);
        return [];
      },
    );
    const view = await openView(source);

    typeQuery(view, "gene");
    await vi.advanceTimersByTimeAsync(100);
    typeQuery(view, "gene expression");
    await vi.advanceTimersByTimeAsync(100);
    typeQuery(view, "gene expression program");
    await vi.advanceTimersByTimeAsync(300);

    // Only the trailing query triggers an on-demand full-text search.
    expect(calls).toEqual(["gene expression program"]);
  });

  it("cancels stale full-text requests; late old results never overwrite new ones", async () => {
    const calls: Array<{ query: string; signal?: AbortSignal }> = [];
    const pendingAlpha = deferred<PaperRecord[]>();
    const source = makeSource([osborneRecord, xiaRecord], (query, signal) => {
      calls.push({ query, signal });
      if (query === "alpha") {
        return pendingAlpha.promise;
      }
      return Promise.resolve([xiaRecord]);
    });
    const view = await openView(source);

    typeQuery(view, "alpha");
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
    const firstSignal = calls[0].signal!;
    // The in-flight full-text search shows the lightweight status line.
    expect(
      findByClass(
        view.containerEl as unknown as ElLike,
        "paper-notes-library-fulltext-status",
      ),
    ).toHaveLength(1);

    typeQuery(view, "beta");
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(2);
    // The stale request was cancelled when the new query was typed.
    expect(firstSignal.aborted).toBe(true);

    const rows = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Single-cell atlas of lung tumor states");
    expect(
      findByClass(
        view.containerEl as unknown as ElLike,
        "paper-notes-library-fulltext-status",
      ),
    ).toHaveLength(0);

    // Even if the stale request settles late, its result is dropped.
    pendingAlpha.resolve([osborneRecord]);
    await vi.advanceTimersByTimeAsync(0);
    const after = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("Single-cell atlas of lung tumor states");
    expect(after[0]).not.toContain("JAK1");
  });

  it("silently falls back to metadata results when full-text search fails", async () => {
    const source = makeSource([osborneRecord, xiaRecord], async () => {
      throw new Error("vault read exploded");
    });
    const view = await openView(source);

    typeQuery(view, "JAK1");
    expect(
      tableRowsOf(view.containerEl as unknown as ElLike),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300);
    // The failure is swallowed: metadata rows stay, no status residue, no crash.
    const rows = tableRowsOf(view.containerEl as unknown as ElLike);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("JAK1-mediated signaling in macrophages");
    expect(
      findByClass(
        view.containerEl as unknown as ElLike,
        "paper-notes-library-fulltext-status",
      ),
    ).toHaveLength(0);
  });

  it("clears a pending full-text search and restores all rows when emptied", async () => {
    const calls: string[] = [];
    const source = makeSource(
      [osborneRecord, xiaRecord],
      async (query: string) => {
        calls.push(query);
        return [];
      },
    );
    const view = await openView(source);

    typeQuery(view, "gene");
    await vi.advanceTimersByTimeAsync(100);
    typeQuery(view, "");
    await vi.advanceTimersByTimeAsync(300);

    // The pending debounce was cancelled before it fired.
    expect(calls).toHaveLength(0);
    // An empty query is the identity filter: every record shows again.
    expect(
      tableRowsOf(view.containerEl as unknown as ElLike),
    ).toHaveLength(2);
  });

  it("degrades to metadata-only search when the source has no full-text bridge", async () => {
    const source: LibraryViewSource = {
      getRecords: () => [osborneRecord],
      getInvalidRecords: () => [],
      getFrontmatter: () => undefined,
      listDirectory: () => [],
      getCards: () => [],
    };
    const view = await openView(source);

    typeQuery(view, "JAK1");
    expect(
      tableRowsOf(view.containerEl as unknown as ElLike),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(
      tableRowsOf(view.containerEl as unknown as ElLike),
    ).toHaveLength(1);
  });
});

describe("notify path (Repair: Gate D R8 — static Notice import)", () => {
  beforeEach(() => {
    state.app = {};
    state.notices.length = 0;
  });

  it("surfaces a visible Notice when the CLI-backed actions are unavailable", async () => {
    // The view source has no plugin bridge, so `getActions()` resolves to
    // undefined and the create action must fall back to a Notice instead of
    // silently no-oping. `notify()` uses the statically imported `Notice`
    // (a dynamic `import("obsidian")` would fail in the CJS bundle).
    const view = await openView(makeSource([xiaRecord]));
    const create = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-create",
    )[0];
    expect(create).toBeDefined();
    create.listeners["click"]?.(undefined);

    expect(state.notices).toContain(
      "paper-notes CLI unavailable; the library is read-only.",
    );
  });
});
