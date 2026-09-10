import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
vi.mock("obsidian", () => import("./obsidian.mock"));
import PaperNotesPlugin from "../src/main";
import { PaperNotesLibraryView, VIEW_TYPE_PAPER_NOTES } from "../src/views/literature-library-view";
import { PaperNotesMocView, VIEW_TYPE_TOPIC_MOC } from "../src/views/topic-moc-view";
import type { MocDirectorySource } from "../src/components/moc-directory";
import { DEFAULT_SETTINGS } from "../src/settings";

function pluginFor(app: unknown): PaperNotesPlugin {
  const plugin = new PaperNotesPlugin(app as App, { id: "paper-notes" } as PluginManifest);
  plugin.settings = { ...DEFAULT_SETTINGS, literatureRoot: "Custom" };
  return plugin;
}
function sourceOf(plugin: PaperNotesPlugin): MocDirectorySource {
  return (plugin as unknown as { createMocViewSource(): MocDirectorySource }).createMocViewSource();
}

describe("MOC plugin compatibility wiring", () => {
  it("routes the public legacy entry into an existing Library page without another content leaf", async () => {
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const showPage = vi.spyOn(view, "showPage");
    const leaf = { view, setViewState: vi.fn() };
    const workspace = {
      getLeavesOfType: vi.fn(() => [leaf]),
      getRightLeaf: vi.fn(), getLeaf: vi.fn(), revealLeaf: vi.fn(async () => {}),
    };
    await pluginFor({ workspace }).activateMocView();
    expect(workspace.getLeavesOfType).toHaveBeenCalledExactlyOnceWith(VIEW_TYPE_PAPER_NOTES);
    expect(showPage).toHaveBeenCalledWith("moc");
    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });
  it("resolves deferred Library leaves via revealLeaf and loadIfDeferred before choosing page", async () => {
    const realView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const showPage = vi.spyOn(realView, "showPage");
    const deferredView = { getViewType: () => VIEW_TYPE_PAPER_NOTES };
    const callOrder: string[] = [];
    const leaf = {
      view: deferredView as unknown as PaperNotesLibraryView,
      isDeferred: true,
      loadIfDeferred: vi.fn(async () => {
        callOrder.push("loadIfDeferred");
        leaf.view = realView;
        leaf.isDeferred = false;
      }),
      setViewState: vi.fn(),
    };
    const workspace = {
      getLeavesOfType: vi.fn(() => [leaf]),
      getRightLeaf: vi.fn(),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {
        callOrder.push("revealLeaf");
      }),
    };
    showPage.mockImplementation(() => {
      callOrder.push("showPage");
    });
    await pluginFor({ workspace }).activateMocView();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(leaf.loadIfDeferred).toHaveBeenCalledOnce();
    expect(showPage).toHaveBeenCalledWith("moc");
    expect(callOrder).toEqual(["revealLeaf", "loadIfDeferred", "showPage"]);
  });
  it("restores saved legacy MOC leaf by routing to activateMocView and detaching after deferred leaf resolves", async () => {
    const realView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const showPage = vi.spyOn(realView, "showPage");
    const deferredView = { getViewType: () => VIEW_TYPE_PAPER_NOTES };
    const libraryLeaf = {
      view: deferredView as unknown as PaperNotesLibraryView,
      isDeferred: true,
      loadIfDeferred: vi.fn(async () => {
        libraryLeaf.view = realView;
        libraryLeaf.isDeferred = false;
      }),
      setViewState: vi.fn(),
    };
    const legacyLeaf = {
      detach: vi.fn(),
    };
    const workspace = {
      getLeavesOfType: vi.fn((type: string) => (type === VIEW_TYPE_PAPER_NOTES ? [libraryLeaf] : [])),
      getRightLeaf: vi.fn(),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };
    const plugin = pluginFor({ workspace });
    const legacyView = new PaperNotesMocView(legacyLeaf as unknown as WorkspaceLeaf, () => plugin.activateMocView());
    expect(legacyView.getViewType()).toBe(VIEW_TYPE_TOPIC_MOC);
    await legacyView.onOpen();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(libraryLeaf);
    expect(libraryLeaf.loadIfDeferred).toHaveBeenCalledOnce();
    expect(showPage).toHaveBeenCalledWith("moc");
    expect(legacyLeaf.detach).toHaveBeenCalledOnce();
  });
  it("opens only the Library with internal page state when no Library exists", async () => {
    const leaf = { setViewState: vi.fn(async () => {}) };
    const workspace = {
      getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => leaf),
      getLeaf: vi.fn(), revealLeaf: vi.fn(async () => {}),
    };
    await pluginFor({ workspace }).activateMocView();
    expect(leaf.setViewState).toHaveBeenCalledExactlyOnceWith({ type: VIEW_TYPE_PAPER_NOTES, active: true, state: { page: "moc" } });
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });
  it("lists only direct Markdown children under the current configured root", () => {
    const paths = ["Custom/MOCs/a.md", "Custom/MOCs/nested/a.md", "Other/MOCs/b.md", "Custom/MOCs-extra/c.md"];
    const plugin = pluginFor({ vault: { getMarkdownFiles: () => paths.map((path) => ({ path, name: path.split("/").pop() })) } });
    const source = sourceOf(plugin);
    expect(source.listMarkdownFiles(`${source.literatureRoot}/MOCs`)).toEqual(["a.md"]);
    plugin.settings.literatureRoot = "Other";
    expect(source.listMarkdownFiles(`${source.literatureRoot}/MOCs`)).toEqual(["b.md"]);
  });
  it("tolerates delete/rename between listing and reading but surfaces real read failures", async () => {
    const file = { path: "Custom/MOCs/a.md", extension: "md" };
    const vault = {
      getAbstractFileByPath: vi.fn().mockReturnValueOnce(file).mockReturnValueOnce(null),
      cachedRead: vi.fn().mockRejectedValue(new Error("read failed")),
    };
    const source = sourceOf(pluginFor({ vault }));
    expect(await source.readText(file.path)).toBe("");
    vault.getAbstractFileByPath.mockReturnValue(file);
    await expect(source.readText(file.path)).rejects.toThrow("read failed");
    vault.getAbstractFileByPath.mockReturnValue(null);
    expect(await source.readText(file.path)).toBe("");
  });
});

describe("Library activation and ribbon wiring", () => {
  it("registers exactly one ribbon icon on load and callback opens the library", async () => {
    const ribbonIcons: Array<{ icon: string; title: string; callback: () => void }> = [];
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => ({ setViewState: vi.fn(async () => {}) })),
      revealLeaf: vi.fn(async () => {}),
      getRightLeaf: vi.fn(),
    };
    const plugin = pluginFor({ workspace });
    plugin.addRibbonIcon = (icon: string, title: string, callback: (evt: MouseEvent) => any) => {
      ribbonIcons.push({ icon, title, callback: () => callback({} as MouseEvent) });
      return {} as HTMLElement;
    };
    const activateSpy = vi.spyOn(plugin, "activateLibraryView");

    await plugin.onload();

    expect(ribbonIcons).toHaveLength(1);
    expect(ribbonIcons[0].icon).toBe("library");
    expect(ribbonIcons[0].title).toBe("Open literature library");

    ribbonIcons[0].callback();
    expect(activateSpy).toHaveBeenCalledOnce();
  });

  it("creates a central leaf when no leaf exists without using getRightLeaf or getLeaf(false)", async () => {
    const freshLeaf = {
      setViewState: vi.fn(async () => {}),
    };
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => freshLeaf),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };
    const plugin = pluginFor({ workspace });

    await plugin.activateLibraryView();

    expect(workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(true);
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(freshLeaf.setViewState).toHaveBeenCalledExactlyOnceWith({
      type: VIEW_TYPE_PAPER_NOTES,
      active: true,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledExactlyOnceWith(freshLeaf);
  });

  it("reuses an existing central leaf and switches to library page without creating a new leaf", async () => {
    const rootSplit = {};
    const view = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const showPage = vi.spyOn(view, "showPage");
    const centralLeaf = {
      view,
      parent: rootSplit,
      getRoot: vi.fn(() => rootSplit),
      setViewState: vi.fn(),
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => [centralLeaf]),
      getLeaf: vi.fn(),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };
    const plugin = pluginFor({ workspace });

    await plugin.activateLibraryView();

    expect(workspace.getLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_PAPER_NOTES);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(centralLeaf.setViewState).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(centralLeaf);
    expect(showPage).toHaveBeenCalledWith("library");
  });

  it("migrates a right sidebar leaf to the central workspace, preserves view state, and detaches old leaf", async () => {
    const rootSplit = { id: "rootSplit" };
    const rightSplit = { id: "rightSplit" };

    const oldView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    await oldView.setState(
      {
        page: "library",
        searchQuery: "einstein",
        filters: { journal: "Physical Review", requiredArtifacts: ["pdf"] },
        sort: { columnId: "journal", direction: "asc" },
        selectedPath: "papers/einstein.md",
        drawerOpen: true,
      },
      { history: false },
    );

    const oldLeaf = {
      view: oldView,
      parent: rightSplit,
      getRoot: vi.fn(() => rightSplit),
      getViewState: vi.fn(() => ({
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: oldView.getState(),
      })),
      detach: vi.fn(),
      setViewState: vi.fn(),
    };

    const newView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const newShowPage = vi.spyOn(newView, "showPage");
    const newLeaf = {
      view: newView,
      parent: rootSplit,
      getRoot: vi.fn(() => rootSplit),
      setViewState: vi.fn(async (vs: { state?: Record<string, unknown> }) => {
        if (vs.state) {
          await newView.setState(vs.state, { history: false });
        }
      }),
      detach: vi.fn(),
    };

    const workspace = {
      rootSplit,
      rightSplit,
      getLeavesOfType: vi.fn(() => [oldLeaf]),
      getLeaf: vi.fn((newTab: unknown) => {
        expect(newTab).toBe(true);
        return newLeaf;
      }),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };

    const plugin = pluginFor({ workspace });
    await plugin.activateLibraryView();

    // Leaf created in center (getLeaf(true)), never via getRightLeaf
    expect(workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();

    // Old view state transferred to new leaf via setViewState
    expect(newLeaf.setViewState).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: expect.objectContaining({
          page: "library",
          searchQuery: "einstein",
          filters: { journal: "Physical Review", requiredArtifacts: ["pdf"] },
          sort: { columnId: "journal", direction: "asc" },
          selectedPath: "papers/einstein.md",
          drawerOpen: true,
        }),
      }),
    );
    expect(newShowPage).toHaveBeenCalledWith("library");

    // All state preserved on new view via public getState
    expect(newView.getState()).toEqual({
      page: "library",
      searchQuery: "einstein",
      filters: { journal: "Physical Review", requiredArtifacts: ["pdf"] },
      sort: { columnId: "journal", direction: "asc" },
      selectedPath: "papers/einstein.md",
      drawerOpen: true,
    });

    // Old leaf detached
    expect(oldLeaf.detach).toHaveBeenCalledOnce();

    // Final leaf is in rootSplit and NOT in rightSplit
    expect(newLeaf.getRoot()).toBe(rootSplit);
    expect(newLeaf.getRoot()).not.toBe(rightSplit);
    expect(newLeaf.parent).not.toBe(rightSplit);
  });

  it("migrates a sidebar leaf with MOC page, preserves search query, and routes to MOC", async () => {
    const rootSplit = { id: "rootSplit" };
    const rightSplit = { id: "rightSplit" };

    const oldView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    await oldView.setState(
      {
        page: "moc",
        searchQuery: "quantum",
      },
      { history: false },
    );

    const oldLeaf = {
      view: oldView,
      parent: rightSplit,
      getRoot: vi.fn(() => rightSplit),
      getViewState: vi.fn(() => ({
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: oldView.getState(),
      })),
      detach: vi.fn(),
      setViewState: vi.fn(),
    };

    const newView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const newShowPage = vi.spyOn(newView, "showPage");
    const newLeaf = {
      view: newView,
      parent: rootSplit,
      getRoot: vi.fn(() => rootSplit),
      setViewState: vi.fn(async (vs: { state?: Record<string, unknown> }) => {
        if (vs.state) {
          await newView.setState(vs.state, { history: false });
        }
      }),
      detach: vi.fn(),
    };

    const workspace = {
      rootSplit,
      rightSplit,
      getLeavesOfType: vi.fn(() => [oldLeaf]),
      getLeaf: vi.fn(() => newLeaf),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };

    const plugin = pluginFor({ workspace });
    await plugin.activateLibraryView();

    expect(newShowPage).toHaveBeenCalledWith("moc");
    expect(newView.getState()).toEqual(
      expect.objectContaining({
        page: "moc",
        searchQuery: "quantum",
        drawerOpen: false,
      }),
    );
    expect(oldLeaf.detach).toHaveBeenCalledOnce();
  });

  it("migrates a sidebar leaf when drawerOpen is true but selectedPath is missing without opening drawer", async () => {
    const rootSplit = { id: "rootSplit" };
    const rightSplit = { id: "rightSplit" };

    const oldLeaf = {
      view: {},
      parent: rightSplit,
      getRoot: vi.fn(() => rightSplit),
      getViewState: vi.fn(() => ({
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: {
          page: "library",
          searchQuery: "curie",
          drawerOpen: true,
        },
      })),
      detach: vi.fn(),
      setViewState: vi.fn(),
    };

    const newView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const newLeaf = {
      view: newView,
      parent: rootSplit,
      getRoot: vi.fn(() => rootSplit),
      setViewState: vi.fn(async (vs: { state?: Record<string, unknown> }) => {
        if (vs.state) {
          await newView.setState(vs.state, { history: false });
        }
      }),
      detach: vi.fn(),
    };

    const workspace = {
      rootSplit,
      rightSplit,
      getLeavesOfType: vi.fn(() => [oldLeaf]),
      getLeaf: vi.fn(() => newLeaf),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };

    const plugin = pluginFor({ workspace });
    await plugin.activateLibraryView();

    expect(newView.getState()).toEqual(
      expect.objectContaining({
        page: "library",
        searchQuery: "curie",
        drawerOpen: false,
        selectedPath: null,
      }),
    );
    expect(oldLeaf.detach).toHaveBeenCalledOnce();
  });

  it("falls back safely when sidebar leaf view is not a PaperNotesLibraryView", async () => {
    const rootSplit = { id: "rootSplit" };
    const rightSplit = { id: "rightSplit" };

    const oldLeaf = {
      view: {},
      parent: rightSplit,
      getRoot: vi.fn(() => rightSplit),
      getViewState: vi.fn(() => ({
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: { page: "moc" },
      })),
      detach: vi.fn(),
      setViewState: vi.fn(),
    };

    const newView = new PaperNotesLibraryView({} as WorkspaceLeaf, {} as never);
    const newLeaf = {
      view: newView,
      parent: rootSplit,
      getRoot: vi.fn(() => rootSplit),
      setViewState: vi.fn(async (vs: { state?: Record<string, unknown> }) => {
        if (vs.state) {
          await newView.setState(vs.state, { history: false });
        }
      }),
      detach: vi.fn(),
    };

    const workspace = {
      rootSplit,
      rightSplit,
      getLeavesOfType: vi.fn(() => [oldLeaf]),
      getLeaf: vi.fn(() => newLeaf),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
    };

    const plugin = pluginFor({ workspace });
    await plugin.activateLibraryView();

    expect(newView.getState().page).toBe("moc");
    expect(oldLeaf.detach).toHaveBeenCalledOnce();
  });
});
