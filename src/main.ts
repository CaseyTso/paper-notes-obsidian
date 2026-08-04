import { ItemView, Plugin, WorkspaceLeaf } from "obsidian";

import { CliClient } from "./services/cli-client";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type PaperNotesSettings,
} from "./settings";

export const VIEW_TYPE_PAPER_NOTES = "paper-notes-open-library";
export const OPEN_LIBRARY_COMMAND = "paper-notes-open-library";

class PaperNotesLibraryView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PAPER_NOTES;
  }

  getDisplayText(): string {
    return "Paper Notes Library";
  }

  getIcon(): string {
    return "library";
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.createEl("div", {
      text: "Paper Notes library (scaffold).",
    });
  }

  async onClose(): Promise<void> {
    this.containerEl.empty();
  }
}

export default class PaperNotesPlugin extends Plugin {
  isDesktopOnly = true;

  settings: PaperNotesSettings = DEFAULT_SETTINGS;

  private cliClient: CliClient | undefined;
  private cliReadOnlyMode = true;

  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_PAPER_NOTES,
      (leaf) => new PaperNotesLibraryView(leaf),
    );
    this.addCommand({
      id: OPEN_LIBRARY_COMMAND,
      name: "Open literature library",
      callback: () => this.activateLibraryView(),
    });
    await this.initializeCliBridge();
  }

  /**
   * Load persisted settings, then discover/validate the core CLI.
   * A missing, broken, or protocol-mismatched CLI keeps the plugin in
   * read-only mode (no managed mutations until the bridge is healthy).
   */
  private async initializeCliBridge(): Promise<void> {
    const loaded =
      typeof this.loadData === "function" ? await this.loadData() : {};
    this.settings = normalizeSettings(loaded);
    this.cliClient = new CliClient(this.settings.cliPath);
    const probe = await this.cliClient.probe();
    this.cliReadOnlyMode = probe.readOnlyMode;
  }

  getCliClient(): CliClient | undefined {
    return this.cliClient;
  }

  isReadOnly(): boolean {
    return this.cliReadOnlyMode;
  }

  private activateLibraryView(): void {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PAPER_NOTES);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getRightLeaf(false);
    if (leaf === null) {
      return;
    }
    if (leaves.length === 0) {
      leaf.setViewState({ type: VIEW_TYPE_PAPER_NOTES, active: true });
    }
    void workspace.revealLeaf(leaf);
  }
}
