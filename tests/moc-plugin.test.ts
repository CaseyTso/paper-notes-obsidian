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
