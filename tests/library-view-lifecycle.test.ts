/**
 * Literature Library view lifecycle tests (Repair: Gate D R1).
 *
 * Gate D R1 root cause: `PaperNotesLibraryView` declared `private open = false`,
 * shadowing the `open()` method the Obsidian runtime calls on `View` instances
 * when a leaf is activated (`TypeError: e.open is not a function`, white view).
 * The vitest ItemView mock had no real `open()` method, so the shadowing was
 * invisible to the old unit tests — only the real Obsidian runtime exposed it.
 *
 * The mock ItemView in this file mirrors the real runtime: `open()` lives on the
 * base class prototype and `app`/`containerEl` support the view's render path.
 * The regression test below asserts `view.open` is a function (i.e. the
 * prototype method, not a boolean instance field); the state tests cover the
 * renamed `isOpen` flag across `onOpen`/`onClose` and the `refresh()` gate.
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";

vi.mock("obsidian", () => {
  interface FakeEl {
    style: Record<string, string>;
    value: string;
    checked: boolean;
    selected: boolean;
    disabled: boolean;
    textContent: string;
    empty(): void;
    addClass(_cls: string): void;
    removeClass(_cls: string): void;
    toggleClass(_cls: string, _on?: boolean): void;
    createDiv(_opts?: Record<string, unknown>): FakeEl;
    createEl(_tag: string, _opts?: Record<string, unknown>): FakeEl;
    addEventListener(_type: string, _handler: unknown): void;
    removeEventListener(_type: string, _handler: unknown): void;
    appendChild(_child: FakeEl): void;
    append(..._children: FakeEl[]): void;
    remove(): void;
    detach(): void;
    setAttribute(_name: string, _value: string): void;
    getAttribute(_name: string): string | null;
    querySelector(_selector: string): FakeEl | null;
    querySelectorAll(_selector: string): FakeEl[];
  }

  function makeEl(): FakeEl {
    return {
      style: {},
      value: "",
      checked: false,
      selected: false,
      disabled: false,
      textContent: "",
      empty: () => {},
      addClass: () => {},
      removeClass: () => {},
      toggleClass: () => {},
      createDiv: () => makeEl(),
      createEl: () => makeEl(),
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: () => {},
      append: () => {},
      remove: () => {},
      detach: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  }

  class ItemView {
    leaf: unknown;
    app: Record<string, never>;
    containerEl: FakeEl;

    constructor(leaf: unknown) {
      this.leaf = leaf;
      // No plugin registry / vault on the mock app: the view's lazy bridge
      // resolution (`resolvePluginBridge`, `getActions`) safely returns
      // undefined and the library renders read-only.
      this.app = {};
      this.containerEl = makeEl();
    }

    /** Mirrors the real Obsidian runtime `View.open()` called by the workspace. */
    open(): void {}
    async setState(_state?: unknown, _result?: unknown): Promise<void> {}
    getState(): Record<string, unknown> {
      return {};
    }
  }

  class WorkspaceLeaf {}

  return { ItemView, WorkspaceLeaf, setIcon: () => {} };
});

function makeSource(): LibraryViewSource {
  return {
    getRecords: () => [],
    getInvalidRecords: () => [],
    getFrontmatter: () => undefined,
    listDirectory: () => [],
    getCards: () => [],
  };
}

function makeView(): PaperNotesLibraryView {
  return new PaperNotesLibraryView({} as WorkspaceLeaf, makeSource());
}

describe("PaperNotesLibraryView lifecycle", () => {
  it("does not shadow the base View.open() method with a boolean field", () => {
    const view = makeView();
    // Regression for Gate D R1: `private open = false` made Obsidian's
    // runtime `view.open()` call fail with "e.open is not a function",
    // leaving the view completely white.
    expect(typeof (view as any).open).toBe("function");
  });

  it("tracks the open state via isOpen across onOpen/onClose", async () => {
    const view = makeView();
    expect((view as any).isOpen).toBe(false);
    await view.onOpen();
    expect((view as any).isOpen).toBe(true);
    await view.onClose();
    expect((view as any).isOpen).toBe(false);
  });

  it("gates refresh() on the open state", async () => {
    const view = makeView();
    const renderSpy = vi.spyOn(view as any, "render");

    // Freshly constructed views are closed: refresh is a no-op.
    view.refresh();
    expect(renderSpy).not.toHaveBeenCalled();

    // onOpen renders once and opens the gate.
    await view.onOpen();
    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderSpy.mockClear();
    view.refresh();
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // onClose closes the gate again.
    await view.onClose();
    renderSpy.mockClear();
    view.refresh();
    expect(renderSpy).not.toHaveBeenCalled();
  });
});

describe("PaperNotesLibraryView public state contract (getState/setState)", () => {
  it("returns a JSON-safe state object that survives JSON round-trip identically", async () => {
    const view = makeView();
    const state = view.getState();
    const serialized = JSON.stringify(state);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(state);

    // Also with populated state
    await view.setState(
      {
        page: "library",
        searchQuery: "quantum computing",
        filters: {
          yearFrom: 2020,
          yearTo: 2024,
          journal: "Nature",
          readingStatus: "reading",
          requiredArtifacts: ["pdf"],
        },
        sort: { columnId: "journal", direction: "asc" },
        selectedPath: "papers/quantum.md",
        drawerOpen: true,
      },
      { history: false },
    );
    const activeState = view.getState();
    expect(JSON.parse(JSON.stringify(activeState))).toEqual(activeState);
    expect(activeState).toEqual({
      page: "library",
      searchQuery: "quantum computing",
      filters: {
        yearFrom: 2020,
        yearTo: 2024,
        journal: "Nature",
        readingStatus: "reading",
        requiredArtifacts: ["pdf"],
      },
      sort: { columnId: "journal", direction: "asc" },
      selectedPath: "papers/quantum.md",
      drawerOpen: true,
    });
  });

  it("restores complete UI state via setState and reflects it across onOpen", async () => {
    const view = makeView();
    await view.setState(
      {
        page: "library",
        searchQuery: "einstein relativity",
        filters: {
          journal: "Annalen der Physik",
          yearFrom: 1905,
          requiredArtifacts: ["pdf", "minerU"],
        },
        sort: { columnId: "year", direction: "asc" },
        selectedPath: "papers/einstein1905.md",
        drawerOpen: true,
      },
      { history: false },
    );

    expect(view.getState()).toEqual({
      page: "library",
      searchQuery: "einstein relativity",
      filters: {
        journal: "Annalen der Physik",
        yearFrom: 1905,
        requiredArtifacts: ["pdf", "minerU"],
      },
      sort: { columnId: "year", direction: "asc" },
      selectedPath: "papers/einstein1905.md",
      drawerOpen: true,
    });

    // Opening the view does not crash and renders with drawer open
    await view.onOpen();
    expect(view.getState().drawerOpen).toBe(true);
    await view.onClose();
  });

  it("boundary: drawerOpen=true with missing or invalid selectedPath does not crash and does not open drawer", async () => {
    const view = makeView();

    // 1. Missing selectedPath (omitted)
    await view.setState({ page: "library", drawerOpen: true }, { history: false });
    expect(view.getState().drawerOpen).toBe(false);
    expect(view.getState().selectedPath).toBeNull();

    // 2. null selectedPath
    await view.setState({ page: "library", drawerOpen: true, selectedPath: null }, { history: false });
    expect(view.getState().drawerOpen).toBe(false);
    expect(view.getState().selectedPath).toBeNull();

    // 3. empty string selectedPath
    await view.setState({ page: "library", drawerOpen: true, selectedPath: "" }, { history: false });
    expect(view.getState().drawerOpen).toBe(false);
    expect(view.getState().selectedPath).toBeNull();

    // 4. invalid non-string selectedPath
    await view.setState({ page: "library", drawerOpen: true, selectedPath: 12345 }, { history: false });
    expect(view.getState().drawerOpen).toBe(false);
    expect(view.getState().selectedPath).toBeNull();

    // Render pass with drawerOpen=false does not crash
    await view.onOpen();
    expect(view.getState().drawerOpen).toBe(false);
    await view.onClose();
  });

  it("backward compatibility: restores legacy workspace layout states containing only page", async () => {
    const view = makeView();

    // Legacy MOC state
    await view.setState({ page: "moc" }, { history: false });
    expect(view.getState().page).toBe("moc");
    expect(view.getState().drawerOpen).toBe(false);

    // Legacy Library state
    await view.setState({ page: "library" }, { history: false });
    expect(view.getState().page).toBe("library");
    expect(view.getState().drawerOpen).toBe(false);
  });

  it("ignores malformed or garbage values in setState without throwing", async () => {
    const view = makeView();
    const initial = view.getState();

    await view.setState(
      {
        searchQuery: 99999,
        filters: "not-an-object",
        sort: { columnId: "nonexistent", direction: "diagonal" },
        selectedPath: { invalid: true },
        drawerOpen: "yes",
      },
      { history: false },
    );

    // Defaults remain intact, no error thrown
    expect(view.getState()).toEqual(initial);
  });
});
