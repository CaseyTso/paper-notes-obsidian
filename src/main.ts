import {
  Plugin,
  Notice,
  MarkdownView,
  Menu,
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
import { PaperNotesSettingTab } from "./settings-tab";
import { createCitationPickerModal } from "./modals/citation-picker-modal";
import {
  insertCitation,
  searchCitationCandidates,
  type CitationEditorPort,
} from "./services/citation-inserter";
import {
  ItemActions,
  mineruDeleteKeyArgs,
  mineruKeyStatusArgs,
  mineruSetKeyArgs,
  mocCreateNoticeText,
} from "./services/item-actions";
import { MineruQueue, type MineruQueueSnapshot, type MineruQueueSummary } from "./services/mineru-queue";
import type { PaperRecord } from "./types/paper";
import {
  PaperNotesLibraryView,
  VIEW_TYPE_PAPER_NOTES,
  type LibraryViewSource,
} from "./views/literature-library-view";
import {
  PaperNotesMocView,
  VIEW_TYPE_TOPIC_MOC,
  type MocViewSource,
} from "./views/topic-moc-view";
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

  /** Session-bound FIFO MinerU conversion queue (Task: MinerU). */
  private mineruQueue: MineruQueue | undefined;
  /** Cached `config mineru status` result (never the key value). */
  private mineruKeyConfigured = false;
  /** Status-bar element showing queue progress; hidden when idle. */
  private mineruStatusBarEl: HTMLElement | undefined;

  async onload(): Promise<void> {
    // Library view extracts loadData/saveData as free functions for the
    // MetricsCache merge-save bridge. Bind them to this plugin instance so
    // those extractions still write plugin data.json (empty metricsCache root
    // cause: unbound save threw, MetricsCache.persist swallowed the error).
    if (typeof this.loadData === "function") {
      this.loadData = this.loadData.bind(this);
    }
    if (typeof this.saveData === "function") {
      this.saveData = this.saveData.bind(this);
    }
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
    // Topic MOC View (Task 8): center leaf, not the right Library leaf.
    this.registerView(VIEW_TYPE_TOPIC_MOC, (leaf) => {
      return new PaperNotesMocView(leaf, this.createMocViewSource());
    });
    this.addCommand({
      id: "paper-notes-open-topic-moc",
      name: "Open topic MOC",
      callback: () => {
        void this.activateMocView();
      },
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
    this.initializeMineruQueue();
    this.addSettingTab(new PaperNotesSettingTab(this.app, this));
    void this.refreshMineruKeyStatus();
  }

  async onunload(): Promise<void> {
    // MinerU: cancel the running child and drop the pending queue (published
    // results are untouched; the core CLI only commits on full success).
    this.mineruQueue?.dispose();
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

  /** Cached `config mineru status`: configured or not (never the value). */
  mineruKeyConfiguredStatus(): boolean {
    return this.mineruKeyConfigured;
  }

  /** The session-bound MinerU queue, when the CLI + vault root are present. */
  getMineruQueue(): MineruQueue | undefined {
    return this.mineruQueue;
  }

  /**
   * Build the FIFO queue and status-bar widget. Skipped in headless/embedded
   * contexts (no vault root) or when the CLI bridge is unhealthy.
   */
  private initializeMineruQueue(): void {
    const client = this.getCliClient();
    const adapter = this.app.vault?.adapter as { getBasePath?(): string } | undefined;
    const vaultRoot =
      typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : undefined;
    if (client === undefined || vaultRoot === undefined) {
      return;
    }
    if (typeof this.addStatusBarItem === "function") {
      this.mineruStatusBarEl = this.addStatusBarItem();
      this.mineruStatusBarEl.addClass("paper-notes-mineru-status");
      this.mineruStatusBarEl.addEventListener("click", (event: MouseEvent) =>
        this.openMineruQueueMenu(event),
      );
    }
    this.mineruQueue = new MineruQueue({
      client,
      vaultRoot,
      onUpdate: (snapshot) => this.renderMineruStatusBar(snapshot),
      onSummary: (summary) => this.onMineruSummary(summary),
    });
    this.renderMineruStatusBar(this.mineruQueue.getSnapshot());
  }

  /** Re-query `config mineru status`; failures keep the cached false. */
  async refreshMineruKeyStatus(): Promise<boolean> {
    const client = this.getCliClient();
    if (client === undefined) {
      this.mineruKeyConfigured = false;
      return false;
    }
    try {
      const { envelope } = await client.run(mineruKeyStatusArgs());
      this.mineruKeyConfigured = envelope.data.configured === true;
    } catch {
      this.mineruKeyConfigured = false;
    }
    this.renderMineruStatusBar(this.mineruQueue?.getSnapshot());
    return this.mineruKeyConfigured;
  }

  /** Save the MinerU Key through the CLI stdin path; never echoed or stored. */
  async setMineruKey(value: string): Promise<{ ok: boolean; message: string }> {
    const client = this.getCliClient();
    if (client === undefined) {
      return { ok: false, message: "paper-notes CLI unavailable." };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: false, message: "MinerU key must not be empty." };
    }
    try {
      const { envelope } = await client.runWithInput(mineruSetKeyArgs(), trimmed + "\n", {
        redact: [trimmed],
      });
      if (envelope.status === "success") {
        this.mineruKeyConfigured = true;
        this.renderMineruStatusBar(this.mineruQueue?.getSnapshot());
        return { ok: true, message: "MinerU key saved." };
      }
      return {
        ok: false,
        message: envelope.errors[0]?.message ?? "Failed to save the MinerU key.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Failed to save the MinerU key.",
      };
    }
  }

  /** Remove the MinerU Key through the CLI (idempotent). */
  async deleteMineruKey(): Promise<{ ok: boolean; message: string }> {
    const client = this.getCliClient();
    if (client === undefined) {
      return { ok: false, message: "paper-notes CLI unavailable." };
    }
    try {
      const { envelope } = await client.run(mineruDeleteKeyArgs());
      if (envelope.status === "success") {
        this.mineruKeyConfigured = false;
        this.renderMineruStatusBar(this.mineruQueue?.getSnapshot());
        return { ok: true, message: "MinerU key deleted." };
      }
      return {
        ok: false,
        message: envelope.errors[0]?.message ?? "Failed to delete the MinerU key.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Failed to delete the MinerU key.",
      };
    }
  }

  /** Status-bar text + visibility driven by the latest queue snapshot. */
  private renderMineruStatusBar(snapshot: MineruQueueSnapshot | undefined): void {
    const el = this.mineruStatusBarEl;
    if (el === undefined) {
      return;
    }
    const running = snapshot?.running;
    const queued = snapshot?.items.filter((item) => item.state === "queued").length ?? 0;
    if (running === undefined && queued === 0) {
      el.addClass("is-hidden");
      el.setText("");
      return;
    }
    el.removeClass("is-hidden");
    if (running !== undefined) {
      const pages =
        running.totalPages !== undefined && running.totalPages > 0
          ? `${running.extractedPages ?? 0}/${running.totalPages} pages`
          : running.stage ?? "converting";
      el.setText(`MinerU: ${running.key} ${pages}${queued > 0 ? ` · ${queued} queued` : ""}`);
    } else {
      el.setText(`MinerU: ${queued} queued`);
    }
  }

  /** Status-bar click menu: remove waiting items / cancel the running one. */
  private openMineruQueueMenu(event: MouseEvent): void {
    const queue = this.mineruQueue;
    if (queue === undefined) {
      return;
    }
    const menu = new Menu();
    const snapshot = queue.getSnapshot();
    const running = snapshot.running;
    if (running !== undefined) {
      menu.addItem((item) => {
        item.setTitle(
          running.totalPages !== undefined && running.totalPages > 0
            ? `${running.key} — ${running.extractedPages ?? 0}/${running.totalPages} pages`
            : `${running.key} — ${running.stage ?? "converting"}`,
        );
        item.setDisabled(true);
      });
      menu.addItem((item) => {
        item.setTitle(`Cancel ${running.key}`);
        item.setIcon("x");
        item.onClick(() => {
          queue.cancelRunning();
          new Notice(`MinerU conversion of ${running.key} cancelled.`);
        });
      });
    }
    for (const queued of snapshot.items.filter((item) => item.state === "queued")) {
      menu.addItem((item) => {
        item.setTitle(`Queued #${queued.queueIndex}: ${queued.key}`);
        item.setIcon("list");
        item.onClick(() => {
          if (queue.removeQueued(queued.key)) {
            new Notice(`Removed ${queued.key} from the MinerU queue.`);
          }
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  /** End-of-drain summary: refresh artifacts and surface one Notice. */
  private onMineruSummary(summary: MineruQueueSummary): void {
    this.libraryIndex?.scanAll();
    this.libraryView?.refresh();
    if (summary.succeeded.length === 0 && summary.failed.length === 0) {
      return;
    }
    const parts: string[] = [];
    if (summary.succeeded.length > 0) {
      parts.push(`ok: ${summary.succeeded.join(", ")}`);
    }
    if (summary.failed.length > 0) {
      parts.push(
        `failed: ${summary.failed.map((entry) => `${entry.key} (${entry.reason})`).join("; ")}`,
      );
    }
    new Notice(`MinerU queue finished — ${parts.join(" · ")}`, 8000);
  }

  /**
   * Persist settings to plugin data.json without dropping sibling keys
   * (metricsCache, column widths, …): merge the normalized settings over
   * the raw loaded object instead of replacing it wholesale.
   */
  async saveSettings(): Promise<void> {
    const loaded = ((await this.loadData()) as Record<string, unknown> | undefined) ?? {};
    await this.saveData({ ...loaded, ...this.settings });
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
      // Volatile EasyScholar metrics live in MetricsCache (data.json
      // metricsCache), not on the index source. The library view reads the
      // cache first and only falls back here; keep this undefined so the
      // cache remains the single source of truth.
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

  /** Activate the Topic MOC view in a center leaf (never the right Library leaf). */
  activateMocView(): void {
    void this.doActivateMocView();
  }

  private async doActivateMocView(): Promise<void> {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TOPIC_MOC);
    let leaf = leaves.length > 0 ? leaves[0] : null;
    if (leaf === null) {
      leaf = workspace.getLeaf(false);
    }
    if (leaf === null) {
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_TOPIC_MOC, active: true });
    workspace.revealLeaf(leaf);
  }

  private createMocViewSource(): MocViewSource {
    return {
      getVaultRoot: () => {
        const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
        return adapter.getBasePath?.() ?? "";
      },
      literatureRoot: this.settings.literatureRoot,
      readText: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file === null || typeof file !== "object" || !("path" in file)) {
          return "";
        }
        return this.app.vault.cachedRead(file as import("obsidian").TFile);
      },
      listMarkdownFiles: (dir: string) => {
        return this.app.vault
          .getMarkdownFiles()
          .filter((f) => f.path.startsWith(dir + "/"))
          .map((f) => f.path.split("/").pop() ?? f.path);
      },
      resolveLink: (target: string, sourcePath: string) => {
        return this.app.metadataCache.getFirstLinkpathDest(target, sourcePath) ?? undefined;
      },
      openFile: (file: import("obsidian").TFile) => {
        this.app.workspace.getLeaf("tab")?.openFile(file);
      },
      createMoc: async () => {
        const client = this.getCliClient();
        const adapter = this.app.vault.adapter as unknown as { getBasePath?(): string };
        const vaultRoot = adapter.getBasePath?.();
        if (!client || !vaultRoot) {
          new Notice("paper-notes CLI unavailable; cannot create a Topic MOC.");
          return undefined;
        }
        return new Promise<string | undefined>((resolve) => {
          const { TextPromptModal } = require("./modals/confirmation-modal") as {
            TextPromptModal: new (
              app: import("obsidian").App,
              data: { title: string; placeholder?: string; confirmLabel?: string },
              callbacks: { confirm(value: string): void; cancel?(): void },
            ) => { open(): void };
          };
          const modal = new TextPromptModal(
            this.app,
            { title: "新建主题", placeholder: "主题名称", confirmLabel: "创建" },
            {
              confirm: async (name: string) => {
                const trimmed = name.trim();
                if (!trimmed) {
                  return;
                }
                const actions = new ItemActions({ client, vaultRoot });
                const result = await actions.createMoc(trimmed);
                const noticeText = mocCreateNoticeText(result.outcome, result.title);
                new Notice(noticeText);
                resolve(result.path);
              },
              cancel: () => resolve(undefined),
            },
          );
          modal.open();
        });
      },
    };
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
      const modal = createCitationPickerModal(this.app, {
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
      const modal = createExportConfirmationModal(
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