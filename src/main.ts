import {
  ItemView,
  Plugin,
  WorkspaceLeaf,
  type MetadataCache,
  type TFile,
  type Vault,
} from "obsidian";

import { CliClient } from "./services/cli-client";
import {
  LibraryIndex,
  SearchCancelledError,
  VaultFileNotFoundError,
  type IndexVaultEvent,
  type LiteratureVaultAdapter,
} from "./services/library-index";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type PaperNotesSettings,
} from "./settings";

export const VIEW_TYPE_PAPER_NOTES = "paper-notes-open-library";
export const OPEN_LIBRARY_COMMAND = "paper-notes-open-library";

/**
 * Read-only Obsidian vault adapter for the in-memory index (Task 23).
 * Frontmatter comes from the metadata cache (already-parsed YAML); full-text
 * reads use `cachedRead` so on-disk I/O stays cached. Never writes notes.
 */
class ObsidianVaultAdapter implements LiteratureVaultAdapter {
  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
  ) {}

  listMarkdownFiles(): string[] {
    return this.vault.getMarkdownFiles().map((file) => file.path);
  }

  getFrontmatter(path: string): Record<string, unknown> | undefined {
    const file = this.vault.getAbstractFileByPath(path);
    if (file === null || typeof file !== "object" || !("path" in file)) {
      return undefined;
    }
    return this.metadataCache.getFileCache(file as TFile)?.frontmatter;
  }

  async readText(path: string, signal?: AbortSignal): Promise<string> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file === null || typeof file !== "object" || !("path" in file)) {
      throw new VaultFileNotFoundError(path);
    }
    if (signal?.aborted) {
      throw new SearchCancelledError();
    }
    const content = await this.vault.cachedRead(file as TFile);
    if (signal?.aborted) {
      throw new SearchCancelledError();
    }
    return content;
  }
}

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

  private libraryIndex: LibraryIndex | undefined;

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
    this.initializeLibraryIndex();
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

  getLibraryIndex(): LibraryIndex | undefined {
    return this.libraryIndex;
  }

  isReadOnly(): boolean {
    return this.cliReadOnlyMode;
  }

  /**
   * Build the in-memory literature index over the configured root and keep
   * it in sync with vault create/modify/delete/rename events. Skipped in
   * headless/embedded contexts that expose no vault or metadata cache.
   */
  private initializeLibraryIndex(): void {
    const vault = this.app.vault;
    const metadataCache = this.app.metadataCache;
    if (vault === undefined || metadataCache === undefined) {
      return;
    }
    this.libraryIndex = new LibraryIndex(
      new ObsidianVaultAdapter(vault, metadataCache),
      this.settings.literatureRoot,
    );
    this.libraryIndex.scanAll();
    this.registerVaultEvents(vault);
  }

  private registerVaultEvents(vault: Vault): void {
    if (typeof this.registerEvent !== "function") {
      return;
    }
    this.registerEvent(
      vault.on("create", (file) =>
        this.onVaultFileEvent("create", file.path),
      ),
    );
    this.registerEvent(
      vault.on("modify", (file) =>
        this.onVaultFileEvent("modify", file.path),
      ),
    );
    this.registerEvent(
      vault.on("delete", (file) =>
        this.onVaultFileEvent("delete", file.path),
      ),
    );
    this.registerEvent(
      vault.on("rename", (file, oldPath) =>
        this.onVaultFileEvent("rename", file.path, oldPath),
      ),
    );
  }

  private onVaultFileEvent(
    event: IndexVaultEvent,
    path: string,
    oldPath?: string,
  ): void {
    this.libraryIndex?.handleVaultEvent(event, path, oldPath);
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
