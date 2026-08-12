/**
 * Literature Library shell + row activation (ux-interaction):
 * two-level filters, full-width table, Detail Drawer on single-click
 * (after a short click/dblclick delay), Primary PDF on double-click,
 * clickable reading chips, Open Folder in the drawer action bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import type { PaperRecord } from "../src/types/paper";

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
    scrollLeft = 0;
    scrollTop = 0;
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
const NOTE_PATH_B = "05 Literature/beta2025/beta2025.md";

function makeRecord(title = "Alpha cells", year = 2024, path = NOTE_PATH): PaperRecord {
  return {
    path,
    key: path.includes("beta") ? "beta2025" : "alpha2024",
    paperId: `550e8400-e29b-41d4-a716-${path.includes("beta") ? "446655440001" : "446655440000"}`,
    title,
    authors: [{ family: "Shiau", given: "Wen" }],
    journal: "Nature Methods",
    year,
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
  clientWidth?: number;
  scrollLeft?: number;
  scrollTop?: number;
  getAttribute?: (name: string) => string | null;
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

function dblclickRow(row: ElLike): void {
  row.listeners["dblclick"]?.({ preventDefault() {} });
}

function clickRow(row: ElLike): void {
  row.listeners["click"]?.({});
}

/** Advance past the row single-click → drawer delay (280ms). */
async function flushRowClickDelay(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
}

/** Single-click a row and wait for the Detail Drawer to open. */
async function openDrawerViaClick(
  view: PaperNotesLibraryView,
  rowIndex = 0,
): Promise<void> {
  clickRow(rowsOf(view)[rowIndex]);
  await flushRowClickDelay();
}

/** The open drawer panel (after single-click), scoped for section asserts. */
function drawerPanel(view: PaperNotesLibraryView): ElLike {
  const root = view.containerEl as unknown as ElLike;
  return findByClass(root, "paper-notes-library-drawer-panel")[0];
}

/** First chip whose class tokens include the base chip class. */
function findStatusChips(root: ElLike): ElLike[] {
  const found: ElLike[] = [];
  const walk = (node: ElLike): void => {
    const tokens = node.cls.split(/\s+/).filter(Boolean);
    if (tokens.includes("paper-notes-status-chip")) {
      found.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

function collectTexts(root: ElLike): string[] {
  const out: string[] = [];
  const walk = (node: ElLike): void => {
    if (node.textContent.length > 0) {
      out.push(node.textContent);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Install a fake CLI bridge so the drawer renders real action buttons. */
function installCliBridge(view: PaperNotesLibraryView): void {
  (view as unknown as { app: unknown }).app = {
    vault: { adapter: { getBasePath: () => "/vault" } },
    plugins: {
      plugins: {
        "paper-notes": {
          getCliClient: () => ({}),
          settings: {},
        },
      },
    },
  };
}

/** Minimal window stub so the drawer's Esc handler can be exercised. */
let windowListeners: Record<string, (event: unknown) => void> = {};
function installWindowStub(): void {
  windowListeners = {};
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      windowListeners[type] = fn;
    },
    removeEventListener: (type: string) => {
      delete windowListeners[type];
    },
  };
}
function uninstallWindowStub(): void {
  delete (globalThis as Record<string, unknown>).window;
}
function pressEscape(): void {
  windowListeners["keydown"]?.({ key: "Escape", preventDefault() {} });
}

/** Minimal document stub so the column-drag pointer handlers can run. */
let docListeners: Record<string, (event: unknown) => void> = {};
function installDocumentStub(): void {
  docListeners = {};
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      docListeners[type] = fn;
    },
    removeEventListener: (type: string) => {
      delete docListeners[type];
    },
  };
}
function uninstallDocumentStub(): void {
  delete (globalThis as Record<string, unknown>).document;
}

/** Header cells (th elements) of the rendered table, in column order. */
function headerCells(view: PaperNotesLibraryView): ElLike[] {
  const root = view.containerEl as unknown as ElLike;
  const table = findByClass(root, "paper-notes-library-table")[0];
  const thead = table.children.find((child) => child.tag === "thead");
  const headerRow = thead?.children.find((child) => child.tag === "tr");
  return headerRow === undefined ? [] : headerRow.children;
}

/** The right-edge resize handle child of a header cell. */
function resizeHandleOf(th: ElLike): ElLike {
  const handle = th.children.find((child) =>
    child.cls.split(/\s+/).includes("paper-notes-col-resize-handle"),
  );
  if (handle === undefined) {
    throw new Error("no resize handle on header cell");
  }
  return handle;
}

/** App stub with a recording saveData; loadData returns a fixed payload. */
function installBridgeWithPersistence(
  view: PaperNotesLibraryView,
  saved: unknown[],
  settings: Record<string, unknown> = {},
  loaded: Record<string, unknown> = {},
): void {
  (view as unknown as { app: unknown }).app = {
    vault: { adapter: { getBasePath: () => "/vault" } },
    plugins: {
      plugins: {
        "paper-notes": {
          getCliClient: () => ({}),
          settings,
          loadData: async () => loaded,
          saveData: async (data: unknown) => {
            saved.push(data);
          },
        },
      },
    },
  };
}

describe("Batch 1 library shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNotices.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a full-width table with no splitter and no resident detail host", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-splitter")).toHaveLength(0);
    expect(findByClass(root, "paper-notes-library-detail-host")).toHaveLength(0);
    expect(findByClass(root, "paper-notes-library-table")).toHaveLength(1);
    expect(findByClass(root, "paper-notes-library-drawer-host")).toHaveLength(1);
    // Drawer host starts hidden and empty — the table is the only surface.
    const drawerHost = findByClass(root, "paper-notes-library-drawer-host")[0];
    expect(drawerHost.cls).toContain("is-hidden");
    expect(drawerHost.children).toHaveLength(0);
    expect(findByClass(root, "paper-notes-library-advanced-toggle")).toHaveLength(
      1,
    );
    expect(
      findByClass(root, "paper-notes-library-filters-advanced"),
    ).toHaveLength(0);
  });

  it("collapses Advanced by default when no advanced conditions are active", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    const root = view.containerEl as unknown as ElLike;
    expect(
      findByClass(root, "paper-notes-library-filters-advanced"),
    ).toHaveLength(0);
    expect(
      findByClass(root, "paper-notes-library-advanced-toggle")[0]?.textContent,
    ).toBe("Advanced ▸");
  });

  it("expands Advanced on toggle", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    const root = view.containerEl as unknown as ElLike;
    const toggle = findByClass(root, "paper-notes-library-advanced-toggle")[0];
    toggle.listeners["click"]?.(undefined);
    const root2 = view.containerEl as unknown as ElLike;
    expect(
      findByClass(root2, "paper-notes-library-filters-advanced"),
    ).toHaveLength(1);
  });

  it("selects the row immediately on single click and opens the drawer after delay", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    clickRow(rowsOf(view)[0]);
    // Before the delay elapses: selected, drawer still closed.
    expect(rowsOf(view)[0].cls).toContain("selected");
    let root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);
    await flushRowClickDelay();
    root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
  });

  it("opens the detail drawer on single-click at any leaf width", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    (view.containerEl as unknown as { clientWidth: number }).clientWidth = 1000;
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
    expect(
      findByClass(root, "paper-notes-library-drawer-title")[0]?.textContent,
    ).toBe("Details");
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
  });

  it("drawer shows the flat detail table for the selected record", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const detail = findByClass(root, "paper-notes-library-detail")[0];
    expect(detail).toBeDefined();
    expect(detail.children.length).toBeGreaterThan(0);
  });

  it("single-clicking a different row swaps the drawer content", async () => {
    const view = new PaperNotesLibraryView(
      {} as WorkspaceLeaf,
      makeSource([makeRecord("Alpha cells", 2024), makeRecord("Beta cells", 2025, NOTE_PATH_B)]),
    );
    await view.onOpen();
    const rows = rowsOf(view);
    expect(rows).toHaveLength(2);
    await openDrawerViaClick(view, 0); // newest first (year desc) → Beta cells
    let root = view.containerEl as unknown as ElLike;
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Beta cells");
    await openDrawerViaClick(view, 1);
    root = view.containerEl as unknown as ElLike;
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
  });

  it("double-click opens Primary PDF only and cancels the pending drawer", async () => {
    const opened: string[] = [];
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    (view as unknown as { app: unknown }).app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
        getAbstractFileByPath: (path: string) =>
          path.endsWith(".pdf") ? { path } : null,
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: { path: string }) => {
            opened.push(file.path);
          },
        }),
      },
      plugins: undefined,
    };
    await view.onOpen();
    // Browser sequence: click then dblclick; the timer must be cancelled.
    clickRow(rowsOf(view)[0]);
    dblclickRow(rowsOf(view)[0]);
    await flushRowClickDelay();
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);
    expect(opened).toEqual(["05 Literature/alpha2024/alpha2024.pdf"]);
    expect(mockNotices).toHaveLength(0);
  });

  it("double-click with no PDF shows a Notice and opens neither drawer nor figure", async () => {
    const opened: string[] = [];
    const source = makeSource();
    source.listDirectory = () => []; // no PDF basenames
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
    (view as unknown as { app: unknown }).app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
        getAbstractFileByPath: () => null,
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: { path: string }) => {
            opened.push(file.path);
          },
        }),
      },
      plugins: undefined,
    };
    await view.onOpen();
    clickRow(rowsOf(view)[0]);
    dblclickRow(rowsOf(view)[0]);
    await flushRowClickDelay();
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(mockNotices.some((n) => /Primary PDF not found/i.test(n))).toBe(true);
  });

  it("closes the drawer via its Close button", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    let root = view.containerEl as unknown as ElLike;
    const close = findByClass(root, "paper-notes-library-drawer-close")[0];
    close.listeners["click"]?.(undefined);
    root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);
  });

  it("closes the drawer on backdrop click", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    let root = view.containerEl as unknown as ElLike;
    const backdrop = findByClass(root, "paper-notes-library-drawer-backdrop")[0];
    backdrop.listeners["click"]?.(undefined);
    root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);
  });

  it("closes the drawer on Escape", async () => {
    installWindowStub();
    try {
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
      await view.onOpen();
      await openDrawerViaClick(view);
      let root = view.containerEl as unknown as ElLike;
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(
        1,
      );
      pressEscape();
      root = view.containerEl as unknown as ElLike;
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(
        0,
      );
    } finally {
      uninstallWindowStub();
    }
  });

  it("keeps an open drawer when a single click re-renders the table", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    clickRow(rowsOf(view)[0]); // re-selects; pending timer re-opens after delay
    await flushRowClickDelay();
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
  });

  it("swaps the open drawer to the newly selected row without a second click", async () => {
    const view = new PaperNotesLibraryView(
      {} as WorkspaceLeaf,
      makeSource([makeRecord(), makeRecord("Beta cells", 2025, NOTE_PATH_B)]),
    );
    await view.onOpen();
    // Default sort is year descending: open Alpha at row 1, then switch to Beta.
    await openDrawerViaClick(view, 1);
    let root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-detail-title")[0]?.textContent).toBe(
      "Alpha cells",
    );
    const betaRow = rowsOf(view)[0];
    const backdrop = findByClass(root, "paper-notes-library-drawer-backdrop")[0];
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        elementFromPoint: () => ({ closest: () => betaRow }),
      },
    });
    try {
      // The Drawer backdrop receives the browser click before the covered row.
      // It must forward the hit-tested Beta row instead of closing the Drawer.
      backdrop.listeners["click"]?.({ clientX: 32, clientY: 32 });
      await flushRowClickDelay();
      root = view.containerEl as unknown as ElLike;
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
      expect(
        findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
      ).toBe("Beta cells");
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: originalDocument,
        });
      }
    }
  });

  it("preserves table scroll coordinates when re-rendering rows", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    const host = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-table-host",
    )[0];
    host.scrollLeft = 280;
    host.scrollTop = 96;
    clickRow(rowsOf(view)[0]);
    expect(host.scrollLeft).toBe(280);
    expect(host.scrollTop).toBe(96);
  });

  it("preserves an open drawer across a full re-render (filter toggle)", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    const root0 = view.containerEl as unknown as ElLike;
    const toggle = findByClass(root0, "paper-notes-library-advanced-toggle")[0];
    toggle.listeners["click"]?.(undefined); // render() rebuilds the shell
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
    expect(
      findByClass(root, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
  });

  // ── Batch 2 (A): sectioned drawer detail + grouped top action bar ──────

  it("drawer header shows title, key and the reading-status chip", async () => {
    const source = makeSource();
    source.getFrontmatter = () => ({ reading_status: "reading" });
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
    await view.onOpen();
    await openDrawerViaClick(view);
    const panel = drawerPanel(view);
    expect(findByClass(panel, "paper-notes-library-detail-header")).toHaveLength(
      1,
    );
    expect(
      findByClass(panel, "paper-notes-library-detail-title")[0]?.textContent,
    ).toBe("Alpha cells");
    expect(
      findByClass(panel, "paper-notes-library-detail-key")[0]?.textContent,
    ).toBe("alpha2024");
    expect(
      findByClass(panel, "paper-notes-status-chip--reading"),
    ).toHaveLength(1);
  });

  it("renders the detail body in sections with metric badges and attachments", async () => {
    const source = makeSource();
    source.getMetrics = () => ({ if: 8.1, jcr: "Q1", cas: "中科院一区" });
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
    await view.onOpen();
    await openDrawerViaClick(view);
    const panel = drawerPanel(view);
    expect(findByClass(panel, "paper-notes-detail-section")).toHaveLength(4);
    expect(findByClass(panel, "detail-section-bibliography")).toHaveLength(1);
    expect(findByClass(panel, "detail-section-metrics")).toHaveLength(1);
    expect(findByClass(panel, "detail-section-artifacts")).toHaveLength(1);
    expect(findByClass(panel, "detail-section-abstract")).toHaveLength(1);
    const badges = findByClass(panel, "paper-notes-metric-badge");
    expect(badges.map((badge) => badge.textContent)).toEqual(["中科院一区", "Q1", "8.1"]);
    expect(
      findByClass(panel, "paper-notes-metric-badge--if")[0]?.textContent,
    ).toBe("8.1");
    const chips = findByClass(panel, "paper-notes-artifact-chip");
    expect(chips).toHaveLength(3);
    expect(findByClass(panel, "is-present")).toHaveLength(1); // pdf only
  });

  it("renders the grouped action bar with Open Folder and without Reading button", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    installCliBridge(view);
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const bar = findByClass(root, "paper-notes-library-actions-bar")[0];
    expect(bar).toBeDefined();
    expect(findByClass(bar, "actions-open")).toHaveLength(1);
    expect(findByClass(bar, "actions-status")).toHaveLength(1);
    expect(findByClass(bar, "actions-danger")).toHaveLength(1);
    const texts = collectTexts(bar);
    expect(texts).toEqual(
      expect.arrayContaining([
        "Open main",
        "Open PDF",
        "Open Folder",
        "Attach PDF",
        "Rename key",
        "Delete",
      ]),
    );
    expect(texts.some((t) => t.startsWith("Reading:"))).toBe(false);
    expect(findByClass(bar, "paper-notes-library-action-status")).toHaveLength(0);
    // The bar must live OUTSIDE the scrollable body (sibling, not child),
    // so a long abstract can never scroll it away.
    const body = findByClass(root, "paper-notes-library-drawer-body")[0];
    expect(findByClass(body, "paper-notes-library-actions-bar")).toHaveLength(0);
  });

  it("Open Folder reveals the Canonical Paper Directory in the file explorer", async () => {
    const revealed: string[] = [];
    const explorerView = {
      revealInFolder: (file: { path: string }) => {
        revealed.push(file.path);
      },
    };
    const explorerLeaf = {
      view: explorerView,
      setViewState: async () => {},
    };
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    (view as unknown as { app: unknown }).app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
        getAbstractFileByPath: (path: string) =>
          path === "05 Literature/alpha2024" ? { path } : null,
      },
      workspace: {
        getLeavesOfType: (type: string) =>
          type === "file-explorer" ? [explorerLeaf] : [],
        revealLeaf: () => {},
        getLeaf: () => ({ openFile: async () => {} }),
      },
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({}),
            settings: {},
          },
        },
      },
    };
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const bar = findByClass(root, "paper-notes-library-actions-bar")[0];
    const folderBtn = findByClass(bar, "paper-notes-library-action-open-folder")[0];
    expect(folderBtn?.textContent).toBe("Open Folder");
    folderBtn.listeners["click"]?.(undefined);
    await Promise.resolve();
    expect(revealed).toEqual(["05 Literature/alpha2024"]);
    expect(mockNotices).toHaveLength(0);
  });

  it("Open Folder style C awaits setViewState before reveal when explorer is closed", async () => {
    const revealed: string[] = [];
    const order: string[] = [];
    const explorerView = {
      revealInFolder: (file: { path: string }) => {
        order.push("reveal");
        revealed.push(file.path);
      },
    };
    // Leaf starts without a view; setViewState mounts the explorer view.
    const leftLeaf: {
      view?: { revealInFolder: (file: { path: string }) => void };
      setViewState: (state: { type: string }) => Promise<void>;
    } = {
      setViewState: async (state: { type: string }) => {
        order.push("setViewState");
        expect(state.type).toBe("file-explorer");
        // Simulate async mount: view appears only after await resolves.
        await Promise.resolve();
        leftLeaf.view = explorerView;
      },
    };
    let explorerMounted = false;
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    (view as unknown as { app: unknown }).app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
        getAbstractFileByPath: (path: string) =>
          path === "05 Literature/alpha2024" ? { path } : null,
      },
      workspace: {
        getLeavesOfType: (type: string) => {
          if (type !== "file-explorer") {
            return [];
          }
          // Empty until setViewState mounts the leaf.
          return explorerMounted && leftLeaf.view !== undefined
            ? [leftLeaf]
            : [];
        },
        getLeftLeaf: () => leftLeaf,
        revealLeaf: () => {
          order.push("revealLeaf");
        },
        getLeaf: () => ({ openFile: async () => {} }),
      },
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({}),
            settings: {},
          },
        },
      },
    };
    // Wrap setViewState so getLeavesOfType sees the leaf after await.
    const originalSet = leftLeaf.setViewState.bind(leftLeaf);
    leftLeaf.setViewState = async (state) => {
      await originalSet(state);
      explorerMounted = true;
    };
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const bar = findByClass(root, "paper-notes-library-actions-bar")[0];
    findByClass(bar, "paper-notes-library-action-open-folder")[0].listeners[
      "click"
    ]?.(undefined);
    // Allow the async openPaperFolderAsync chain to finish.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order[0]).toBe("setViewState");
    expect(order).toContain("reveal");
    expect(order.indexOf("setViewState")).toBeLessThan(order.indexOf("reveal"));
    expect(revealed).toEqual(["05 Literature/alpha2024"]);
    expect(mockNotices).toHaveLength(0);
  });

  it("Open Folder shows a Notice when the explorer reveal API is missing", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    (view as unknown as { app: unknown }).app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
        getAbstractFileByPath: (path: string) =>
          path === "05 Literature/alpha2024" ? { path } : null,
      },
      workspace: {
        getLeavesOfType: () => [{ view: {} }], // no revealInFolder
        revealLeaf: () => {},
        getLeaf: () => ({ openFile: async () => {} }),
      },
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({}),
            settings: {},
          },
        },
      },
    };
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const bar = findByClass(root, "paper-notes-library-actions-bar")[0];
    findByClass(bar, "paper-notes-library-action-open-folder")[0].listeners[
      "click"
    ]?.(undefined);
    await Promise.resolve();
    expect(
      mockNotices.some((n) => /reveal is unavailable/i.test(n)),
    ).toBe(true);
  });

  it("table and drawer reading chips cycle via item update without row activation", async () => {
    const { readFileSync } = await import("node:fs");
    const cliCalls: string[][] = [];
    const patchPayloads: unknown[] = [];
    // No frontmatter → display unread; first click must advance to reading.
    const source = makeSource();
    source.getFrontmatter = () => undefined;
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
    (view as unknown as { app: unknown }).app = {
      vault: { adapter: { getBasePath: () => "/vault" } },
      workspace: { getLeaf: () => ({ openFile: async () => {} }) },
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({
              run: async (args: string[]) => {
                cliCalls.push([...args]);
                const patchIdx = args.indexOf("--patch");
                if (patchIdx >= 0) {
                  const path = args[patchIdx + 1];
                  patchPayloads.push(JSON.parse(readFileSync(path, "utf8")));
                }
                return {
                  envelope: {
                    status: "success",
                    data: {},
                    errors: [],
                    warnings: [],
                  },
                };
              },
            }),
            settings: {},
          },
        },
      },
    };
    await view.onOpen();
    const root = view.containerEl as unknown as ElLike;
    const tableChips = findStatusChips(root);
    const tableHost = findByClass(root, "paper-notes-library-table-host")[0];
    tableHost.scrollLeft = 280;
    tableHost.scrollTop = 96;
    expect(tableChips.length).toBeGreaterThan(0);
    const tableChip = tableChips[0];
    expect(tableChip.textContent).toBe("unread");
    expect(tableChip.cls).toContain("is-clickable");
    const stop = vi.fn();
    const prevent = vi.fn();
    tableChip.listeners["click"]?.({
      preventDefault: prevent,
      stopPropagation: stop,
    });
    expect(stop).toHaveBeenCalled();
    expect(prevent).toHaveBeenCalled();
    // Let the async cycleReadingStatus finish (fake timers + microtasks).
    await vi.runAllTimersAsync();
    const liveTableHost = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-table-host",
    )[0];
    expect(liveTableHost).not.toBe(tableHost);
    expect(liveTableHost.scrollLeft).toBe(280);
    expect(liveTableHost.scrollTop).toBe(96);
    expect(cliCalls.length).toBeGreaterThan(0);
    expect(cliCalls[0]).toEqual(
      expect.arrayContaining(["item", "update", "--key", "alpha2024", "--patch"]),
    );
    expect(patchPayloads[0]).toEqual({ reading_status: "reading" });
    // Chip click must not open the drawer.
    await flushRowClickDelay();
    expect(
      findByClass(
        view.containerEl as unknown as ElLike,
        "paper-notes-library-drawer-panel",
      ),
    ).toHaveLength(0);

    // Drawer chip: open drawer, click header chip, assert the next cycle target.
    // The first optimistic click is still visible because this source does not
    // publish metadata updates, so the next click advances reading → read.
    source.getFrontmatter = () => ({ reading_status: "unread" });
    // Force actions cache to stay; re-render by opening drawer.
    await openDrawerViaClick(view);
    const panel = drawerPanel(view);
    const drawerChips = findStatusChips(panel);
    expect(drawerChips.length).toBeGreaterThan(0);
    const drawerStop = vi.fn();
    drawerChips[0].listeners["click"]?.({
      preventDefault: vi.fn(),
      stopPropagation: drawerStop,
    });
    expect(drawerStop).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(patchPayloads.at(-1)).toEqual({ reading_status: "read" });

    // Keyboard Enter on a chip is equivalent to click (a11y).
    const keyStop = vi.fn();
    drawerChips[0].listeners["keydown"]?.({
      key: "Enter",
      preventDefault: vi.fn(),
      stopPropagation: keyStop,
    });
    expect(keyStop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(patchPayloads.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the latest optimistic reading status across an earlier metadata event", async () => {
    const { readFileSync } = await import("node:fs");
    const resolveRuns: Array<() => void> = [];
    const patchPayloads: unknown[] = [];
    const source = makeSource();
    let sourceStatus: "unread" | "reading" | "read" = "read";
    source.getFrontmatter = () => ({ reading_status: sourceStatus });
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
    (view as unknown as { app: unknown }).app = {
      vault: { adapter: { getBasePath: () => "/vault" } },
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({
              run: async (args: string[]) => {
                const patchIdx = args.indexOf("--patch");
                patchPayloads.push(JSON.parse(readFileSync(args[patchIdx + 1], "utf8")));
                await new Promise<void>((resolve) => resolveRuns.push(resolve));
                return {
                  envelope: { status: "success", data: {}, errors: [], warnings: [] },
                };
              },
            }),
            settings: {},
          },
        },
      },
    };
    await view.onOpen();
    const chip = findStatusChips(view.containerEl as unknown as ElLike)[0];
    chip.listeners["click"]?.({ preventDefault() {}, stopPropagation() {} });
    chip.listeners["click"]?.({ preventDefault() {}, stopPropagation() {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(patchPayloads).toEqual([{ reading_status: "unread" }]);
    resolveRuns.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(patchPayloads).toEqual([
      { reading_status: "unread" },
      { reading_status: "reading" },
    ]);
    // Obsidian publishes the first completed write while the second is pending.
    sourceStatus = "unread";
    view.refresh();
    findStatusChips(view.containerEl as unknown as ElLike)[0].listeners["click"]?.({
      preventDefault() {},
      stopPropagation() {},
    });
    resolveRuns.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(patchPayloads).toEqual([
      { reading_status: "unread" },
      { reading_status: "reading" },
      { reading_status: "read" },
    ]);
    sourceStatus = "read";
    resolveRuns.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(findStatusChips(view.containerEl as unknown as ElLike)[0]?.textContent).toBe("read");
  });

  it("shows the CLI-unavailable hint in the top bar when read-only", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    const root = view.containerEl as unknown as ElLike;
    const bar = findByClass(root, "paper-notes-library-actions-bar")[0];
    expect(bar).toBeDefined();
    const hint = findByClass(bar, "paper-notes-library-actions-hint")[0];
    expect(hint?.textContent).toContain("CLI unavailable");
    expect(findByClass(bar, "actions-open")).toHaveLength(0);
    expect(findByClass(bar, "actions-danger")).toHaveLength(0);
  });

  it("truncates long abstracts with an Expand toggle revealing full text", async () => {
    const long = "sentence ".repeat(140).trim(); // > 600 chars
    const view = new PaperNotesLibraryView(
      {} as WorkspaceLeaf,
      makeSource([{ ...makeRecord(), abstract: long }]),
    );
    await view.onOpen();
    await openDrawerViaClick(view);
    let panel = drawerPanel(view);
    const truncated = findByClass(panel, "paper-notes-detail-abstract")[0];
    expect(truncated.textContent.length).toBeLessThan(long.length);
    expect(truncated.textContent.endsWith("…")).toBe(true);
    const expand = findByClass(panel, "paper-notes-detail-abstract-expand")[0];
    expect(expand.textContent).toBe("Expand");
    expand.listeners["click"]?.(undefined);
    panel = drawerPanel(view);
    const full = findByClass(panel, "paper-notes-detail-abstract")[0];
    expect(full.textContent).toBe(long);
    expect(
      findByClass(panel, "paper-notes-detail-abstract-expand")[0]?.textContent,
    ).toBe("Collapse");
  });

  it("does not truncate short abstracts and shows no Expand toggle", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    await view.onOpen();
    await openDrawerViaClick(view);
    const panel = drawerPanel(view);
    expect(
      findByClass(panel, "paper-notes-detail-abstract")[0]?.textContent,
    ).toBe("Abstract text.");
    expect(
      findByClass(panel, "paper-notes-detail-abstract-expand"),
    ).toHaveLength(0);
  });

  // ── Batch 2 (D): draggable column widths + persisted customization ─────

  it("drags a header edge to resize and merge-saves into data.json", async () => {
    installDocumentStub();
    try {
      const saved: unknown[] = [];
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
      installBridgeWithPersistence(view, saved, {}, {
        cliPath: "paper-notes",
        metricsCache: { KEEP: "ME" },
      });
      await view.onOpen();
      const titleTh = headerCells(view)[0];
      expect(titleTh.style.width).toBe("340px"); // raised default
      const handle = resizeHandleOf(titleTh);
      handle.listeners["pointerdown"]?.({
        clientX: 100,
        preventDefault() {},
        stopPropagation() {},
      });
      docListeners["pointermove"]?.({ clientX: 200, preventDefault() {} });
      expect(titleTh.style.width).toBe("440px"); // live update while dragging
      docListeners["pointerup"]?.({ clientX: 200, preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      // Re-rendered table keeps the new width.
      expect(headerCells(view)[0].style.width).toBe("440px");
      expect(saved).toHaveLength(1);
      const payload = saved[0] as Record<string, unknown>;
      expect(payload.columnWidths).toEqual({ title: 440 });
      // Merge-save: other persisted keys survive untouched.
      expect(payload.metricsCache).toEqual({ KEEP: "ME" });
      expect(payload.cliPath).toBe("paper-notes");
    } finally {
      uninstallDocumentStub();
    }
  });

  it("resizing never sorts; clicking the label still sorts", async () => {
    installDocumentStub();
    try {
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
      await view.onOpen();
      const titleTh = headerCells(view)[0];
      const handle = resizeHandleOf(titleTh);
      // The handle swallows its own click so a drag can never bubble into
      // the header's sort handler in a real browser.
      const stop = vi.fn();
      handle.listeners["click"]?.({ stopPropagation: stop });
      expect(stop).toHaveBeenCalled();
      // A full drag leaves the sort state untouched.
      handle.listeners["pointerdown"]?.({
        clientX: 0,
        preventDefault() {},
        stopPropagation() {},
      });
      docListeners["pointermove"]?.({ clientX: 60, preventDefault() {} });
      docListeners["pointerup"]?.({ clientX: 60, preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      const titleAfter = headerCells(view)[0];
      expect(titleAfter.cls).not.toContain("sorted-asc");
      expect(titleAfter.cls).not.toContain("sorted-desc");
      // Clicking the label still sorts (title asc).
      titleAfter.listeners["click"]?.(undefined);
      expect(headerCells(view)[0].cls).toContain("sorted-asc");
    } finally {
      uninstallDocumentStub();
    }
  });

  it("supports very wide dragged widths (no 720 cap) and widens the table", async () => {
    installDocumentStub();
    try {
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
      await view.onOpen();
      const titleTh = headerCells(view)[0];
      const handle = resizeHandleOf(titleTh);
      handle.listeners["pointerdown"]?.({
        clientX: 100,
        preventDefault() {},
        stopPropagation() {},
      });
      docListeners["pointermove"]?.({ clientX: -10000, preventDefault() {} });
      expect(titleTh.style.width).toBe("48px");
      // Drag far past the old 720 cap: 340 + (2500 - 100) = 2740.
      docListeners["pointermove"]?.({ clientX: 2500, preventDefault() {} });
      expect(titleTh.style.width).toBe("2740px");
      // An absurd drag hits the safety valve (100000), not a 720 ceiling.
      docListeners["pointermove"]?.({ clientX: 200000, preventDefault() {} });
      expect(titleTh.style.width).toBe("100000px");
      docListeners["pointerup"]?.({ clientX: 2500, preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(headerCells(view)[0].style.width).toBe("2740px");
      // Table width follows the sum of the visible column widths.
      const root = view.containerEl as unknown as ElLike;
      const table = findByClass(root, "paper-notes-library-table")[0];
      const sum =
        2740 + 150 + 70 + 200 + 100 + 70 + 70 + 70 + 180 + 130;
      expect(table.style.width).toBe(`${sum}px`);
    } finally {
      uninstallDocumentStub();
    }
  });

  it("applies persisted column widths from settings on load", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
    installBridgeWithPersistence(view, [], {
      columnWidths: { title: 500, journal: 220 },
    });
    await view.onOpen();
    const ths = headerCells(view);
    expect(ths[0].style.width).toBe("500px");
    expect(ths[3].style.width).toBe("220px");
    expect(ths[2].style.width).toBe("70px"); // year keeps its default
  });
});
