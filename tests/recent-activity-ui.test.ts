/**
 * Tests for R2 Recent Literature UI (Task: P4).
 * Covers:
 * - 0/1/3/more than 3 records rendering count (capped at 3).
 * - Same paper appearing simultaneously in both "Recent Reads" and "Recent Imports".
 * - Clicking recent item opens Detail Drawer without opening PDF/Figure,
 *   and preserves searchQuery/filters (critical counterexample against focusPaper).
 * - Clicking currently open paper keeps drawer open (no drawer-toggle closing).
 * - Papers excluded by table filters can still be opened from recent section and display details.
 * - Empty states for both groups.
 * - Clicking recent area does not update recent reading timestamp.
 * - Invalid/missing file surfaces clear Notice and does not silently open another file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  formatRecentDate,
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import {
  RecentActivityStore,
  type RecentImportEntry,
  type RecentReadEntry,
} from "../src/services/recent-activity";
import type { PaperRecord } from "../src/types/paper";

const mockNotices: string[] = [];
const mockOpenedFiles: unknown[] = [];

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
    setText(text: string): void {
      this.textContent = text;
    }
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
    querySelector(selector: string): El | null {
      for (const child of this.children) {
        if (selector === '[aria-current="page"]' && child.attrs["aria-current"] === "page") {
          return child;
        }
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    contains(child: El): boolean {
      return this.children.some((c) => c === child || c.contains(child));
    }
    focus(): void {}
  }

  class ItemView {
    leaf: unknown;
    app = {
      workspace: {
        getLeaf: () => ({
          openFile: (file: unknown) => {
            mockOpenedFiles.push(file);
          },
        }),
      },
      vault: {
        getAbstractFileByPath: (path: string) => {
          if (path.includes("missing") || path.includes("deleted")) {
            return null;
          }
          return { path };
        },
      },
    };
    containerEl: El;
    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.containerEl = new El("div");
      this.containerEl.clientWidth = 1000;
    }
    open(): void {}
    async setState(): Promise<void> {}
  }

  class WorkspaceLeaf {}
  class Notice {
    constructor(message: string) {
      mockNotices.push(message);
    }
  }

  return { ItemView, WorkspaceLeaf, Notice, setIcon: (el: El, icon: string) => { el.attrs["data-icon"] = icon; } };
});

interface ElLike {
  tag?: string;
  cls: string;
  textContent: string;
  style: Record<string, string>;
  children: ElLike[];
  listeners: Record<string, (event?: unknown) => void>;
  attrs?: Record<string, string>;
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

function makeRecord(key: string, title: string, year = 2024): PaperRecord {
  return {
    path: `05 Literature/${key}/${key}.md`,
    key,
    paperId: `id-${key}`,
    title,
    authors: [{ family: "Author", given: "A." }],
    journal: "Journal of Science",
    year,
    identifiers: { doi: `10.1000/${key}` },
    citationKeyAliases: [],
    titleAliases: [],
    abstract: `Abstract for ${key}.`,
  };
}

function makeMockSource(options?: {
  records?: PaperRecord[];
  reads?: RecentReadEntry[];
  imports?: RecentImportEntry[];
  frontmatterMap?: Record<string, Record<string, unknown>>;
}): LibraryViewSource {
  const records = options?.records ?? [
    makeRecord("paperA", "Alpha Paper"),
    makeRecord("paperB", "Beta Paper"),
    makeRecord("paperC", "Gamma Paper"),
    makeRecord("paperD", "Delta Paper"),
  ];

  return {
    getRecords: () => records,
    getInvalidRecords: () => [],
    getFrontmatter: (path) => options?.frontmatterMap?.[path] ?? undefined,
    listDirectory: () => ["paperA.pdf", "paperB.pdf", "paperC.pdf", "paperD.pdf"],
    getCards: () => [],
    getRecentReads: (limit) => (options?.reads ?? []).slice(0, limit ?? 3),
    getRecentImports: (limit) => (options?.imports ?? []).slice(0, limit ?? 3),
  };
}

describe("Recent Activity UI (Stage P4)", () => {
  beforeEach(() => {
    mockNotices.length = 0;
    mockOpenedFiles.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("formatRecentDate", () => {
    it("formats epoch ms timestamp to YYYY-MM-DD", () => {
      const ms = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10
      const formatted = formatRecentDate(ms);
      expect(formatted).toMatch(/2026-09-1/);
    });

    it("formats ISO string to YYYY-MM-DD", () => {
      const formatted = formatRecentDate("2026-09-10T15:30:00Z");
      expect(formatted).toMatch(/2026-09-1/);
    });

    it("returns empty string for invalid or missing inputs", () => {
      expect(formatRecentDate(undefined)).toBe("");
      expect(formatRecentDate("")).toBe("");
      expect(formatRecentDate("invalid-date")).toBe("");
      expect(formatRecentDate(0)).toBe("");
      expect(formatRecentDate(-100)).toBe("");
      expect(formatRecentDate(NaN)).toBe("");
    });
  });

  describe("Card counts: 0 / 1 / 3 / >3 records (capped at 3)", () => {
    it("renders empty states when both reads and imports are empty", async () => {
      const source = makeMockSource({ reads: [], imports: [] });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const recentSection = findByClass(root, "paper-notes-recent-section");
      expect(recentSection).toHaveLength(1);

      const emptyElements = findByClass(root, "paper-notes-recent-empty");
      expect(emptyElements).toHaveLength(2);
      expect(emptyElements[0].textContent).toBe("暂无最近阅读的文献");
      expect(emptyElements[1].textContent).toBe("暂无新导入的文献");

      const cards = findByClass(root, "paper-notes-recent-card");
      expect(cards).toHaveLength(0);
    });

    it("renders exactly 1 card when 1 item is available", async () => {
      const reads: RecentReadEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: Date.now(), kind: "pdf" },
      ];
      const source = makeMockSource({ reads, imports: [] });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const readsGroup = findByClass(root, "paper-notes-recent-group--reads")[0];
      expect(readsGroup).toBeDefined();

      const cards = findByClass(readsGroup, "paper-notes-recent-card");
      expect(cards).toHaveLength(1);
      expect(findByClass(cards[0], "paper-notes-recent-card-title")[0].textContent).toBe("Alpha Paper");
      expect(findByClass(cards[0], "paper-notes-recent-card-kind")[0].textContent).toBe("PDF");

      // Reads has no empty text, imports still has empty text
      expect(findByClass(readsGroup, "paper-notes-recent-empty")).toHaveLength(0);
      const importsGroup = findByClass(root, "paper-notes-recent-group--imports")[0];
      expect(findByClass(importsGroup, "paper-notes-recent-empty")[0].textContent).toBe("暂无新导入的文献");
    });

    it("renders exactly 3 cards when 3 items are available", async () => {
      const reads: RecentReadEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: 3000, kind: "pdf" },
        { key: "paperB", path: "05 Literature/paperB/paperB.md", timestamp: 2000, kind: "figure" },
        { key: "paperC", path: "05 Literature/paperC/paperC.md", timestamp: 1000, kind: "pdf" },
      ];
      const source = makeMockSource({ reads });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const readsGroup = findByClass(root, "paper-notes-recent-group--reads")[0];
      const cards = findByClass(readsGroup, "paper-notes-recent-card");
      expect(cards).toHaveLength(3);
      expect(findByClass(cards[0], "paper-notes-recent-card-title")[0].textContent).toBe("Alpha Paper");
      expect(findByClass(cards[1], "paper-notes-recent-card-title")[0].textContent).toBe("Beta Paper");
      expect(findByClass(cards[1], "paper-notes-recent-card-kind")[0].textContent).toBe("Figure解读");
      expect(findByClass(cards[2], "paper-notes-recent-card-title")[0].textContent).toBe("Gamma Paper");
    });

    it("caps display at 3 cards when more than 3 items are available", async () => {
      const reads: RecentReadEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: 5000, kind: "pdf" },
        { key: "paperB", path: "05 Literature/paperB/paperB.md", timestamp: 4000, kind: "pdf" },
        { key: "paperC", path: "05 Literature/paperC/paperC.md", timestamp: 3000, kind: "pdf" },
        { key: "paperD", path: "05 Literature/paperD/paperD.md", timestamp: 2000, kind: "pdf" },
      ];
      const imports: RecentImportEntry[] = [
        { key: "paperD", path: "05 Literature/paperD/paperD.md", createdAt: "2026-09-04", timestamp: 5000 },
        { key: "paperC", path: "05 Literature/paperC/paperC.md", createdAt: "2026-09-03", timestamp: 4000 },
        { key: "paperB", path: "05 Literature/paperB/paperB.md", createdAt: "2026-09-02", timestamp: 3000 },
        { key: "paperA", path: "05 Literature/paperA/paperA.md", createdAt: "2026-09-01", timestamp: 2000 },
      ];

      // Custom source that returns all 4 without limiting inside getRecentReads/Imports
      const source: LibraryViewSource = {
        getRecords: () => [
          makeRecord("paperA", "Alpha Paper"),
          makeRecord("paperB", "Beta Paper"),
          makeRecord("paperC", "Gamma Paper"),
          makeRecord("paperD", "Delta Paper"),
        ],
        getInvalidRecords: () => [],
        getFrontmatter: () => undefined,
        listDirectory: () => [],
        getCards: () => [],
        getRecentReads: () => reads, // returns 4
        getRecentImports: () => imports, // returns 4
      };

      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const readCards = findByClass(findByClass(root, "paper-notes-recent-group--reads")[0], "paper-notes-recent-card");
      expect(readCards).toHaveLength(3); // Capped at 3

      const importCards = findByClass(findByClass(root, "paper-notes-recent-group--imports")[0], "paper-notes-recent-card");
      expect(importCards).toHaveLength(3); // Capped at 3
    });
  });

  describe("Same paper in both groups", () => {
    it("renders the same paper in both recent reads and recent imports independently", async () => {
      const reads: RecentReadEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: 5000, kind: "pdf" },
      ];
      const imports: RecentImportEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", createdAt: "2026-09-10", timestamp: 5000 },
      ];

      const source = makeMockSource({ reads, imports });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const readCard = findByClass(findByClass(root, "paper-notes-recent-group--reads")[0], "paper-notes-recent-card")[0];
      const importCard = findByClass(findByClass(root, "paper-notes-recent-group--imports")[0], "paper-notes-recent-card")[0];

      expect(readCard).toBeDefined();
      expect(importCard).toBeDefined();
      expect(readCard.attrs?.["data-citation-key"]).toBe("paperA");
      expect(importCard.attrs?.["data-citation-key"]).toBe("paperA");

      // Clicking either opens the detail drawer for paperA
      readCard.listeners["click"]?.({ preventDefault() {} });
      const drawer = findByClass(root, "paper-notes-library-drawer-panel");
      expect(drawer).toHaveLength(1);
      expect(view.getState().selectedPath).toBe("05 Literature/paperA/paperA.md");
    });
  });

  describe("Clicking recent item opens Detail Drawer without opening PDF/Figure and preserves search/filter", () => {
    it("opens drawer, does not call openFile for PDF/Figure, and preserves searchQuery and filters", async () => {
      const records = [
        makeRecord("paperA", "Alpha Paper"),
        makeRecord("paperB", "Beta Paper"),
      ];
      const reads: RecentReadEntry[] = [
        { key: "paperB", path: "05 Literature/paperB/paperB.md", timestamp: 1000, kind: "pdf" },
      ];

      const source = makeMockSource({ records, reads });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      // Simulate an active user search
      const root = view.containerEl as unknown as ElLike;
      const searchInput = findByClass(root, "paper-notes-library-search")[0] as unknown as { value: string; listeners: Record<string, (e: unknown) => void> };
      searchInput.value = "Alpha";
      searchInput.listeners["input"]?.({});

      // State check: search is "Alpha"
      expect(view.getState().searchQuery).toBe("Alpha");

      // Drawer is initially closed
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(0);

      // Click the recent card for paperB
      const card = findByClass(root, "paper-notes-recent-card")[0];
      expect(card.attrs?.["data-citation-key"]).toBe("paperB");
      card.listeners["click"]?.({ preventDefault() {} });

      // Assert drawer opened with paperB
      expect(view.getState().drawerOpen).toBe(true);
      expect(view.getState().selectedPath).toBe("05 Literature/paperB/paperB.md");
      const drawer = findByClass(root, "paper-notes-library-drawer-panel");
      expect(drawer).toHaveLength(1);
      expect(findByClass(drawer[0], "paper-notes-library-detail-title")[0].textContent).toBe("Beta Paper");

      // CRITICAL CONTRACT: searchQuery was NOT wiped (unlike focusPaper which resets it to "")
      expect(view.getState().searchQuery).toBe("Alpha");

      // CRITICAL CONTRACT: workspace openFile was NOT called (no PDF or Figure note launched)
      expect(mockOpenedFiles).toHaveLength(0);
    });
  });

  describe("Re-clicking the same paper keeps drawer open (no toggle-close)", () => {
    it("keeps drawer open when clicking the same paper multiple times from recent area", async () => {
      const reads: RecentReadEntry[] = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: 1000, kind: "pdf" },
      ];
      const source = makeMockSource({ reads });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const card = findByClass(root, "paper-notes-recent-card")[0];

      // First click: opens drawer
      card.listeners["click"]?.({ preventDefault() {} });
      expect(view.getState().drawerOpen).toBe(true);
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);

      // Second click: MUST keep drawer open, NOT toggle closed!
      card.listeners["click"]?.({ preventDefault() {} });
      expect(view.getState().drawerOpen).toBe(true);
      expect(findByClass(root, "paper-notes-library-drawer-panel")).toHaveLength(1);
      expect(view.getState().selectedPath).toBe("05 Literature/paperA/paperA.md");
    });
  });

  describe("Paper excluded by table filters can still be opened from recent area", () => {
    it("renders full details in drawer when the paper is filtered out of the table", async () => {
      const records = [
        makeRecord("paperA", "Alpha Paper"),
        makeRecord("paperB", "Beta Paper"),
      ];
      const reads: RecentReadEntry[] = [
        { key: "paperB", path: "05 Literature/paperB/paperB.md", timestamp: 1000, kind: "pdf" },
      ];

      // PaperA has reading_status "unread", PaperB has reading_status "read"
      const frontmatterMap: Record<string, Record<string, unknown>> = {
        "05 Literature/paperA/paperA.md": { reading_status: "unread" },
        "05 Literature/paperB/paperB.md": { reading_status: "read" },
      };

      const source = makeMockSource({ records, reads, frontmatterMap });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      // Search for "Alpha", which strictly excludes "Beta Paper" (paperB) from queryItems
      const root = view.containerEl as unknown as ElLike;
      const searchInput = findByClass(root, "paper-notes-library-search")[0] as unknown as { value: string; listeners: Record<string, (e: unknown) => void> };
      searchInput.value = "Alpha";
      searchInput.listeners["input"]?.({});

      // Verify paperB is not in table rows
      const tableRows = findByClass(root, "paper-notes-library-table")[0];
      const rowTexts = tableRows.children.map((c) => c.textContent).join(" ");
      expect(rowTexts).not.toContain("Beta Paper");

      // Click paperB in recent section
      const card = findByClass(root, "paper-notes-recent-card")[0];
      expect(card.attrs?.["data-citation-key"]).toBe("paperB");
      card.listeners["click"]?.({ preventDefault() {} });

      // Assert drawer opened
      expect(view.getState().drawerOpen).toBe(true);
      const drawer = findByClass(root, "paper-notes-library-drawer-panel")[0];
      expect(drawer).toBeDefined();

      // Assert drawer displays Beta Paper details, NOT "Select a paper to view its read-only details."!
      const detailTitle = findByClass(drawer, "paper-notes-library-detail-title")[0];
      expect(detailTitle?.textContent).toBe("Beta Paper");

      const emptyHint = findByClass(drawer, "paper-notes-library-empty");
      expect(emptyHint).toHaveLength(0);
    });
  });

  describe("Does not record read on recent card click", () => {
    it("clicking recent card does not invoke recordRead or change read timestamps", async () => {
      const store = new RecentActivityStore();
      const initialTimestamp = 123456789;
      await store.recordRead({
        key: "paperA",
        path: "05 Literature/paperA/paperA.md",
        timestamp: initialTimestamp,
        kind: "pdf",
      });

      const records = [makeRecord("paperA", "Alpha Paper")];
      const source: LibraryViewSource = {
        getRecords: () => records,
        getInvalidRecords: () => [],
        getFrontmatter: () => undefined,
        listDirectory: () => [],
        getCards: () => [],
        getRecentReads: (limit) => store.getRecentReads(limit, records),
        getRecentImports: (limit) => store.getRecentImports(limit, records),
      };

      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      const root = view.containerEl as unknown as ElLike;
      const card = findByClass(root, "paper-notes-recent-card")[0];
      expect(card).toBeDefined();

      // Click card
      card.listeners["click"]?.({ preventDefault() {} });

      // Drawer opened
      expect(view.getState().drawerOpen).toBe(true);

      // Verify store timestamp has NOT changed
      const currentReads = store.getRecentReads(10, records);
      expect(currentReads).toHaveLength(1);
      expect(currentReads[0].timestamp).toBe(initialTimestamp);
      expect(store.readCount).toBe(1);
    });
  });

  describe("Refresh mechanism", () => {
    it("re-renders recent cards when view.refresh() is called after activity changes", async () => {
      let currentReads: RecentReadEntry[] = [];
      const source: LibraryViewSource = {
        getRecords: () => [makeRecord("paperA", "Alpha Paper")],
        getInvalidRecords: () => [],
        getFrontmatter: () => undefined,
        listDirectory: () => [],
        getCards: () => [],
        getRecentReads: () => currentReads,
        getRecentImports: () => [],
      };

      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      let root = view.containerEl as unknown as ElLike;
      expect(findByClass(root, "paper-notes-recent-card")).toHaveLength(0);
      expect(findByClass(root, "paper-notes-recent-empty")[0].textContent).toBe("暂无最近阅读的文献");

      // New read occurs
      currentReads = [
        { key: "paperA", path: "05 Literature/paperA/paperA.md", timestamp: Date.now(), kind: "pdf" },
      ];

      // refresh() is invoked (as done after recordRead/recordImport or vault events)
      view.refresh();

      root = view.containerEl as unknown as ElLike;
      const cards = findByClass(root, "paper-notes-recent-card");
      expect(cards).toHaveLength(1);
      expect(findByClass(cards[0], "paper-notes-recent-card-title")[0].textContent).toBe("Alpha Paper");
    });
  });

  describe("Invalid/missing file handling", () => {
    it("displays a clear Notice and does not open drawer when file is missing from library", async () => {
      const source = makeMockSource();
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      // Call openPaperDetail with non-existent citation key
      view.openPaperDetail("ghost_key");

      expect(mockNotices).toContain("Paper not found: ghost_key");
      expect(view.getState().drawerOpen).toBe(false);
      expect(view.getState().selectedPath).toBeNull();
    });

    it("displays a clear Notice when abstract file no longer exists in vault", async () => {
      const records = [makeRecord("deleted_paper", "Deleted Paper")];
      const source = makeMockSource({ records });
      const view = new PaperNotesLibraryView({} as WorkspaceLeaf, source);
      await view.onOpen();

      // Path contains "deleted", so the mock vault returns null
      view.openPaperDetail("deleted_paper", "05 Literature/deleted_paper/deleted_paper.md");

      expect(mockNotices).toContain("Paper file no longer exists: deleted_paper");
      expect(view.getState().drawerOpen).toBe(false);
    });
  });
});
