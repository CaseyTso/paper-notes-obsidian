/**
 * Detail Cards block (Repair: Gate D R3) DOM tests.
 *
 * Gate D R3 root cause: the "Open cards" button opened only the first
 * sorted card note under `<paper>/cards/`; a paper with several cards
 * (xia) could not switch between them. The fix renders a Cards block in
 * the detail panel that lists EVERY card note — each row opens that
 * exact card through the shared `openCard()` entry — and disappears
 * entirely when the paper has no cards. A future in-panel card view
 * (user long-term plan) reuses the same `getCards`/`openCard` entries.
 *
 * The obsidian mock provides a recording element stub plus a fake vault
 * (`getAbstractFileByPath`) and workspace (`getLeaf`/`openFile`) so the
 * tests can assert the rendered rows and the exact opened paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import type { PaperRecord } from "../src/types/paper";

const state = vi.hoisted(() => ({
  opened: [] as string[],
  vaultFiles: new Map<string, { path: string }>(),
  app: {} as Record<string, unknown>,
}));

vi.mock("obsidian", () => {
  interface ElOpts {
    cls?: string;
    text?: string;
    attr?: Record<string, unknown>;
  }

  class El {
    tag: string;
    cls = "";
    textContent = "";
    disabled = false;
    value = "";
    checked = false;
    selected = false;
    style: Record<string, string> = {};
    children: El[] = [];
    listeners: Record<string, (event?: unknown) => void> = {};

    constructor(tag: string) {
      this.tag = tag;
    }

    addEventListener(type: string, fn: (event?: unknown) => void): void {
      this.listeners[type] = fn;
    }

    addClass(_cls: string): void {}
    removeClass(_cls: string): void {}
    toggleClass(_cls: string, _on?: boolean): void {}

    setText(text: string): void {
      this.textContent = text;
    }

    empty(): void {
      this.children = [];
    }

    createEl(tag: string, opts: ElOpts = {}): El {
      const el = new El(tag);
      el.cls = opts.cls ?? "";
      el.textContent = opts.text ?? "";
      this.children.push(el);
      return el;
    }

    createDiv(opts: ElOpts = {}): El {
      return this.createEl("div", opts);
    }

    /** Test helper: fire the recorded click handler, if any. */
    click(): void {
      this.listeners["click"]?.(undefined);
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
    constructor(_message: string) {}
  }

  return { ItemView, WorkspaceLeaf, Notice };
});

const NOTE_PATH = "05 Literature/alpha2024/alpha2024.md";
const CARDS_DIR = "05 Literature/alpha2024/cards";

function makeRecord(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    path: NOTE_PATH,
    key: "alpha2024",
    paperId: "550e8400-e29b-41d4-a716-446655440000",
    title: "Alpha cells in the pancreas",
    authors: [{ family: "Shiau", given: "Wen" }],
    journal: "Nature Methods",
    year: 2024,
    identifiers: { doi: "10.1000/alpha" },
    citationKeyAliases: [],
    titleAliases: [],
    abstract: "Alpha abstract text.",
    ...overrides,
  };
}

/** Source whose `getCards` returns the given (already sorted) card names. */
function makeSource(cards: string[]): LibraryViewSource {
  return {
    getRecords: () => [makeRecord()],
    getInvalidRecords: () => [],
    getFrontmatter: () => undefined,
    listDirectory: (dir: string) =>
      dir === "05 Literature/alpha2024" ? ["alpha2024.pdf"] : [],
    getCards: (_dir: string) => [...cards],
    getMetrics: () => undefined,
  };
}

/** Minimal structural view of the recording element tree. */
interface ElLike {
  cls: string;
  textContent: string;
  children: ElLike[];
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

/** Render the detail panel with the only paper selected. */
async function renderedView(cards: string[]): Promise<PaperNotesLibraryView> {
  const view = new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource(cards));
  (view as unknown as { selectedPath: string }).selectedPath = NOTE_PATH;
  await view.onOpen();
  return view;
}

function installFakeVaultAndWorkspace(): void {
  state.app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      getAbstractFileByPath: (path: string) =>
        state.vaultFiles.get(path) ?? null,
    },
    workspace: {
      getLeaf: () => ({
        openFile: async (file: { path: string }) => {
          state.opened.push(file.path);
        },
      }),
    },
    plugins: undefined,
  };
}

describe("detail Cards block (Gate D R3)", () => {
  beforeEach(() => {
    state.opened.length = 0;
    state.vaultFiles.clear();
    installFakeVaultAndWorkspace();
  });

  it("renders one clickable row for a single card", async () => {
    state.vaultFiles.set(`${CARDS_DIR}/card-a.md`, {
      path: `${CARDS_DIR}/card-a.md`,
    });
    const view = await renderedView(["card-a.md"]);
    const rows = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-cards-row",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe("card-a");

    (rows[0] as unknown as { click(): void }).click();
    expect(state.opened).toEqual([`${CARDS_DIR}/card-a.md`]);
  });

  it("lists every card and opens each one on its own row click", async () => {
    state.vaultFiles.set(`${CARDS_DIR}/a.md`, { path: `${CARDS_DIR}/a.md` });
    state.vaultFiles.set(`${CARDS_DIR}/b.md`, { path: `${CARDS_DIR}/b.md` });
    const view = await renderedView(["a.md", "b.md"]);
    const rows = findByClass(
      view.containerEl as unknown as ElLike,
      "paper-notes-library-cards-row",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual(["a", "b"]);

    (rows[1] as unknown as { click(): void }).click();
    expect(state.opened).toEqual([`${CARDS_DIR}/b.md`]);

    (rows[0] as unknown as { click(): void }).click();
    expect(state.opened).toEqual([`${CARDS_DIR}/b.md`, `${CARDS_DIR}/a.md`]);
  });

  it("does not render the block when the paper has no cards", async () => {
    const view = await renderedView([]);
    const root = view.containerEl as unknown as ElLike;
    expect(findByClass(root, "paper-notes-library-cards")).toHaveLength(0);
    expect(findByClass(root, "paper-notes-library-cards-row")).toHaveLength(0);
  });

  it("replaces the former Open cards button with the block", async () => {
    // A plugin bridge with a CLI client makes the action bar render its
    // buttons; the removed "Open cards" button must no longer appear
    // while the Cards block is the entry point instead.
    state.app = {
      ...(state.app as Record<string, unknown>),
      plugins: {
        plugins: {
          "paper-notes": {
            getCliClient: () => ({}),
            settings: {},
          },
        },
      },
    };
    const view = await renderedView(["card-a.md"]);
    const texts = collectTexts(view.containerEl as unknown as ElLike);
    expect(texts).toContain("Open main");
    expect(texts).not.toContain("Open cards");
    expect(
      findByClass(
        view.containerEl as unknown as ElLike,
        "paper-notes-library-cards-row",
      ),
    ).toHaveLength(1);
  });
});
