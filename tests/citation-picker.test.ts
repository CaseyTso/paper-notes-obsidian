/**
 * Keyboard citation picker (Task 27) — model + wiring tests.
 *
 * Covers `src/services/citation-inserter.ts` (pure search/label/selection/
 * insertion logic), `src/modals/citation-picker-modal.ts` (command-driven
 * modal factory) and the `paper-notes-insert-citation` command registered in
 * `src/main.ts`:
 *
 * - Command registration with no hardcoded default hotkey.
 * - No editor-typing interceptor: typing `@` never auto-activates the picker.
 * - Search across title/author/year/journal/DOI/PMID/current key/alias.
 * - Result labels show title, first author, year, journal.
 * - Single selection inserts `[@key]`.
 * - Multi-selection inserts `[@key1; @key2]` in selection order.
 * - Insertion at the editor cursor / replacing the active selection.
 * - Alias search inserts the record's current key.
 * - `paper_id` is never part of search or of inserted prose.
 *
 * The modal is exercised through a fake DOM (the `obsidian` runtime mock
 * provides `Modal` plus minimal `createEl`/`createDiv` nodes); no real
 * Obsidian UI is involved. Subjective visual acceptance is Task 33 Gate D.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { App, PluginManifest } from "obsidian";

import type { PaperRecord } from "../src/types/paper";
import {
  buildCitationText,
  citationLabelOf,
  insertCitation,
  searchCitationCandidates,
  toggleCitationSelection,
  type CitationEditorPort,
} from "../src/services/citation-inserter";
import { createCitationPickerModal } from "../src/modals/citation-picker-modal";
import PaperNotesPlugin, {
  INSERT_CITATION_COMMAND,
  OPEN_LIBRARY_COMMAND,
} from "../src/main";

const state = vi.hoisted(() => ({
  registeredCommands: [] as Array<{
    id: string;
    name?: string;
    hotkeys?: unknown[];
  }>,
  registeredEvents: [] as string[],
  openedModals: [] as unknown[],
}));

vi.mock("obsidian", () => {
  interface FakeElOptions {
    cls?: string;
    text?: string;
    type?: string;
    placeholder?: string;
  }

  function makeFakeEl(): FakeEl {
    const children: FakeEl[] = [];
    const listeners: Record<string, Array<(event?: unknown) => void>> = {};
    const el: FakeEl = {
      textContent: "",
      value: "",
      cls: "",
      children,
      listeners,
      setText(text: string): void {
        el.textContent = text;
      },
      addClass(_cls: string): void {},
      empty(): void {
        children.length = 0;
      },
      createDiv(options?: FakeElOptions): FakeEl {
        return makeChild(options);
      },
      createEl(_tag: string, options?: FakeElOptions): FakeEl {
        return makeChild(options);
      },
      addEventListener(
        name: string,
        handler: (event?: unknown) => void,
      ): void {
        (listeners[name] ??= []).push(handler);
      },
    };
    function makeChild(options?: FakeElOptions): FakeEl {
      const child = makeFakeEl();
      if (options?.cls !== undefined) {
        (child as { cls?: string }).cls = options.cls;
      }
      if (options?.text !== undefined) {
        child.textContent = options.text;
      }
      children.push(child);
      return child;
    }
    return el;
  }

  class Plugin {
    app: unknown;
    manifest: unknown;

    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }

    registerView(_type: string, _viewCreator: unknown): void {}

    addCommand(command: {
      id: string;
      name?: string;
      hotkeys?: unknown[];
    }): { id: string; name?: string; hotkeys?: unknown[] } {
      state.registeredCommands.push({ ...command });
      return command;
    }

    registerEvent(ref: { name?: string }): { name?: string } {
      state.registeredEvents.push(ref.name ?? "unknown");
      return ref;
    }

    loadData(): Promise<unknown> {
      return Promise.resolve({});
    }
  }

  class ItemView {
    leaf: unknown;
    containerEl = makeFakeEl();

    constructor(leaf: unknown) {
      this.leaf = leaf;
    }
  }

  class WorkspaceLeaf {
    setViewState = (): void => {};
  }

  class Modal {
    titleEl = makeFakeEl();
    contentEl = makeFakeEl();
    app: unknown;

    constructor(app: unknown) {
      this.app = app;
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
      state.openedModals.push(this);
    }

    close(): void {}
  }

  return { Plugin, ItemView, WorkspaceLeaf, Modal };
});

interface FakeEl {
  textContent: string;
  value: string;
  cls: string;
  children: FakeEl[];
  listeners: Record<string, Array<(event?: unknown) => void>>;
  setText(text: string): void;
  addClass(cls: string): void;
  empty(): void;
  createDiv(options?: { cls?: string; text?: string }): FakeEl;
  createEl(
    tag: string,
    options?: { cls?: string; text?: string; type?: string; placeholder?: string },
  ): FakeEl;
  addEventListener(name: string, handler: (event?: unknown) => void): void;
}

function record(
  overrides: Partial<PaperRecord> = {},
): PaperRecord {
  return {
    path: "05 Literature/key/key.md",
    key: "key",
    paperId: "11111111-1111-4111-8111-111111111111",
    title: "A landmark study",
    authors: [{ family: "Zhang", given: "Wei" }, { literal: "Consortium" }],
    journal: "Nature Medicine",
    year: 2024,
    identifiers: { doi: "10.1038/s41591-024-00000-0", pmid: "39000000" },
    citationKeyAliases: [],
    titleAliases: [],
    ...overrides,
  };
}

function makePlugin(app: App): PaperNotesPlugin {
  const manifest = {
    id: "paper-notes",
    name: "Paper Notes",
    version: "1.0.0",
    minAppVersion: "1.4.0",
    description: "test fixture",
    isDesktopOnly: true,
  } as PluginManifest;
  return new PaperNotesPlugin(app, manifest);
}

function makeApp(): App {
  const vault = {
    on: (name: string): { name: string } => ({ name }),
    getMarkdownFiles: () => [],
    getAbstractFileByPath: () => null,
    cachedRead: async () => "",
  };
  const app = {
    vault,
    metadataCache: { getFileCache: () => undefined },
    workspace: {
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      revealLeaf: () => Promise.resolve(),
      activeEditor: { editor: null, view: null },
    },
  };
  return app as unknown as App;
}

function makeEditor(): CitationEditorPort & { content: string; calls: string[] } {
  let content = "";
  const calls: string[] = [];
  return {
    get content() {
      return content;
    },
    get calls() {
      return calls;
    },
    replaceSelection(text: string): void {
      calls.push(text);
      content = content + text;
    },
  };
}

function citationCommand(): { id: string; name?: string; hotkeys?: unknown[] } {
  const command = state.registeredCommands.find(
    (entry) => entry.id === INSERT_CITATION_COMMAND,
  );
  if (command === undefined) {
    throw new Error(`command ${INSERT_CITATION_COMMAND} not registered`);
  }
  return command;
}



describe("paper-notes-insert-citation command registration", () => {
  beforeEach(() => {
    state.registeredCommands.length = 0;
    state.registeredEvents.length = 0;
    state.openedModals.length = 0;
  });

  it("registers the command with a name and no hardcoded default hotkey", async () => {
    const plugin = makePlugin(makeApp());
    await plugin.onload();

    const command = citationCommand();
    expect(command.name).toBeDefined();
    expect(command.name!.length).toBeGreaterThan(0);
    expect(command.hotkeys).toBeUndefined();
  });

  it("registers only vault events, never an editor-typing/@ interceptor", async () => {
    const plugin = makePlugin(makeApp());
    await plugin.onload();

    expect(state.registeredEvents).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
    ]);
    expect(
      state.registeredEvents.some((name) => name.includes("editor")),
    ).toBe(false);
    expect(state.registeredCommands).toContainEqual(
      expect.objectContaining({ id: OPEN_LIBRARY_COMMAND }),
    );
  });

  it("opens the citation picker from the command callback with the active editor", async () => {
    const app = makeApp();
    const editor = makeEditor();
    (app.workspace as unknown as { activeEditor: { editor: unknown; view: unknown } }).activeEditor = {
      editor,
      view: null,
    };
    const plugin = makePlugin(app);
    await plugin.onload();

    (citationCommand() as { callback?: () => void }).callback?.();
    await vi.waitFor(() => {
      expect(state.openedModals).toHaveLength(1);
    });
  });
});

describe("searchCitationCandidates", () => {
  const records = [
    record(),
    record({
      key: "li2023",
      paperId: "22222222-2222-4222-8222-222222222222",
      title: "CRISPR screens in pancreatic organoids",
      authors: [{ family: "Li", given: "Min" }],
      journal: "Cell",
      year: 2023,
      identifiers: { doi: "10.1016/j.cell.2023.00000", pmid: "38000000" },
      citationKeyAliases: ["li2023-old", "liCell"],
      titleAliases: ["organoid crispr"],
    }),
    record({
      key: "wang2020",
      paperId: "33333333-3333-4333-8333-333333333333",
      title: "Lung adenocarcinoma evolution",
      authors: [{ family: "Wang", given: "Li" }],
      journal: "NEJM",
      year: 2020,
      identifiers: { doi: "10.1056/nejm2020.00000", pmid: "37000000" },
      citationKeyAliases: [],
      titleAliases: [],
    }),
  ];

  it("returns all records for an empty or whitespace query", () => {
    expect(searchCitationCandidates(records, "")).toHaveLength(3);
    expect(searchCitationCandidates(records, "   ")).toHaveLength(3);
  });

  it("matches the title case-insensitively and trims the query", () => {
    expect(searchCitationCandidates(records, "  LANDMARK  ").map((r) => r.key))
      .toEqual(["key"]);
    expect(searchCitationCandidates(records, "organoids")).toHaveLength(1);
  });

  it("matches an author family name", () => {
    expect(searchCitationCandidates(records, "zhang")).toEqual([
      expect.objectContaining({ key: "key" }),
    ]);
    expect(searchCitationCandidates(records, "li").map((r) => r.key)).toEqual([
      "li2023",
      "wang2020",
    ]);
  });

  it("matches a literal (group) author", () => {
    expect(searchCitationCandidates(records, "consortium")).toEqual([
      expect.objectContaining({ key: "key" }),
    ]);
  });

  it("matches the year", () => {
    expect(searchCitationCandidates(records, "2023").map((r) => r.key)).toEqual([
      "li2023",
    ]);
  });

  it("matches the journal", () => {
    expect(searchCitationCandidates(records, "nature medicine").map((r) => r.key))
      .toEqual(["key"]);
  });

  it("matches the DOI", () => {
    expect(
      searchCitationCandidates(records, "10.1016/j.cell.2023.00000").map(
        (r) => r.key,
      ),
    ).toEqual(["li2023"]);
  });

  it("matches the PMID", () => {
    expect(searchCitationCandidates(records, "37000000").map((r) => r.key))
      .toEqual(["wang2020"]);
  });

  it("matches the current citation key", () => {
    expect(searchCitationCandidates(records, "wang2020").map((r) => r.key))
      .toEqual(["wang2020"]);
  });

  it("matches a citation key alias", () => {
    expect(searchCitationCandidates(records, "liCell").map((r) => r.key))
      .toEqual(["li2023"]);
  });

  it("never matches the paper_id UUID (not a prose field)", () => {
    expect(
      searchCitationCandidates(records, "22222222-2222-4222-8222-222222222222"),
    ).toEqual([]);
  });

  it("returns no results for an unknown query", () => {
    expect(searchCitationCandidates(records, "zzz-not-there")).toEqual([]);
  });
});

describe("citationLabelOf", () => {
  it("shows title, first author, year and journal", () => {
    const label = citationLabelOf(record());
    expect(label).toContain("A landmark study");
    expect(label).toContain("Zhang");
    expect(label).toContain("2024");
    expect(label).toContain("Nature Medicine");
  });

  it("falls back to the given name for authors without a family name", () => {
    const label = citationLabelOf(
      record({ authors: [{ given: "Ada", family: undefined }] }),
    );
    expect(label).toContain("Ada");
  });

  it("still renders when author/year/journal are missing", () => {
    const label = citationLabelOf(
      record({ authors: [], year: undefined, journal: undefined }),
    );
    expect(label).toContain("A landmark study");
    expect(label).not.toContain("undefined");
  });

  it("never includes the paper_id", () => {
    expect(citationLabelOf(record())).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});

describe("buildCitationText and selection order", () => {
  const first = record();
  const second = record({
    key: "li2023",
    paperId: "22222222-2222-4222-8222-222222222222",
    title: "CRISPR screens in pancreatic organoids",
  });

  it("inserts a single citation as [@key]", () => {
    expect(buildCitationText([first])).toBe("[@key]");
  });

  it("inserts multiple citations as [@key1; @key2] in selection order", () => {
    expect(buildCitationText([second, first])).toBe("[@li2023; @key]");
  });

  it("returns an empty string for an empty selection", () => {
    expect(buildCitationText([])).toBe("");
  });

  it("never includes paper_id in the citation text", () => {
    expect(buildCitationText([first])).not.toContain(first.paperId);
  });

  it("toggles a record out of the selection without losing order", () => {
    const third = record({
      key: "wang2020",
      paperId: "33333333-3333-4333-8333-333333333333",
    });
    let selected = toggleCitationSelection([], second);
    selected = toggleCitationSelection(selected, first);
    selected = toggleCitationSelection(selected, third);
    expect(selected.map((r) => r.key)).toEqual(["li2023", "key", "wang2020"]);
    selected = toggleCitationSelection(selected, second);
    expect(selected.map((r) => r.key)).toEqual(["key", "wang2020"]);
    expect(buildCitationText(selected)).toBe("[@key; @wang2020]");
  });
});

describe("insertCitation", () => {
  const first = record();

  it("inserts at the editor cursor when nothing is selected", () => {
    const editor = makeEditor();
    const text = insertCitation(editor, [first]);
    expect(text).toBe("[@key]");
    expect(editor.calls).toEqual(["[@key]"]);
  });

  it("replaces the active selection via the editor contract", () => {
    const editor = makeEditor();
    editor.replaceSelection("stale [@old] selection");
    insertCitation(editor, [first]);
    expect(editor.calls[editor.calls.length - 1]).toBe("[@key]");
  });

  it("is a no-op for an empty selection", () => {
    const editor = makeEditor();
    expect(insertCitation(editor, [])).toBe("");
    expect(editor.calls).toEqual([]);
  });
});

describe("alias search inserts the current key", () => {
  it("resolves an alias to the record and inserts its current key", () => {
    const records = [
      record({
        key: "li2023",
        paperId: "22222222-2222-4222-8222-222222222222",
        citationKeyAliases: ["old-cite-key"],
      }),
    ];
    const found = searchCitationCandidates(records, "old-cite-key");
    expect(found).toHaveLength(1);
    const editor = makeEditor();
    insertCitation(editor, found);
    expect(editor.calls).toEqual(["[@li2023]"]);
  });
});

describe("citation picker modal", () => {
  const first = record();
  const second = record({
    key: "li2023",
    paperId: "22222222-2222-4222-8222-222222222222",
    title: "CRISPR screens in pancreatic organoids",
    authors: [{ family: "Li", given: "Min" }],
    journal: "Cell",
    year: 2023,
  });
  const records = [first, second];

  async function openPicker(onPick: (selected: PaperRecord[]) => void) {
    const app = makeApp();
    const modal = await createCitationPickerModal(app, {
      search: (query) => searchCitationCandidates(records, query),
      onPick,
    });
    modal.open();
    return modal;
  }

  function inputEl(modal: { contentEl: HTMLElement }): FakeEl {
    const input = (modal.contentEl as unknown as FakeEl).children.find(
      (child) => child.cls === "paper-notes-citation-input",
    );
    if (input === undefined) {
      throw new Error("modal search input not rendered");
    }
    return input;
  }

  function rows(modal: { contentEl: HTMLElement }): FakeEl[] {
    const results = (modal.contentEl as unknown as FakeEl).children.find(
      (child) => child.cls === "paper-notes-citation-results",
    );
    return results === undefined ? [] : results.children;
  }

  function insertButton(modal: { contentEl: HTMLElement }): FakeEl {
    const actions = (modal.contentEl as unknown as FakeEl).children.find(
      (child) => child.cls === "paper-notes-modal-actions",
    );
    const button = actions?.children.find(
      (child) => child.textContent === "Insert",
    );
    if (button === undefined) {
      throw new Error("Insert button not rendered");
    }
    return button;
  }

  it("renders one labelled row per search result", async () => {
    const modal = await openPicker(() => {});
    inputEl(modal).value = "crispr";
    inputEl(modal).listeners["input"]?.forEach((handler) => handler());

    expect(rows(modal)).toHaveLength(1);
    expect(rows(modal)[0].textContent).toContain("CRISPR screens");
    expect(rows(modal)[0].textContent).toContain("Li");
    expect(rows(modal)[0].textContent).toContain("2023");
    expect(rows(modal)[0].textContent).toContain("Cell");
  });

  it("delivers selections in click order and inserts [@key1; @key2]", async () => {
    const app = makeApp();
    const editor = makeEditor();
    (app.workspace as unknown as { activeEditor: { editor: unknown; view: unknown } }).activeEditor = {
      editor,
      view: null,
    };
    const onPick = vi.fn((selected: PaperRecord[]) => {
      insertCitation(editor, selected);
    });
    const modal = await createCitationPickerModal(app, {
      search: (query) => searchCitationCandidates(records, query),
      onPick,
    });
    modal.open();

    const [row1, row2] = rows(modal);
    row2.listeners["click"]?.forEach((handler) => handler());
    row1.listeners["click"]?.forEach((handler) => handler());
    insertButton(modal).listeners["click"]?.forEach((handler) => handler());

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].map((r: PaperRecord) => r.key)).toEqual([
      "li2023",
      "key",
    ]);
    expect(editor.calls[editor.calls.length - 1]).toBe("[@li2023; @key]");
  });

  it("inserts on Enter and never auto-activates while typing @", async () => {
    const onPick = vi.fn();
    const modal = await openPicker(onPick);
    inputEl(modal).value = "@";
    inputEl(modal).listeners["input"]?.forEach((handler) => handler());
    // Typing @ is plain text input: the picker itself only reacts to the
    // explicit Enter key, never to the content of what is typed.
    expect(onPick).not.toHaveBeenCalled();

    inputEl(modal).value = "crispr";
    inputEl(modal).listeners["input"]?.forEach((handler) => handler());
    rows(modal)[0].listeners["click"]?.forEach((handler) => handler());
    inputEl(modal).listeners["keydown"]?.forEach((handler) =>
      handler({ key: "Enter", preventDefault: () => {} }),
    );
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].map((r: PaperRecord) => r.key)).toEqual([
      "li2023",
    ]);
  });

  it("does not pick when the selection is empty", async () => {
    const onPick = vi.fn();
    const modal = await openPicker(onPick);
    inputEl(modal).value = "crispr";
    inputEl(modal).listeners["input"]?.forEach((handler) => handler());
    insertButton(modal).listeners["click"]?.forEach((handler) => handler());

    expect(onPick).not.toHaveBeenCalled();
  });
});
