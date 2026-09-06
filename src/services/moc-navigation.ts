import { Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";

/** Open only an existing Markdown file, never a plugin/sidebar leaf or a phantom link. */
export async function openMocNote(
  app: App,
  path: string,
  newTab: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !("extension" in file) || file.extension !== "md") {
    new Notice(`找不到笔记：${path}。请等待文件同步后刷新。`);
    return;
  }
  const workspace = app.workspace;
  const pluginLeaves = workspace.getLeavesOfType("paper-notes-open-library")
    .filter((candidate) => candidate.getRoot() === workspace.rootSplit);
  const isEditor = (leaf: WorkspaceLeaf): boolean =>
    leaf.getRoot() === workspace.rootSplit &&
    ["markdown", "empty"].includes(leaf.view.getViewType()) &&
    !pluginLeaves.some((plugin) => plugin.parent === leaf.parent);
  let leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
  if (!leaf || !isEditor(leaf)) {
    leaf = null;
    workspace.iterateRootLeaves((candidate) => {
      if (!leaf && isEditor(candidate)) leaf = candidate;
    });
  }
  // If the plugin was moved into the main area, keep its directory visible:
  // a new tab in its own group would hide it. Split that group instead.
  const pluginLeaf = pluginLeaves[0];
  if (newTab && leaf) {
    workspace.setActiveLeaf(leaf, { focus: false });
    leaf = workspace.getLeaf("tab");
  } else if (!leaf) {
    leaf = pluginLeaf
      ? workspace.createLeafBySplit(pluginLeaf, "vertical")
      : workspace.getLeaf("tab");
  }
  await leaf.openFile(file as TFile, { active: true });
}
