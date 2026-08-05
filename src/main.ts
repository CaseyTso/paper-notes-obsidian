import {
  Plugin,
  Notice,
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
  CSL_STYLE_DIR,
  DEFAULT_SETTINGS,
  exportConfigOf,
  normalizeSettings,
  type PaperNotesSettings,
} from "./settings";
import { createCitationPickerModal } from "./modals/citation-picker-modal";
import {
  insertCitation,
  searchCitationCandidates,
  type CitationEditorPort,
} from "./services/citation-inserter";
import type { PaperRecord } from "./types/paper";
import {
  PaperNotesLibraryView,
  VIEW_TYPE_PAPER_NOTES,
  type LibraryViewSource,
} from "./views/literature-library-view";
import { requireExportStyle, type CslVaultPort } from "./services/csl-style-manager";
import { checkExportHealth, defaultHealthPort } from "./services/export-health";
import {
  aliasMapOf,
  checkCitationKeys,
  defaultExportPorts,
  desktopOpenRevealActions,
  exportPandoc,
  exportTargetPath,
  type ExportFormat,
} from "./services/pandoc-export";
import { createExportConfirmationModal } from "./modals/export-confirmation-modal";

export { VIEW_TYPE_PAPER_NOTES };

export const OPEN_LIBRARY_COMMAND = "paper-notes-open-library";

/** Command id for the keyboard citation picker (Task 27). */
export const INSERT_CITATION_COMMAND = "paper-notes-insert-citation";

/** Command ids for the focused Pandoc exporter (Task 29). */
export const EXPORT_DOCX_COMMAND = "paper-notes-export-docx";
export const EXPORT_PDF_COMMAND = "paper-notes-export-pdf";

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

export default class PaperNotesPlugin extends Plugin {
  isDesktopOnly = true;

  settings: PaperNotesSettings = DEFAULT_SETTINGS;

  private cliClient: CliClient | undefined;
  private cliReadOnlyMode = true;

  private libraryIndex: LibraryIndex | undefined;
  private vaultAdapter: ObsidianVaultAdapter | undefined;
  private libraryView: PaperNotesLibraryView | null = null;

  /** Abort controllers of in-flight Pandoc exports, cancelled on unload. */
  private runningExports = new Set<AbortController>();

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_PAPER_NOTES, (leaf) => {
      this.libraryView = new PaperNotesLibraryView(
        leaf,
        this.createLibraryViewSource(),
      );
      return this.libraryView;
    });
    this.addCommand({
      id: OPEN_LIBRARY_COMMAND,
      name: "Open literature library",
      callback: () => this.activateLibraryView(),
    });
    // Command-driven citation picker (Task 27): no hardcoded default
    // hotkey, and no editor-typing interception — typing `@` never
    // auto-activates the picker.
    this.addCommand({
      id: INSERT_CITATION_COMMAND,
      name: "Insert citation",
      callback: () => {
        void this.openCitationPicker();
      },
    });
    // Focused academic export (Task 29): DOCX/PDF only, from the active
    // Markdown note, into the fixed global output directory.
    this.addCommand({
      id: EXPORT_DOCX_COMMAND,
      name: "Export active note as DOCX",
      callback: () => {
        void this.exportActiveNote("docx");
      },
    });
    this.addCommand({
      id: EXPORT_PDF_COMMAND,
      name: "Export active note as PDF",
      callback: () => {
        void this.exportActiveNote("pdf");
      },
    });
    await this.initializeCliBridge();
    this.initializeLibraryIndex();
  }

  async onunload(): Promise<void> {
    for (const controller of this.runningExports) {
      controller.abort();
    }
    this.runningExports.clear();
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
    this.vaultAdapter = new ObsidianVaultAdapter(vault, metadataCache);
    this.libraryIndex = new LibraryIndex(
      this.vaultAdapter,
      this.settings.literatureRoot,
    );
    this.libraryIndex.scanAll();
    this.registerVaultEvents(vault);
  }

  /**
   * Read-only data source for the library view: index records, raw
   * frontmatter (reading status), paper-directory basenames (artifact
   * availability) and — once Task 26 lands — volatile EasyScholar metrics.
   * No callback here can write anything.
   */
  private createLibraryViewSource(): LibraryViewSource {
    const vault = this.app.vault;
    return {
      getRecords: () => this.libraryIndex?.getRecords() ?? [],
      getInvalidRecords: () => this.libraryIndex?.getInvalidRecords() ?? [],
      getFrontmatter: (path) => this.vaultAdapter?.getFrontmatter(path),
      listDirectory: (dir) => {
        if (vault === undefined) {
          return [];
        }
        const folder = vault.getAbstractFileByPath(dir);
        if (
          folder === null ||
          typeof folder !== "object" ||
          !("children" in folder)
        ) {
          return [];
        }
        const children = (folder as { children?: Array<{ name?: unknown }> })
          .children;
        if (children === undefined) {
          return [];
        }
        return children.map((child) =>
          typeof child.name === "string" ? child.name : "",
        );
      },
      // EasyScholar metrics arrive with Task 26; until then there are none.
      getMetrics: () => undefined,
    };
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
    this.libraryView?.refresh();
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

  /**
   * Open the keyboard citation picker against the active Markdown editor
   * and the current index records. The editor is accessed structurally
   * through `workspace.activeEditor` so no additional obsidian runtime
   * value imports enter the static graph. No-op when no editor is active
   * (visual/UX polish is deferred to Task 33 Gate D).
   */
  private async openCitationPicker(): Promise<void> {
    const workspace = this.app.workspace as {
      activeEditor?: { editor?: CitationEditorPort | null } | null;
    };
    const editor = workspace.activeEditor?.editor;
    if (editor === undefined || editor === null) {
      return;
    }
    const records = this.libraryIndex?.getRecords() ?? [];
    try {
      const modal = await createCitationPickerModal(this.app, {
        search: (query: string) => searchCitationCandidates(records, query),
        onPick: (selected: PaperRecord[]) => insertCitation(editor, selected),
      });
      modal.open();
    } catch {
      // Modal unavailable in a headless context; the command is a no-op.
    }
  }

  /**
   * Export the active Markdown note as DOCX or PDF through Pandoc (Task
   * 29). Preflight blocks on unknown citation keys, the fixed global
   * output directory, Pandoc, the PDF engine, the selected CSL style and
   * the reference DOCX before anything launches; an existing target asks
   * for explicit confirmation via the export modal. The export itself
   * writes to a temporary file and atomically publishes on exit 0.
   */
  private async exportActiveNote(format: ExportFormat): Promise<void> {
    const workspace = this.app.workspace as {
      getActiveFile?: () => TFile | null;
    };
    const activeFile = workspace.getActiveFile?.() ?? null;
    if (activeFile === null) {
      new Notice("Paper Notes: no active Markdown note to export.");
      return;
    }
    const vault = this.app.vault;
    const adapter = vault.adapter as { getFullPath?: (path: string) => string };
    if (typeof adapter?.getFullPath !== "function") {
      new Notice("Paper Notes: export needs the desktop vault adapter.");
      return;
    }

    const cslCheck = await requireExportStyle(
      this.createCslVaultPort(),
      CSL_STYLE_DIR,
      this.settings.selectedCsl,
    );
    const records = this.libraryIndex?.getRecords() ?? [];
    const markdown = await vault.cachedRead(activeFile);
    const gate = checkCitationKeys(markdown, records, aliasMapOf(records));
    if (!gate.ok) {
      new Notice(
        `Paper Notes: unknown citation key(s): ${gate.unknownKeys.join(", ")}. Export blocked.`,
      );
      return;
    }

    const cfg = exportConfigOf(this.settings);
    const health = await checkExportHealth(defaultHealthPort(), {
      format,
      exportDirectory: cfg.exportDirectory,
      pandocPath: cfg.pandocPath,
      pdfEngine: cfg.pdfEngine,
      referenceDocx: cfg.referenceDocx,
      csl: cslCheck,
    });
    if (!health.ok) {
      new Notice(
        `Paper Notes: export blocked. ${health.problems[0] ?? "preflight failed."}`,
      );
      return;
    }

    const ports = defaultExportPorts();
    const targetPath = exportTargetPath(
      health.exportDirectory,
      activeFile.basename,
      format,
    );
    const targetExists = await ports.fs.exists(targetPath);
    const markdownPath = adapter.getFullPath(activeFile.path);
    const cslPath = adapter.getFullPath(health.cslPath);
    const engineLabel =
      format === "pdf"
        ? `PDF engine: ${health.pdfEngine}`
        : health.referenceDocx.length > 0
          ? `Reference DOCX: ${health.referenceDocx}`
          : "Reference DOCX: Pandoc default";

    try {
      const modal = await createExportConfirmationModal(
        this.app,
        {
          format,
          targetPath,
          targetExists,
          cslTitle: health.cslTitle,
          engineLabel,
          actions: desktopOpenRevealActions(),
          onCancel: () => {},
        },
        {
          start: () => {
            const controller = new AbortController();
            this.runningExports.add(controller);
            const result = exportPandoc(
              {
                format,
                baseName: activeFile.basename,
                markdown,
                markdownPath,
                exportDirectory: health.exportDirectory,
                pandocPath: health.pandocPath,
                pdfEngine: health.pdfEngine,
                cslPath,
                referenceDocx: health.referenceDocx,
                records,
                signal: controller.signal,
              },
              ports,
            ).finally(() => this.runningExports.delete(controller));
            return { abort: () => controller.abort(), result };
          },
        },
      );
      modal.open();
    } catch {
      new Notice("Paper Notes: export dialog unavailable.");
    }
  }

  /**
   * Read-only CSL vault port for the export gate: lists and reads styles
   * from the vault adapter. Writes are never available from export flows.
   */
  private createCslVaultPort(): CslVaultPort {
    const adapter = this.app.vault.adapter as unknown as {
      list?: (path: string) => Promise<{ files: Array<{ name: string }> }>;
      read?: (path: string) => Promise<string>;
    };
    return {
      async listFiles(dir: string): Promise<string[]> {
        if (typeof adapter?.list !== "function") {
          return [];
        }
        try {
          const listed = await adapter.list(dir);
          return listed.files.map((file) => file.name);
        } catch {
          return [];
        }
      },
      async readText(path: string): Promise<string | null> {
        if (typeof adapter?.read !== "function") {
          return null;
        }
        try {
          return await adapter.read(path);
        } catch {
          return null;
        }
      },
      async writeText(): Promise<void> {
        throw new Error("CSL writes are not available from export flows.");
      },
    };
  }
}
