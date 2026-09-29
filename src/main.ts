import {
  Plugin,
  Notice,
  MarkdownView,
  Menu,
  type MetadataCache,
  type TFile,
  type Vault,
  type WorkspaceLeaf,
  type Editor,
  type MarkdownFileInfo,
} from "obsidian";

import {
  CardCreationService,
  defaultFreezeEditor,
  isSourceOrLivePreview,
  parseFigureSource,
  type FigureSourceInfo,
} from "./services/card-creation";
import { LiteratureCardModal } from "./modals/literature-card-modal";

import { CliClient } from "./services/cli-client";
import { FetchClient } from "./services/fetch-client";
import type { AbleSciStatusResult } from "./types/fetch";
import {
  LibraryIndex,
  SearchCancelledError,
  VaultFileNotFoundError,
  type IndexVaultEvent,
  type LiteratureVaultAdapter,
} from "./services/library-index";
import { CaptureBridge, type CaptureBridgeStatus } from "./services/capture-bridge";
import { WebCaptureActions } from "./services/web-capture-actions";
import {
  CSL_STYLE_DIR,
  DEFAULT_SETTINGS,
  browserConnectorEnabledOf,
  exportConfigOf,
  normalizeSettings,
  type PaperNotesSettings,
} from "./settings";
import { PaperNotesSettingTab } from "./settings-tab";
import { ImportReviewModal } from "./modals/import-review-modal";
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
import {
  classifyOpenedFile,
  RecentActivityStore,
  type ActivityStorageBridge,
  type RecentImportEntry,
  type RecentReadEntry,
} from "./services/recent-activity";
import type { PaperRecord } from "./types/paper";
import {
  PaperNotesLibraryView,
  VIEW_TYPE_PAPER_NOTES,
  type LibraryViewSource,
} from "./views/literature-library-view";
import {
  PaperNotesMocView,
  VIEW_TYPE_TOPIC_MOC,
} from "./views/topic-moc-view";
import type { MocDirectorySource } from "./components/moc-directory";
import { openMocNote } from "./services/moc-navigation";
import { parseMocNote, type ParsedMoc } from "./services/moc-parse";
import { requireExportStyle, type CslVaultPort } from "./services/csl-style-manager";
import { checkExportHealth, defaultHealthPort } from "./services/export-health";
import {
  aliasMapOf,
  checkCitationKeys,
  defaultExportPorts,
  desktopOpenRevealActions,
  exportPandoc,
  exportTargetPath,
} from "./services/pandoc-export";
import { createExportConfirmationModal } from "./modals/export-confirmation-modal";

export { VIEW_TYPE_PAPER_NOTES };

export const OPEN_LIBRARY_COMMAND = "paper-notes-open-library";

/** Command id for the keyboard citation picker (Task 27). */
export const INSERT_CITATION_COMMAND = "paper-notes-insert-citation";

/** Command id for the focused Pandoc exporter (Task 29). */
export const EXPORT_DOCX_COMMAND = "paper-notes-export-docx";

/** Command id for Literature Card creation from selection. */
export const CREATE_LITERATURE_CARD_COMMAND = "paper-notes-create-literature-card";

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

  /** paper-fetch CLI bridge (Fetch PDF) + startup availability probe. */
  private fetchClient: FetchClient | undefined;
  private fetchAvailable = false;

  /** In-memory cache of parsed Topic MOCs for Library MOC membership. */
  private mocCache = new Map<string, ParsedMoc>();
  /** In-flight Fetch PDF runs, aborted on unload. */
  private runningFetches = new Set<AbortController>();

  /** Capture Bridge (loopback) and its CLI adapter (Task 6/7). */
  private captureBridge: CaptureBridge | undefined;
  private webCaptureActions: WebCaptureActions | undefined;
  private browserConnectorStatus: CaptureBridgeStatus = "stopped";

  private libraryIndex: LibraryIndex | undefined;
  private vaultAdapter: ObsidianVaultAdapter | undefined;
  private libraryView: PaperNotesLibraryView | null = null;

  /** Abort controllers of in-flight Pandoc exports, cancelled on unload. */
  private runningExports = new Set<AbortController>();

  /** Abort controllers of in-flight Literature Card creations, cancelled on unload. */
  private runningCardCreations = new Set<AbortController>();
  private cardCreationService: CardCreationService | undefined;

  /** Pending metadata-cache readiness rescan (Gate D R2), cancelled on unload. */
  private metadataRescanTimer: ReturnType<typeof setTimeout> | undefined;

  /** Persistent recent activity store (Task: R2). */
  private recentActivity: RecentActivityStore | undefined;

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
        this.createMocViewSource(),
      );
      return this.libraryView;
    });
    this.addCommand({
      id: OPEN_LIBRARY_COMMAND,
      name: "Open literature library",
      callback: () => {
        void this.activateLibraryView();
      },
    });
    this.addRibbonIcon("library", "Open literature library", () => {
      void this.activateLibraryView();
    });
    // Keep old saved workspace entries as redirects to the internal page.
    this.registerView(VIEW_TYPE_TOPIC_MOC, (leaf) => {
      return new PaperNotesMocView(leaf, () => this.activateMocView());
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
    // Focused academic export (Task 29): DOCX only, from the active
    // Markdown note, into the fixed global output directory.
    this.addCommand({
      id: EXPORT_DOCX_COMMAND,
      name: "Export active note as DOCX",
      callback: () => {
        void this.exportActiveNote();
      },
    });
    // Literature Card from selection command + hotkey
    this.addCommand({
      id: CREATE_LITERATURE_CARD_COMMAND,
      name: "Create Literature Card from selection",
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "C",
        },
      ],
      editorCheckCallback: (
        checking: boolean,
        editor: Editor,
        ctx: MarkdownView | MarkdownFileInfo,
      ) => {
        if (!(ctx instanceof MarkdownView)) {
          return false;
        }
        const file = ctx.file;
        if (!file) {
          return false;
        }
        const figureInfo = parseFigureSource(
          file.path,
          this.settings.literatureRoot,
        );
        if (!figureInfo) {
          return false;
        }
        if (!isSourceOrLivePreview(ctx)) {
          return false;
        }
        const selection = editor.getSelection();
        if (!selection || selection.trim().length === 0) {
          return false;
        }
        if (!checking) {
          void this.createLiteratureCardFromEditor(ctx, editor, figureInfo);
        }
        return true;
      },
    });
    if (
      typeof this.registerEvent === "function" &&
      typeof this.app?.workspace?.on === "function"
    ) {
      this.registerEvent(
        this.app.workspace.on(
          "editor-menu",
          (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
            if (!(view instanceof MarkdownView)) {
              return;
            }
            const file = view.file;
            if (!file) {
              return;
            }
            const figureInfo = parseFigureSource(
              file.path,
              this.settings.literatureRoot,
            );
            if (!figureInfo) {
              return;
            }
            if (!isSourceOrLivePreview(view)) {
              return;
            }
            const selection = editor.getSelection();
            if (!selection || selection.trim().length === 0) {
              return;
            }
            menu.addItem((item) => {
              item.setTitle("从选区创建 Literature Card");
              item.setIcon("create-new");
              item.onClick(() => {
                void this.createLiteratureCardFromEditor(view, editor, figureInfo);
              });
            });
          },
        ),
      );
    }
    await this.initializeCliBridge();
    await this.initializeFetchBridge();
    this.initializeLibraryIndex();
    await this.initializeRecentActivity();
    this.initializeMineruQueue();
    this.addSettingTab(new PaperNotesSettingTab(this.app, this));
    if (typeof this.registerObsidianProtocolHandler === "function") {
    this.registerObsidianProtocolHandler("paper-notes-review", (params) => {
      const reviewId = typeof params.id === "string" ? params.id : "";
      const review = this.webCaptureActions?.getReview(reviewId);
      if (review === undefined) {
        new Notice("Capture review expired; capture the page again.");
        return;
      }
      const modal = new ImportReviewModal(this.app, review, {
        confirm: (confirmed) => {
          void (async () => {
            const result = await this.webCaptureActions?.confirmReview(reviewId, confirmed);
            if (result !== undefined) {
              this.showWebCaptureResult(result);
            }
          })();
        },
        cancel: () => {
          new Notice("Capture review cancelled; nothing was written.");
        },
      });
      modal.open();
    });
    }
    void this.refreshMineruKeyStatus();
  }

  /** Surface a Browser Capture result as a concise Notice. */
  private showWebCaptureResult(result: import("../browser-connector/src/protocol").BrowserCaptureResult): void {
    switch (result.status) {
      case "created": {
        new Notice(`Created ${result.title} (${result.citationKey})`);
        const root = this.settings.literatureRoot.replace(/\/+$/, "");
        void this.recentActivity
          ?.recordImport({
            key: result.citationKey,
            path: `${root}/${result.citationKey}/${result.citationKey}.md`,
            createdAt: new Date().toISOString(),
          })
          .then(() => {
            this.libraryView?.refreshData();
          });
        break;
      }
      case "existing":
        new Notice(`Already in library: ${result.title} (${result.citationKey})`);
        break;
      case "needs_review":
        new Notice(`Capture still needs review: ${result.reason}`);
        break;
      case "rejected":
        new Notice(`Capture rejected: ${result.reason}`);
        break;
      case "unavailable":
        new Notice(`Capture unavailable: ${result.reason}`);
        break;
    }
  }

  /**
   * Reveal the Library and focus it on the imported paper. Clears any
   * search/filter, selects the row, opens the Detail Drawer, and scrolls
   * the row into view (user-visible result of a successful capture).
   */
  private focusPaperInLibrary(citationKey: string, path?: string): void {
    void this.activateLibraryView();
    const attempt = (remaining: number): void => {
      // Obsidian's vault file cache can lag the CLI write by a moment;
      // rescan on each attempt so the imported note becomes visible.
      this.libraryIndex?.scanAll();
      const view = this.libraryView;
      if (view !== null) {
        view.focusPaper(citationKey, path);
        return;
      }
      if (remaining > 0) {
        setTimeout(() => attempt(remaining - 1), 100);
      }
    };
    attempt(30);
  }

  async onunload(): Promise<void> {
    // Capture Bridge: release the loopback port and drop in-memory
    // idempotency/review maps (Task 6).
    await this.captureBridge?.stop();
    this.captureBridge = undefined;
    this.webCaptureActions = undefined;
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
    for (const controller of this.runningCardCreations) {
      controller.abort();
    }
    this.runningCardCreations.clear();
    // Fetch PDF: cancel in-flight downloads; temp dirs are removed by the
    // PdfFetcher's own finally block.
    for (const controller of this.runningFetches) {
      controller.abort();
    }
    this.runningFetches.clear();
    this.recentActivity = undefined;
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
    this.cardCreationService = undefined;
    const probe = await this.cliClient.probe();
    this.cliReadOnlyMode = probe.readOnlyMode;
    this.initializeCaptureBridge();
  }

  /**
   * Load the paper-fetch CLI bridge and probe availability (non-mutating
   * `--help`). A missing/broken CLI keeps Fetch PDF menu entries disabled
   * with an explanatory reason; a path change applies after reloading.
   */
  private async initializeFetchBridge(): Promise<void> {
    this.fetchClient = new FetchClient(this.settings.paperFetchPath);
    this.fetchAvailable = await this.fetchClient.probe();
  }

  getFetchClient(): FetchClient | undefined {
    return this.fetchClient;
  }

  isPaperFetchAvailable(): boolean {
    return this.fetchAvailable;
  }

  /** Read-only ableSci (科研通) session status from `paper-fetch doctor`. */
  async checkAbleSciLoginStatus(): Promise<AbleSciStatusResult> {
    const client = this.fetchClient;
    if (client === undefined) {
      return {
        status: "unavailable",
        rowStatus: "cli_missing",
        detail: "paper-fetch CLI 未配置。",
        action: "在 Settings → Fetch PDF 设置 paper-fetch 路径。",
      };
    }
    return client.ableSciStatus();
  }

  /** Track an in-flight Fetch PDF run so unload can abort it. */
  trackFetchRun(controller: AbortController): void {
    this.runningFetches.add(controller);
  }

  untrackFetchRun(controller: AbortController): void {
    this.runningFetches.delete(controller);
  }

  /** Open an external http(s) URL in the default browser. */
  openExternal(url: string): void {
    if (!/^https?:\/\//i.test(url)) {
      return;
    }
    try {
      const requireFn = (
        typeof require === "function"
          ? require
          : (globalThis as { require?: (id: string) => unknown }).require
      ) as ((id: string) => unknown) | undefined;
      const electron = requireFn?.("electron") as
        | { shell?: { openExternal?: (url: string) => unknown } }
        | undefined;
      if (typeof electron?.shell?.openExternal === "function") {
        void electron.shell.openExternal(url);
        return;
      }
    } catch {
      // Fall through to window.open below.
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /** Open the Obsidian settings panel (plugin tab may need a manual pick). */
  openSettingsTab(): void {
    const setting = (this.app as unknown as { setting?: { open?: () => void } })
      .setting;
    setting?.open?.();
  }

  /**
   * Start the loopback Capture Bridge after settings/CLI are ready. A
   * port collision records `port_conflict`; every other plugin feature
   * stays usable. `browserConnectorEnabled` defaults to true for legacy
   * `data.json` files.
   */
  private initializeCaptureBridge(): void {
    this.captureBridge?.stop();
    this.captureBridge = undefined;
    this.webCaptureActions = undefined;

    if (!browserConnectorEnabledOf(this.settings)) {
      this.browserConnectorStatus = "disabled";
      return;
    }
    const client = this.getCliClient();
    if (client === undefined) {
      this.browserConnectorStatus = "disabled";
      return;
    }
    const adapter = this.app.vault?.adapter as { getBasePath?(): string } | undefined;
    const vaultRoot =
      typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : undefined;
    if (vaultRoot === undefined) {
      this.browserConnectorStatus = "disabled";
      return;
    }
    this.webCaptureActions = new WebCaptureActions({
      client,
      vaultRoot,
      onChanged: (result) => {
        this.libraryIndex?.scanAll();
        if (result.status === "created" || result.status === "existing") {
          this.focusPaperInLibrary(
            result.citationKey,
            result.status === "created" ? result.path : undefined,
          );
        }
      },
    });
    this.captureBridge = new CaptureBridge({
      handler: (request) => {
        const actions = this.webCaptureActions;
        if (actions === undefined) {
          return Promise.resolve({
            status: "unavailable",
            reason: "Capture bridge is not ready.",
          });
        }
        return actions.submitCapture(request);
      },
      onStatusChange: (status) => {
        this.browserConnectorStatus = status;
      },
    });
    void this.captureBridge.start().then((result) => {
      this.browserConnectorStatus = result.status;
    });
  }

  getBrowserConnectorStatus(): CaptureBridgeStatus {
    return this.browserConnectorStatus;
  }

  /** Toggle the Browser Connector; persists via settings. */
  async setBrowserConnectorEnabled(enabled: boolean): Promise<void> {
    this.settings.browserConnectorEnabled = enabled;
    await this.saveSettings();
    this.initializeCaptureBridge();
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
    this.libraryView?.refreshData();
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
    void this.scanMocs();
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
      void this.scanMocs();
      this.libraryView?.refreshData();
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
      getParsedMocs: () => Array.from(this.mocCache.values()),
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
      getRecentReads: (limit?: number) => {
        const records = this.libraryIndex?.getRecords();
        return this.recentActivity?.getRecentReads(limit, records) ?? [];
      },
      getRecentImports: (limit?: number) => {
        const records = this.libraryIndex?.getRecords();
        return this.recentActivity?.getRecentImports(limit, records) ?? [];
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
    this.handleMocVaultEvent(event, path, oldPath);
    // Data-only refresh: a vault event (e.g. the reading-status CLI write)
    // must not rebuild the page shell, or an open Detail Drawer flashes.
    this.libraryView?.refreshData();
  }

  /**
   * Initialize persistent recent activity store (Task: R2).
   * Safe in headless/test contexts where loadData/saveData are missing.
   */
  private async initializeRecentActivity(): Promise<void> {
    const bridge: ActivityStorageBridge = {
      loadData: async () =>
        typeof this.loadData === "function" ? this.loadData() : {},
      saveData: async (data: unknown) => {
        if (typeof this.saveData === "function") {
          await this.saveData(data);
        }
      },
    };
    this.recentActivity = new RecentActivityStore({ bridge });
    await this.recentActivity.load();
    this.registerFileOpenTracking();
  }

  /**
   * Register workspace `file-open` event listener for reading tracking (Contract 1).
   * Protects against layout restoration file-open events by waiting for
   * `workspace.onLayoutReady` when layout is not yet ready (Contract 4).
   */
  private registerFileOpenTracking(): void {
    const workspace = this.app?.workspace;
    if (workspace === undefined || typeof workspace.on !== "function") {
      return;
    }
    if (typeof this.registerEvent !== "function") {
      return;
    }

    let isLayoutReady = workspace.layoutReady === true;
    if (!isLayoutReady && typeof workspace.onLayoutReady === "function") {
      workspace.onLayoutReady(() => {
        isLayoutReady = true;
      });
    } else if (workspace.layoutReady === undefined) {
      // In minimal test environments without layoutReady property, treat as ready.
      isLayoutReady = true;
    }

    this.registerEvent(
      workspace.on("file-open", (file: unknown) => {
        if (!isLayoutReady) {
          return;
        }
        const path =
          typeof file === "object" &&
          file !== null &&
          "path" in file &&
          typeof (file as { path: unknown }).path === "string"
            ? (file as { path: string }).path
            : undefined;
        if (!path) {
          return;
        }
        this.handleFileOpen(path);
      }),
    );
  }

  /**
   * Handle an opened file path.
   * Only records Primary PDF and Figure notes matching canonical paper directory (Contract 3).
   */
  handleFileOpen(path: string): void {
    const classified = classifyOpenedFile(this.settings.literatureRoot, path);
    if (classified === null) {
      return;
    }
    const root = this.settings.literatureRoot.replace(/\/+$/, "");
    const canonicalNotePath = `${root}/${classified.key}/${classified.key}.md`;
    void this.recentActivity
      ?.recordRead({
        key: classified.key,
        path: canonicalNotePath,
        kind: classified.kind,
      })
      .then(() => {
        this.libraryView?.refreshData();
      });
  }

  /** Expose recent activity store for tests/diagnostic querying. */
  getRecentActivityStore(): RecentActivityStore | undefined {
    return this.recentActivity;
  }

  /** Query top N recent reads validated against active library records. */
  getRecentReads(limit?: number): RecentReadEntry[] {
    const records = this.libraryIndex?.getRecords();
    return this.recentActivity?.getRecentReads(limit, records) ?? [];
  }

  /** Query top N recent imports validated against active library records. */
  getRecentImports(limit?: number): RecentImportEntry[] {
    const records = this.libraryIndex?.getRecords();
    return this.recentActivity?.getRecentImports(limit, records) ?? [];
  }

  private isMocPath(path: string): boolean {
    const root = this.settings.literatureRoot.replace(/\/$/u, "");
    const mocDir = `${root}/MOCs`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    return parent === mocDir && path.endsWith(".md");
  }

  private async scanMocs(): Promise<void> {
    const vault = this.app.vault;
    if (!vault) return;
    const root = this.settings.literatureRoot.replace(/\/$/u, "");
    const mocDir = `${root}/MOCs`;
    const files = vault.getMarkdownFiles().filter((file) => {
      const parent = file.path.slice(0, file.path.lastIndexOf("/"));
      return parent === mocDir;
    });
    const nextMap = new Map<string, ParsedMoc>();
    await Promise.all(
      files.map(async (file) => {
        try {
          const text = await vault.cachedRead(file);
          const parsed = parseMocNote(file.path, text);
          if (parsed) {
            nextMap.set(file.path, parsed);
          }
        } catch {
          // File read error ignored
        }
      }),
    );
    this.mocCache = nextMap;
    this.libraryView?.refreshData();
  }

  private handleMocVaultEvent(
    event: IndexVaultEvent,
    path: string,
    oldPath?: string,
  ): void {
    const isMoc = this.isMocPath(path);
    const wasMoc = oldPath !== undefined && this.isMocPath(oldPath);
    if (!isMoc && !wasMoc) {
      return;
    }

    if (event === "delete") {
      this.mocCache.delete(path);
      this.libraryView?.refreshData();
      return;
    }

    if (event === "rename") {
      if (oldPath) {
        this.mocCache.delete(oldPath);
      }
      if (!isMoc) {
        this.libraryView?.refreshData();
        return;
      }
    }

    const vault = this.app.vault;
    if (!vault) return;
    const file = vault.getAbstractFileByPath(path);
    if (file && "extension" in file && file.extension === "md") {
      void vault.cachedRead(file as TFile).then((text) => {
        const parsed = parseMocNote(path, text);
        if (parsed) {
          this.mocCache.set(path, parsed);
        } else {
          this.mocCache.delete(path);
        }
        this.libraryView?.refreshData();
      }).catch(() => {
        // Ignore read error
      });
    }
  }

  private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
    const workspace = this.app.workspace;
    if (!workspace) return false;

    if (typeof leaf.getRoot === "function") {
      try {
        const root = leaf.getRoot();
        if (root && (root === workspace.leftSplit || root === workspace.rightSplit)) {
          return true;
        }
        if (root && workspace.rootSplit && root === workspace.rootSplit) {
          return false;
        }
      } catch {
        // Fall through to parent traversal
      }
    }

    let current: unknown = leaf.parent;
    while (current) {
      if (current === workspace.leftSplit || current === workspace.rightSplit) {
        return true;
      }
      if (workspace.rootSplit && current === workspace.rootSplit) {
        return false;
      }
      current = (current as { parent?: unknown }).parent;
    }

    return false;
  }

  async activateLibraryView(): Promise<void> {
    const workspace = this.app.workspace;
    if (!workspace) return;

    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PAPER_NOTES);

    // 1. If an existing Library leaf is in the central workspace, reuse it.
    const centralLeaf = leaves.find((leaf) => !this.isSidebarLeaf(leaf));
    if (centralLeaf) {
      await workspace.revealLeaf(centralLeaf);
      if (typeof (centralLeaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred === "function") {
        await (centralLeaf as unknown as { loadIfDeferred: () => Promise<void> }).loadIfDeferred();
      }
      if (centralLeaf.view instanceof PaperNotesLibraryView) {
        centralLeaf.view.showPage("library");
      }
      return;
    }

    // 2. If a Library leaf exists in a sidebar, migrate it to the central workspace.
    const sidebarLeaf = leaves.find((leaf) => this.isSidebarLeaf(leaf));
    if (sidebarLeaf) {
      const oldViewState = typeof sidebarLeaf.getViewState === "function"
        ? sidebarLeaf.getViewState()
        : undefined;
      const oldState = {
        ...(oldViewState?.state ?? {}),
        ...(sidebarLeaf.view instanceof PaperNotesLibraryView ? sidebarLeaf.view.getState() : {}),
      };
      const newViewState = {
        ...oldViewState,
        type: VIEW_TYPE_PAPER_NOTES,
        active: true,
        state: Object.keys(oldState).length > 0 ? oldState : { page: "library" },
      };

      const newLeaf = workspace.getLeaf(true);
      await newLeaf.setViewState(newViewState);
      await workspace.revealLeaf(newLeaf);
      if (typeof (newLeaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred === "function") {
        await (newLeaf as unknown as { loadIfDeferred: () => Promise<void> }).loadIfDeferred();
      }
      for (const leaf of leaves) {
        if (leaf !== newLeaf && this.isSidebarLeaf(leaf) && typeof leaf.detach === "function") {
          leaf.detach();
        }
      }
      return;
    }

    // 3. No leaf exists: create a new tab in the central workspace.
    const newLeaf = workspace.getLeaf(true);
    await newLeaf.setViewState({ type: VIEW_TYPE_PAPER_NOTES, active: true });
    await workspace.revealLeaf(newLeaf);
    if (typeof (newLeaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred === "function") {
      await (newLeaf as unknown as { loadIfDeferred: () => Promise<void> }).loadIfDeferred();
    }
    if (newLeaf.view instanceof PaperNotesLibraryView) {
      newLeaf.view.showPage("library");
    }
  }

  /** Legacy command/button entry: route to the existing plugin navigation. */
  async activateMocView(): Promise<void> {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PAPER_NOTES);
    const leaf = leaves[0] ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    if (leaves.length === 0) {
      await leaf.setViewState({ type: VIEW_TYPE_PAPER_NOTES, active: true, state: { page: "moc" } });
    }
    await workspace.revealLeaf(leaf);
    if (typeof (leaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred === "function") {
      await (leaf as unknown as { loadIfDeferred: () => Promise<void> }).loadIfDeferred();
    }
    if (leaf.view instanceof PaperNotesLibraryView) {
      leaf.view.showPage("moc");
    }
  }

  private createMocViewSource(): MocDirectorySource {
    const plugin = this;
    return {
      get literatureRoot() { return plugin.settings.literatureRoot; },
      readText: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !("extension" in file) || file.extension !== "md") return "";
        try {
          return await this.app.vault.cachedRead(file as TFile);
        } catch (error) {
          // A rename/delete between listing and reading is not a page failure.
          if (!this.app.vault.getAbstractFileByPath(path)) return "";
          throw error;
        }
      },
      listMarkdownFiles: (dir: string) => this.app.vault.getMarkdownFiles()
        .filter((file) => file.path.slice(0, file.path.lastIndexOf("/")) === dir)
        .map((file) => file.name),
      openNote: (path, newTab, signal) => openMocNote(this.app, path, newTab, signal),
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
                  resolve(undefined);
                  return;
                }
                try {
                  const actions = new ItemActions({ client, vaultRoot });
                  const result = await actions.createMoc(trimmed);
                  new Notice(mocCreateNoticeText(result.outcome, result.title));
                  // CLI writes are external: allow Obsidian's file watcher to
                  // catch up before refreshing/opening the newly created note.
                  if (result.path) {
                    for (let attempt = 0; attempt < 20; attempt++) {
                      if (this.app.vault.getAbstractFileByPath(result.path)) break;
                      await new Promise((done) => setTimeout(done, 100));
                    }
                  }
                  resolve(result.path);
                } catch (error) {
                  new Notice(`无法创建主题：${String(error)}`);
                  resolve(undefined);
                }
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
   * Export the active Markdown note as DOCX through Pandoc (Task 29).
   * Preflight blocks on unknown citation keys, the fixed global output
   * directory, Pandoc, the selected CSL style and the reference DOCX
   * before anything launches; an existing target asks for explicit
   * confirmation via the export modal. The export itself writes to a
   * temporary file and atomically publishes on exit 0.
   */
  private async exportActiveNote(): Promise<void> {
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
      format: "docx",
      exportDirectory: cfg.exportDirectory,
      pandocPath: cfg.pandocPath,
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
      "docx",
    );
    const targetExists = await ports.fs.exists(targetPath);
    const markdownPath = adapter.getFullPath(activeFile.path);
    const cslPath = adapter.getFullPath(health.cslPath);
    const engineLabel =
      health.referenceDocx.length > 0
        ? `Reference DOCX: ${health.referenceDocx}`
        : "Reference DOCX: Pandoc default";

    try {
      const modal = createExportConfirmationModal(
        this.app,
        {
          format: "docx",
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
                format: "docx",
                baseName: activeFile.basename,
                markdown,
                markdownPath,
                exportDirectory: health.exportDirectory,
                pandocPath: health.pandocPath,
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

  /** Get or initialize the literature card creation service. */
  getCardCreationService(): CardCreationService {
    if (this.cardCreationService) {
      return this.cardCreationService;
    }
    const client = this.getCliClient();
    const adapter = this.app.vault?.adapter as unknown as {
      getBasePath?(): string;
      readBinary?(path: string): Promise<ArrayBuffer>;
    };
    const vaultRoot = adapter?.getBasePath?.() ?? "";

    this.cardCreationService = new CardCreationService({
      client: client ?? new CliClient(this.settings.cliPath),
      vaultRoot,
      readBinary: async (path: string) => {
        if (typeof adapter?.readBinary === "function") {
          return adapter.readBinary(path);
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (
          file &&
          typeof (
            this.app.vault as unknown as {
              readBinary?: (f: unknown) => Promise<ArrayBuffer>;
            }
          ).readBinary === "function"
        ) {
          return (
            this.app.vault as unknown as {
              readBinary: (f: unknown) => Promise<ArrayBuffer>;
            }
          ).readBinary(file);
        }
        throw new Error("无法读取文件二进制内容。");
      },
      saveView: async (v) => {
        if (typeof v.save === "function") {
          await v.save();
        }
      },
      reloadSourceNote: async (v, path) => {
        if (
          typeof (v as unknown as { reload?: () => Promise<void> | void })
            .reload === "function"
        ) {
          await (
            v as unknown as { reload: () => Promise<void> | void }
          ).reload();
        } else if (
          v.leaf &&
          typeof (
            v.leaf as unknown as {
              openFile?: (f: unknown, opts?: unknown) => Promise<void>;
            }
          ).openFile === "function"
        ) {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (f) {
            await (
              v.leaf as unknown as {
                openFile: (f: unknown, opts?: unknown) => Promise<void>;
              }
            ).openFile(f, { active: false });
          }
        }
      },
      freezeEditor: (v) => defaultFreezeEditor(v),
      openCard: async (path: string) => {
        let cardFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (!cardFile) {
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((done) => setTimeout(done, 100));
            cardFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
            if (cardFile) break;
          }
        }
        const workspace = this.app.workspace as unknown as {
          getLeaf?: (type?: string | boolean) => WorkspaceLeaf;
        };
        const leaf = workspace.getLeaf?.("tab") ?? this.app.workspace.getLeaf(true);
        if (cardFile && typeof (leaf as unknown as { openFile?: (f: unknown) => Promise<void> }).openFile === "function") {
          await (leaf as unknown as { openFile: (f: unknown) => Promise<void> }).openFile(cardFile);
        }
        const cardView = (leaf as unknown as { view?: MarkdownView }).view;
        return {
          editor: cardView?.editor
            ? {
                getValue: () => cardView.editor.getValue(),
                setCursor: (pos) => cardView.editor.setCursor(pos),
                focus: () => cardView.editor.focus(),
              }
            : undefined,
        };
      },
      showNotice: (msg, dur) => {
        new Notice(msg, dur);
      },
    });
    return this.cardCreationService;
  }

  setCardCreationService(service: CardCreationService): void {
    this.cardCreationService = service;
  }

  /** Launch the Literature Card creation modal for the active selection. */
  async createLiteratureCardFromEditor(
    view: MarkdownView,
    editor: Editor,
    figureInfo?: FigureSourceInfo,
  ): Promise<void> {
    const client = this.getCliClient();
    if (this.isReadOnly() || client === undefined) {
      new Notice("paper-notes CLI 不可用或处于只读模式，无法创建卡片。");
      return;
    }

    const adapter = this.app.vault?.adapter as unknown as {
      getBasePath?(): string;
    };
    const vaultRoot = adapter?.getBasePath?.();
    if (!vaultRoot) {
      new Notice("无法获取 Vault 绝对路径。");
      return;
    }

    const file = view.file;
    if (!file) {
      new Notice("未找到当前笔记文件。");
      return;
    }

    const parsedInfo =
      figureInfo ??
      parseFigureSource(file.path, this.settings.literatureRoot);
    if (!parsedInfo) {
      new Notice("当前笔记不是 Figure 解读笔记（路径不匹配）。");
      return;
    }

    if (!isSourceOrLivePreview(view)) {
      new Notice("仅在源码模式或实时预览模式下可用，阅读视图不支持创建卡片。");
      return;
    }

    const selection = editor.getSelection();
    if (!selection || selection.trim().length === 0) {
      new Notice("请先选择需要创建卡片的文本。");
      return;
    }

    const service = this.getCardCreationService();
    if (service.isBusy()) {
      new Notice("卡片创建正在进行中，请稍候。");
      return;
    }

    const modal = new LiteratureCardModal(this.app, {
      sourceSelection: selection,
      onSubmit: async (title: string) => {
        const controller = new AbortController();
        this.runningCardCreations.add(controller);
        try {
          const res = await service.createCard({
            view: {
              file: view.file,
              editor,
              getMode: () => view.getMode(),
              getState: () => view.getState(),
              save: () => view.save(),
              containerEl: view.containerEl,
              leaf: view.leaf,
            },
            literatureRoot: this.settings.literatureRoot,
            title,
            signal: controller.signal,
          });
          return res.ok;
        } finally {
          this.runningCardCreations.delete(controller);
        }
      },
    });
    modal.open();
  }
}
