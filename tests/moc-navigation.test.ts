import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { openMocNote } from "../src/services/moc-navigation";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
const root = {};
function leaf(type: string, location = root, parent = {}): WorkspaceLeaf {
  return {
    view: { getViewType: () => type }, parent,
    getRoot: () => location, openFile: vi.fn(async () => {}),
  } as unknown as WorkspaceLeaf;
}
function setup(): { app: App; plugin: WorkspaceLeaf; editor: WorkspaceLeaf; fresh: WorkspaceLeaf; workspace: ReturnType<typeof workspaceOf> } {
  const plugin = leaf("paper-notes-open-library", {});
  const editor = leaf("markdown");
  const fresh = leaf("empty");
  const workspace = workspaceOf(plugin, editor, fresh);
  const app = { vault: { getAbstractFileByPath: vi.fn(() => ({ path: "MOCs/theme.md", extension: "md" })) }, workspace } as unknown as App;
  return { app, plugin, editor, fresh, workspace };
}
function workspaceOf(plugin: WorkspaceLeaf, editor: WorkspaceLeaf, fresh: WorkspaceLeaf) {
  return {
    rootSplit: root,
    getLeavesOfType: vi.fn(() => [plugin]),
    getMostRecentLeaf: vi.fn((): WorkspaceLeaf | null => editor),
    iterateRootLeaves: vi.fn((callback: (leaf: WorkspaceLeaf) => void) => { callback(editor); }),
    setActiveLeaf: vi.fn(),
    getLeaf: vi.fn(() => fresh),
    createLeafBySplit: vi.fn(() => fresh),
  };
}

beforeEach(() => { notices.length = 0; });
describe("native MOC navigation", () => {
  it("normal activation reuses the main editing leaf, not the plugin leaf", async () => {
    const { app, plugin, editor, workspace } = setup();
    await openMocNote(app, "MOCs/theme.md", false);
    expect(editor.openFile).toHaveBeenCalledWith(expect.objectContaining({ extension: "md" }), { active: true });
    expect(plugin.openFile).not.toHaveBeenCalled();
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });
  it("modifier activation creates a new main tab", async () => {
    const { app, plugin, editor, fresh, workspace } = setup();
    await openMocNote(app, "MOCs/theme.md", true);
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(editor, { focus: false });
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(fresh.openFile).toHaveBeenCalledOnce();
    expect(editor.openFile).not.toHaveBeenCalled();
    expect(plugin.openFile).not.toHaveBeenCalled();
  });
  it("ignores a most-recent plugin/sidebar leaf and finds the main editor", async () => {
    const { app, plugin, editor, workspace } = setup();
    workspace.getMostRecentLeaf.mockReturnValue(plugin);
    await openMocNote(app, "MOCs/theme.md", false);
    expect(editor.openFile).toHaveBeenCalledOnce();
    expect(plugin.openFile).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves a plugin moved into the main area, even with an editor tab in its group (%s)", async (newTab) => {
    const { app, fresh, workspace } = setup();
    const parent = {};
    const plugin = leaf("paper-notes-open-library", root, parent);
    const sameGroupEditor = leaf("markdown", root, parent);
    workspace.getLeavesOfType.mockReturnValue([plugin]);
    workspace.getMostRecentLeaf.mockReturnValue(sameGroupEditor);
    workspace.iterateRootLeaves.mockImplementation((callback) => { callback(sameGroupEditor); callback(plugin); });
    await openMocNote(app, "MOCs/theme.md", newTab);
    expect(workspace.createLeafBySplit).toHaveBeenCalledWith(plugin, "vertical");
    expect(fresh.openFile).toHaveBeenCalledOnce();
    expect(plugin.openFile).not.toHaveBeenCalled();
    expect(sameGroupEditor.openFile).not.toHaveBeenCalled();
  });
  it("creates a main tab in an empty workspace", async () => {
    const { app, workspace, fresh } = setup();
    workspace.getMostRecentLeaf.mockReturnValue(null);
    workspace.iterateRootLeaves.mockImplementation(() => {});
    await openMocNote(app, "MOCs/theme.md", false);
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(fresh.openFile).toHaveBeenCalledOnce();
  });
  it.each([null, { path: "MOCs/theme.md" }, { extension: "pdf" }])("does not create phantom files for a missing/non-Markdown target (%j)", async (file) => {
    const { app, workspace, editor } = setup();
    vi.mocked(app.vault.getAbstractFileByPath).mockReturnValue(file as never);
    await openMocNote(app, "MOCs/theme.md", false);
    expect(notices.join()).toContain("找不到笔记");
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(editor.openFile).not.toHaveBeenCalled();
  });
  it("does nothing after page lifetime cancellation", async () => {
    const { app, editor } = setup();
    const controller = new AbortController();
    controller.abort();
    await openMocNote(app, "MOCs/theme.md", false, controller.signal);
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(editor.openFile).not.toHaveBeenCalled();
  });
});
