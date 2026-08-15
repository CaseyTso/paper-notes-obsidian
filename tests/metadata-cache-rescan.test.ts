/**
 * Metadata-cache readiness rescan (Repair: Gate D R2).
 *
 * Gate D R2 root cause: `initializeLibraryIndex()` runs `scanAll()`
 * synchronously during `onload()`, but Obsidian builds the metadata cache
 * asynchronously — `getFileCache()` commonly returns undefined at that
 * moment, so every canonical note is marked `missing_frontmatter` and no
 * event ever re-checks (invalid state persists until the file is touched).
 *
 * The fix registers a `metadataCache.on("resolved", ...)` listener (the
 * all-files-resolved signal, re-fired on later modifications; the callback
 * takes no file argument in the Obsidian 1.13 API) and schedules a debounced
 * idempotent rescan, then refreshes any open library view. These tests drive
 * the plugin through a mocked MetadataCache whose `resolved` handlers are
 * captured by the mock and fired by the tests:
 *
 * - cache not ready  -> initial scanAll -> canonical note invalid
 * - cache resolves   -> "resolved" fires -> rescan -> note valid
 * - open library view is refreshed after the rescan
 * - a burst of resolved signals coalesces into one debounced rescan
 * - the rescan is skipped while the index is already healthy
 * - onunload cancels a pending rescan
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { App, PluginManifest } from "obsidian";

import PaperNotesPlugin, {
  METADATA_RESCAN_DEBOUNCE_MS,
} from "../src/main";
import type { PaperNotesLibraryView } from "../src/views/literature-library-view";

const MAIN_PATH = "05 Literature/key/key.md";

const state = vi.hoisted(() => ({
  registeredEvents: [] as string[],
  resolvedHandlers: [] as Array<() => void>,
  viewCreator: null as null | ((leaf: unknown) => unknown),
}));

vi.mock("obsidian", () => {
  function makeFakeEl(): {
    empty(): void;
    createEl(_tag: string, _opts?: unknown): unknown;
  } {
    return {
      empty: () => {},
      createEl: () => ({}),
    };
  }

  class Plugin {
    app: unknown;
    manifest: unknown;

    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }

    registerView(_type: string, viewCreator: (leaf: unknown) => unknown): void {
      state.viewCreator = viewCreator;
    }

    addCommand(): { id: string } {
      return { id: "" };
    }

    addSettingTab(_tab: unknown): void {}

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
    open(): void {}
    close(): void {}
  }

  class Notice {
    constructor(_message: string) {}
  }

  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: { empty: () => void };
    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = { empty: () => {} };
    }
    display(): void {}
  }

  class Setting {
    constructor(_containerEl: unknown) {}
    setName(_name: string): this {
      return this;
    }
    setDesc(_desc: string): this {
      return this;
    }
    setHeading(): this {
      return this;
    }
    addText(_cb: (text: unknown) => void): this {
      return this;
    }
    addDropdown(_cb: (dropdown: unknown) => void): this {
      return this;
    }
    addToggle(_cb: (toggle: unknown) => void): this {
      return this;
    }
  }

  return { Plugin, ItemView, WorkspaceLeaf, Modal, Notice, PluginSettingTab, Setting };
});

function validFrontmatter(): Record<string, unknown> {
  return {
    schema_version: 1,
    paper_id: "11111111-1111-4111-8111-111111111111",
    citation_key: "key",
    title: "A landmark study",
    authors: [{ family: "Zhang", given: "Wei" }],
  };
}

function makeApp(frontmatter: Record<string, unknown> | undefined): App {
  const metadataCache = {
    frontmatter,
    getFileCache: (_file: { path: string }) =>
      metadataCache.frontmatter === undefined
        ? undefined
        : { frontmatter: metadataCache.frontmatter },
    on: (name: string, handler: () => void) => {
      if (name === "resolved") {
        state.resolvedHandlers.push(handler);
      }
      return { name };
    },
  };
  const vault = {
    getMarkdownFiles: () => [{ path: MAIN_PATH }],
    getAbstractFileByPath: (path: string) =>
      path === MAIN_PATH ? { path: MAIN_PATH } : null,
    cachedRead: async () => "",
    on: (name: string): { name: string } => ({ name }),
  };
  const app = {
    vault,
    metadataCache,
    workspace: {
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      revealLeaf: () => Promise.resolve(),
      activeEditor: { editor: null, view: null },
    },
  };
  return app as unknown as App;
}

function setFrontmatter(
  app: App,
  frontmatter: Record<string, unknown> | undefined,
): void {
  (app.metadataCache as unknown as { frontmatter: unknown }).frontmatter =
    frontmatter;
}

function fireResolved(): void {
  for (const handler of state.resolvedHandlers) {
    handler();
  }
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

describe("metadata cache readiness rescan (Gate D R2)", () => {
  beforeEach(() => {
    state.registeredEvents.length = 0;
    state.resolvedHandlers.length = 0;
    state.viewCreator = null;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers a metadataCache resolved listener alongside vault events", async () => {
    const plugin = makePlugin(makeApp(undefined));
    await plugin.onload();

    expect(state.registeredEvents).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
      "resolved",
    ]);
  });

  it("marks canonical notes invalid when the metadata cache is not ready", async () => {
    const plugin = makePlugin(makeApp(undefined));
    await plugin.onload();

    const index = plugin.getLibraryIndex()!;
    expect(index.getRecords()).toEqual([]);
    expect(index.getInvalidRecords()).toEqual([
      { path: MAIN_PATH, reasons: ["missing_frontmatter"] },
    ]);
  });

  it("rescans and flips the note to valid once the cache resolves", async () => {
    const app = makeApp(undefined);
    const plugin = makePlugin(app);
    await plugin.onload();
    expect(plugin.getLibraryIndex()!.getInvalidRecords()).toHaveLength(1);

    setFrontmatter(app, validFrontmatter());
    vi.useFakeTimers();
    fireResolved();
    await vi.advanceTimersByTimeAsync(METADATA_RESCAN_DEBOUNCE_MS + 50);
    vi.useRealTimers();

    const index = plugin.getLibraryIndex()!;
    expect(index.getRecords()).toHaveLength(1);
    expect(index.getRecords()[0]!.key).toBe("key");
    expect(index.getInvalidRecords()).toEqual([]);
  });

  it("refreshes an open library view after the rescan", async () => {
    const app = makeApp(undefined);
    const plugin = makePlugin(app);
    await plugin.onload();
    expect(state.viewCreator).not.toBeNull();

    const view = state.viewCreator!({}) as PaperNotesLibraryView;
    const refreshSpy = vi.spyOn(view, "refresh");

    setFrontmatter(app, validFrontmatter());
    vi.useFakeTimers();
    fireResolved();
    await vi.advanceTimersByTimeAsync(METADATA_RESCAN_DEBOUNCE_MS + 50);
    vi.useRealTimers();

    expect(refreshSpy).toHaveBeenCalled();
  });

  it("coalesces a burst of resolved signals into one debounced rescan", async () => {
    const plugin = makePlugin(makeApp(undefined));
    await plugin.onload();
    const index = plugin.getLibraryIndex()!;
    const scanSpy = vi.spyOn(index, "scanAll");

    vi.useFakeTimers();
    fireResolved();
    fireResolved();
    fireResolved();
    await vi.advanceTimersByTimeAsync(METADATA_RESCAN_DEBOUNCE_MS + 50);
    vi.useRealTimers();

    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the rescan while the index is already healthy", async () => {
    const plugin = makePlugin(makeApp(validFrontmatter()));
    await plugin.onload();
    const index = plugin.getLibraryIndex()!;
    const scanSpy = vi.spyOn(index, "scanAll");

    vi.useFakeTimers();
    fireResolved();
    await vi.advanceTimersByTimeAsync(METADATA_RESCAN_DEBOUNCE_MS + 50);
    vi.useRealTimers();

    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("cancels a pending rescan on unload", async () => {
    const plugin = makePlugin(makeApp(undefined));
    await plugin.onload();
    const index = plugin.getLibraryIndex()!;
    const scanSpy = vi.spyOn(index, "scanAll");

    vi.useFakeTimers();
    fireResolved();
    await plugin.onunload();
    await vi.advanceTimersByTimeAsync(METADATA_RESCAN_DEBOUNCE_MS + 50);
    vi.useRealTimers();

    expect(scanSpy).not.toHaveBeenCalled();
  });
});