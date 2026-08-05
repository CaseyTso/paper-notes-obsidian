import {
  Plugin,
  Notice,
  MarkdownView,
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
 * Debounce window for the metadata-cache readiness rescan (Gate D R2).
 * Obsidian fires a burst of `resolved` events while it builds the cache at
 * startup; collapsing them into one trailing scan keeps the rescan idempotent
 * and cheap.
 */
export const METADATA_RESCAN_DEBOUNCE_MS = 300;

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

  /** Pending metadata-cache readiness rescan (Gate D R2), cancelled on unload. */
  private metadataRescanTimer: ReturnType<typeof setTimeout> | undefined;

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
    if (this.metadataRescanTimer !== undefined) {
      clearTimeout(this.metadataRescanTimer);
      this.metadataRescanTimer = undefined;
    }
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
    this.registerMetadataCacheRescan(metadataCache);
  }

  /**
   * Obsidian builds the metadata cache asynchronously: at plugin load
   * `getFileCache()` commonly returns undefined, so the initial `scanAll()`
   * marks every canonical note `missing_frontmatter` (Gate D R2). The
   * `resolved` event fires once the whole cache is built (and again each
   * time files are modified afterwards); on each fire we schedule a
   * debounced idempotent rescan and refresh any library view that may
   * already be open. Unregistered on unload via `registerEvent`; a pending
   * debounce is cancelled in `onunload`.
   */
  private registerMetadataCacheRescan(metadataCache: MetadataCache): void {
    if (
      typeof metadataCache.on !== "function" ||
      typeof this.registerEvent !== "function"
    ) {
      return;
    }
    this.registerEvent(
      metadataCache.on("resolved", () => this.scheduleMetadataRescan()),
    );
  }

  /**
   * Debounced rescan gate: the cache-build-finished signal can only fix
   * pending invalidity, so a healthy index (no invalid records) skips the
   * rescan. A burst of signals (e.g. a modification batch re-resolving many
   * files) collapses into one trailing scan.
   */
  private scheduleMetadataRescan(): void {
    const index = this.libraryIndex;
    if (index === undefined || index.getInvalidRecords().length === 0) {
      return;
    }
    if (this.metadataRescanTimer !== undefined) {
      clearTimeout(this.metadataRescanTimer);
    }
    this.metadataRescanTimer = setTimeout(() => {
      this.metadataRescanTimer = undefined;
      this.libraryIndex?.scanAll();
      this.libraryView?.refresh();
    }, METADATA_RESCAN_DEBOUNCE_MS);
  }

  /**
   * Read-only data source for the library view: index records, raw
   * frontmatter (reading status), paper-directory basenames (artifact
   * availability) and — once Task 26 lands — volatile EasyScholar metrics.
   * No callback here can write anything.
   */
  private createLibraryViewSource(): LibraryViewSource {
    const vault = this.app.vault;
    const listDir = (dir: string): string[] => {
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
    };
    return {
      getRecords: () => this.libraryIndex?.getRecords() ?? [],
      getInvalidRecords: () => this.libraryIndex?.getInvalidRecords() ?? [],
      getFrontmatter: (path) => this.vaultAdapter?.getFrontmatter(path),
      listDirectory: (dir) => listDir(dir),
      // Card listing is a directory read today; the signature is the
      // contract, so a future independent card data source can replace
      // the implementation without touching any caller.
      getCards: (dir) =>
        listDir(`${dir}/cards`)
          .filter((name) => name.endsWith(".md"))
          .sort(),
      // EasyScholar metrics arrive with Task 26; until then there are none.
      getMetrics: () => undefined,
      // On-demand MinerU full-text search (design spec §9.4; Repair: Task
      // 23 R7): the view calls this after its debounce; the index skips
      // MinerU reads for records already matched by default fields, and
      // the AbortSignal cancels an in-flight search.
      searchFullText: (query, signal) => {
        const index = this.libraryIndex;
        return index === undefined
          ? Promise.resolve([])
          : index.searchFullText(query, { signal });
      },
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
   * and the current index records. The editor is resolved through
   * `workspace.activeEditor` (Obsidian 1.4.5+ API) with a fallback to the
   * stable legacy `getActiveViewOfType(MarkdownView)` lookup, so the
   * command works across Obsidian versions. When no editor is active the
   * command surfaces a visible Notice instead of silently doing nothing
   * (Repair: Gate D R6).
   */
  private async openCitationPicker(): Promise<void> {
    const editor = this.resolveActiveEditor();
    if (editor === null) {
      new Notice("Paper Notes: 请先打开一篇笔记并将光标置于正文。");
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
      // Modal unavailable in a headless context; keep the no-op semantics
      // but stop swallowing the failure silently (Repair: Gate D R6).
      new Notice("Paper Notes: 引用选择器暂不可用。");
    }
  }

  /**
   * Resolve the active Markdown editor with a version-tolerant fallback:
   * `workspace.activeEditor?.editor` (Obsidian 1.4.5+) first, otherwise the
   * stable legacy `workspace.getActiveViewOfType(MarkdownView)?.editor`.
   * Returns null when neither API exposes an editor.
   */
  private resolveActiveEditor(): CitationEditorPort | null {
    const workspace = this.app.workspace as {
      activeEditor?: { editor?: CitationEditorPort | null } | null;
      getActiveViewOfType?: <T extends unknown>(
        type: unknown,
      ) => T | null;
    };
    const viaActiveEditor = workspace.activeEditor?.editor ?? null;
    if (viaActiveEditor !== null && viaActiveEditor !== undefined) {
      return viaActiveEditor;
    }
    const view = workspace.getActiveViewOfType?.(
      MarkdownView,
    ) as { editor?: CitationEditorPort | null } | null | undefined;
    const viaLegacyView = view?.editor ?? null;
    return viaLegacyView ?? null;
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
