/**
 * Literature Library view (Task 24).
 *
 * The ItemView renders the Zotero-like library inside Obsidian: search box,
 * filter bar, sortable table and a read-only detail panel. All query logic
 * lives in the pure components (`library-table`, `library-filters`,
 * `paper-detail`) and is covered by `tests/library-query.test.ts`; this file
 * is thin DOM wiring over that model.
 *
 * Data flows in through `LibraryViewSource` (provided by main.ts): index
 * records, raw frontmatter (reading status), the paper-directory listing
 * (artifact availability) and an optional volatile metrics provider. The
 * view additionally resolves the plugin bridge lazily (Task 25 actions,
 * Task 26 metrics cache) and wires the EasyScholar badge cache into the
 * table. Nothing here ever writes back to the vault; metrics are UI data
 * only and every CLI call is the read-only `metrics query`.
 */

import { ItemView, Notice, WorkspaceLeaf, type TFile } from "obsidian";

import type { InvalidRecord, PaperRecord } from "../types/paper";
import {
  DEFAULT_SETTINGS,
  metricsEnabledOf,
  type PaperNotesSettings,
} from "../settings";
import { CliClient } from "../services/cli-client";
import {
  MetricsCache,
  type CachedMetricsEntry,
  type RefreshResult,
} from "../services/metrics-cache";
import {
  metricBadgeStateOf,
  renderMetricBadge,
  type MetricKind,
} from "../components/metric-cell";
import {
  ItemActions,
  buildDeletePreview,
  nextReadingStatus,
  openCard,
  paperDirectoryOf,
  renderPlanLines,
  resolveOpenTarget,
  type ActionOutcome,
  type CreateItemInput,
  type OpenAssetKind,
  type OpenTarget,
} from "../services/item-actions";
// Modal classes are loaded lazily (see `loadModalClasses`): the plugin
// scaffold smoke suite mocks `obsidian` with Plugin/ItemView/WorkspaceLeaf
// plus Modal/Notice, so the static import graph must not construct the
// modals' classes at import time. `Notice` is imported statically
// (Repair: Gate D R8 — dynamic `import("obsidian")` fails in the CJS
// bundle; the smoke mock provides `Notice`).
import type { CreateItemCallbacks } from "../modals/create-item-modal";
import {
  buildLibraryItems,
  clampColumnWidth,
  formatColumnValue,
  resolveColumns,
  searchLibraryItems,
  sortLibraryItems,
  type ColumnCustomizations,
  type LibraryColumnId,
  type LibraryItem,
  type LibrarySort,
  type PaperMetrics,
} from "../components/library-table";
import {
  EMPTY_LIBRARY_FILTERS,
  applyLibraryFilters,
  countActiveAdvancedFilters,
  hasActiveAdvancedFilters,
  type ArtifactPart,
  type LibraryFilters,
} from "../components/library-filters";
import { buildPaperDetail } from "../components/paper-detail";

export const VIEW_TYPE_PAPER_NOTES = "paper-notes-open-library";

/**
 * Debounce window before an on-demand MinerU full-text search fires
 * (Repair: Task 23 R7). The synchronous metadata filter renders
 * immediately; only a query that stays put for this long triggers the
 * async MinerU pass, so rapid typing collapses into one search.
 */
export const FULL_TEXT_SEARCH_DEBOUNCE_MS = 300;

/** Plugin id from manifest.json; the view reads the CLI bridge off it. */
const PLUGIN_ID = "paper-notes";

/** Command ids registered by the view (main.ts is frozen; Task 26). */
const REFRESH_JOURNAL_COMMAND = "paper-notes-refresh-journal-metrics";
const REFRESH_ALL_COMMAND = "paper-notes-refresh-all-metrics";

/** Long abstracts in the drawer truncate at this many characters. */
const ABSTRACT_TRUNCATE_CHARS = 600;

/**
 * Delay before a row single-click opens the Detail Drawer. Browsers fire
 * two `click` events before `dblclick`; without this window a double-click
 * that should only open the Primary PDF would briefly flash the drawer
 * (CONSENSUS / RISKS R5). 280ms sits in the approved 250–300ms band.
 */
const ROW_CLICK_DELAY_MS = 280;

/** Map the four metric columns onto their badge kinds. */
const METRIC_COLUMN_KINDS: Partial<Record<LibraryColumnId, MetricKind>> = {
  cas: "cas",
  jcr: "jcr",
  if: "if",
  jci: "jci",
};

/** Plugin-side bridge the view resolves lazily from the app registry. */
interface PluginBridge {
  client: CliClient | undefined;
  settings: PaperNotesSettings;
  loadData?: () => Promise<unknown>;
  saveData?: (data: unknown) => Promise<void>;
  addCommand?: (command: {
    id: string;
    name: string;
    callback: () => void;
  }) => void;
}

export interface LibraryViewSource {
  /** Canonical, validated paper records from the in-memory index. */
  getRecords(): PaperRecord[];
  /** Invalid-metadata records (kept visible with diagnostics, §17.1). */
  getInvalidRecords(): InvalidRecord[];
  /** Raw frontmatter per path (reading status is read from here). */
  getFrontmatter(path: string): Record<string, unknown> | undefined;
  /** Basenames of the paper directory (`<root>/<key>/`). */
  listDirectory(dir: string): string[];
  /**
   * Card-note basenames (`*.md`, sorted) under one paper directory's
   * `cards/` subdirectory. Interface reservation: a future independent
   * card data source may replace the directory-listing implementation;
   * callers (detail Cards block, single-card quick open) stay unchanged.
   */
  getCards(dir: string): string[];
  /** Volatile EasyScholar metrics per paper id (Task 26 wires the cache). */
  getMetrics?(paperId: string): PaperMetrics | undefined;
  /**
   * Explicit on-demand MinerU full-text search (design spec §9.4): reads
   * `minerUmd_<key>.md` for records not matched by default fields. The
   * optional signal cancels an in-flight search (rejects with
   * `SearchCancelledError`). Absent in legacy/read-only sources: the view
   * then degrades to metadata-only search.
   */
  searchFullText?(
    query: string,
    signal?: AbortSignal,
  ): Promise<PaperRecord[]>;
}

interface ModalClasses {
  CreateItemModal: typeof import("../modals/create-item-modal").CreateItemModal;
  ConfirmationModal: typeof import("../modals/confirmation-modal").ConfirmationModal;
  TextPromptModal: typeof import("../modals/confirmation-modal").TextPromptModal;
  DeleteItemModal: typeof import("../modals/delete-item-modal").DeleteItemModal;
}

export class PaperNotesLibraryView extends ItemView {
  private searchQuery = "";
  private filters: LibraryFilters = { ...EMPTY_LIBRARY_FILTERS };
  private sort: LibrarySort = { columnId: "year", direction: "desc" };
  private selectedPath: string | undefined;
  private isOpen = false;
  private tableHost: HTMLElement | null = null;
  /** Lazily resolved CLI-backed item actions (Task 25). */
  private itemActions: ItemActions | undefined;
  private actionsResolved = false;
  /** Lazily resolved EasyScholar metric cache (Task 26). */
  private metricsCache: MetricsCache | undefined;
  private metricsResolved = false;
  /** paperId -> record map rebuilt per query (metrics lookups by id). */
  private recordsById = new Map<string, PaperRecord>();
  /** Lazily loaded modal classes (kept off the static import graph). */
  private modalClasses: ModalClasses | undefined;
  /** Pending on-demand full-text debounce timer (Repair: Task 23 R7). */
  private fullTextTimer: ReturnType<typeof setTimeout> | undefined;
  /** Abort controller of the in-flight full-text search (cancelled on re-query). */
  private fullTextController: AbortController | undefined;
  /** Extra rows appended by the last completed full-text search. */
  private fullTextItems: LibraryItem[] = [];
  /**
   * Query the `fullTextItems` were produced for. Results for an older
   * query are stale and must never be merged into the current view.
   */
  private fullTextQuery: string | undefined;
  /** Lightweight "Searching MinerU full text…" indicator state. */
  private fullTextSearching = false;
  /**
   * Advanced filter disclosure. `undefined` = follow auto policy
   * (open when any advanced condition is active); boolean = user override.
   */
  private advancedFiltersExpanded: boolean | undefined = undefined;
  private drawerHost: HTMLElement | null = null;
  private drawerOpen = false;
  private boundDrawerKey: ((event: KeyboardEvent) => void) | null = null;
  /** Pending single-click → drawer timer (cleared on dblclick / close). */
  private rowClickTimer: ReturnType<typeof setTimeout> | undefined;
  /** Long-abstract Expand toggle inside the drawer (per-open state). */
  private abstractExpanded = false;
  /**
   * Per-column width customizations (Batch 2 D). Seeded once from the
   * plugin settings (data.json `columnWidths`); the drag handler updates
   * it live and persists via merge-save.
   */
  private columnWidths: ColumnCustomizations = {};
  private columnWidthsSeeded = false;
  /** Active column resize session (null when not dragging). */
  private columnResize: {
    columnId: LibraryColumnId;
    th: HTMLElement;
    startX: number;
    startWidth: number;
  } | null = null;
  private boundColumnPointerMove: ((event: PointerEvent) => void) | null =
    null;
  private boundColumnPointerUp: ((event: PointerEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly source: LibraryViewSource) {
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
    this.isOpen = true;
    this.render();
    // Background refresh of missing/expired journal metrics (deduplicated
    // inside the cache; the first render already showed cached values).
    void this.refreshAllExpired();
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
    this.cancelFullTextSearch();
    this.clearRowClickTimer();
    this.detachDrawerKeyHandler();
    this.columnResize = null;
    if (typeof document !== "undefined") {
      if (this.boundColumnPointerMove !== null) {
        document.removeEventListener("pointermove", this.boundColumnPointerMove);
      }
      if (this.boundColumnPointerUp !== null) {
        document.removeEventListener("pointerup", this.boundColumnPointerUp);
      }
    }
    this.boundColumnPointerMove = null;
    this.boundColumnPointerUp = null;
    this.fullTextItems = [];
    this.fullTextQuery = undefined;
    this.tableHost = null;
    this.drawerHost = null;
    this.drawerOpen = false;
    this.containerEl.empty();
  }

  /** Re-render after vault events; a no-op while the view is closed. */
  refresh(): void {
    if (this.isOpen) {
      this.render();
    }
  }

  private render(): void {
    const container = this.containerEl;
    container.empty();
    container.addClass("paper-notes-library");

    const toolbar = container.createDiv({ cls: "paper-notes-library-toolbar" });
    const search = toolbar.createEl("input", {
      cls: "paper-notes-library-search",
      attr: {
        type: "search",
        placeholder:
          "Search title, author, journal, year, DOI/PMID, citation key, abstract",
      },
    });
    search.value = this.searchQuery;
    search.addEventListener("input", () => {
      this.searchQuery = search.value;
      this.renderResults();
      this.scheduleFullTextSearch();
    });
    const clear = toolbar.createEl("button", {
      cls: "paper-notes-library-clear",
      text: "Clear filters",
    });
    clear.addEventListener("click", () => {
      this.filters = { ...EMPTY_LIBRARY_FILTERS };
      // Clearing advanced conditions drops any manual expand override so
      // the Advanced block returns to the default collapsed state.
      this.advancedFiltersExpanded = undefined;
      this.render();
    });
    const create = toolbar.createEl("button", {
      cls: "paper-notes-library-create mod-cta",
      text: "Create item",
    });
    create.addEventListener("click", () => void this.runCreate());

    this.renderFilterBar(container);

    // Full-width table shell: no resident detail pane, no splitter. The
    // detail surface is the overlay drawer, opened by single-clicking a
    // row (after a short click/dblclick disambiguation delay) and closed
    // via Esc / backdrop / Close (any leaf width). Double-click opens
    // only the Primary PDF.
    this.tableHost = container.createDiv({
      cls: "paper-notes-library-table-host",
    });

    // Detail drawer host (Batch 1): reuses renderDetailInto.
    this.drawerHost = container.createDiv({
      cls: "paper-notes-library-drawer-host",
    });
    if (!this.drawerOpen) {
      this.drawerHost.addClass("is-hidden");
    }

    this.renderResults();
  }

  private renderFilterBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "paper-notes-library-filters" });
    bar.createEl("span", {
      cls: "paper-notes-library-filter-heading",
      text: "Filters",
    });

    // Primary row: Reading + artifact presence (always visible).
    const statusWrap = bar.createDiv({ cls: "paper-notes-library-filter" });
    statusWrap.createEl("label", { text: "Reading" });
    const status = statusWrap.createEl("select");
    for (const [value, label] of [
      ["", "Any"],
      ["unread", "Unread"],
      ["reading", "Reading"],
      ["read", "Read"],
    ] as const) {
      const option = status.createEl("option", { value, text: label });
      if (value === (this.filters.readingStatus ?? "")) {
        option.selected = true;
      }
    }
    status.addEventListener("change", () => {
      const value = status.value;
      this.updateFilters({
        readingStatus:
          value === "" ? undefined : (value as LibraryFilters["readingStatus"]),
      });
    });

    this.artifactCheckbox(bar, "PDF", "pdf");
    this.artifactCheckbox(bar, "MinerU", "minerU");
    this.artifactCheckbox(bar, "Figure", "figure");

    const advancedCount = countActiveAdvancedFilters(this.filters);
    const expanded = this.isAdvancedFiltersExpanded();
    const toggle = bar.createEl("button", {
      cls: "paper-notes-library-advanced-toggle",
      attr: {
        type: "button",
        "aria-expanded": expanded ? "true" : "false",
      },
    });
    const toggleLabel = advancedCount > 0
      ? `Advanced · ${advancedCount}`
      : "Advanced";
    // Prefer textContent: unit-test El stubs may lack setText.
    toggle.textContent = expanded ? `${toggleLabel} ▾` : `${toggleLabel} ▸`;
    toggle.addEventListener("click", () => {
      // Manual override: flip relative to the current effective state.
      this.advancedFiltersExpanded = !this.isAdvancedFiltersExpanded();
      this.render();
    });

    if (!expanded) {
      return;
    }

    const advanced = bar.createDiv({
      cls: "paper-notes-library-filters-advanced",
    });
    this.filterNumberInput(
      advanced,
      "Year from",
      this.filters.yearFrom,
      (value) => this.updateFilters({ yearFrom: value }),
    );
    this.filterNumberInput(
      advanced,
      "Year to",
      this.filters.yearTo,
      (value) => this.updateFilters({ yearTo: value }),
    );
    this.filterTextInput(
      advanced,
      "Journal",
      this.filters.journal,
      (value) => this.updateFilters({ journal: value }),
    );
    this.filterTextInput(
      advanced,
      "CAS",
      this.filters.cas,
      (value) => this.updateFilters({ cas: value }),
    );
    this.filterTextInput(
      advanced,
      "JCR",
      this.filters.jcr,
      (value) => this.updateFilters({ jcr: value }),
    );
    this.filterNumberInput(
      advanced,
      "IF min",
      this.filters.ifMin,
      (value) => this.updateFilters({ ifMin: value }),
    );
    this.filterNumberInput(
      advanced,
      "IF max",
      this.filters.ifMax,
      (value) => this.updateFilters({ ifMax: value }),
    );
    this.filterNumberInput(
      advanced,
      "JCI min",
      this.filters.jciMin,
      (value) => this.updateFilters({ jciMin: value }),
    );
    this.filterNumberInput(
      advanced,
      "JCI max",
      this.filters.jciMax,
      (value) => this.updateFilters({ jciMax: value }),
    );
  }

  private filterTextInput(
    bar: HTMLElement,
    label: string,
    initial: string | undefined,
    apply: (value: string | undefined) => void,
  ): void {
    const wrap = bar.createDiv({ cls: "paper-notes-library-filter" });
    wrap.createEl("label", { text: label });
    const input = wrap.createEl("input", { attr: { type: "text" } });
    if (initial !== undefined && initial.length > 0) {
      input.value = initial;
    }
    input.addEventListener("input", () => {
      const value = input.value.trim();
      apply(value.length === 0 ? undefined : value);
    });
  }

  private filterNumberInput(
    bar: HTMLElement,
    label: string,
    initial: number | undefined,
    apply: (value: number | undefined) => void,
  ): void {
    const wrap = bar.createDiv({ cls: "paper-notes-library-filter" });
    wrap.createEl("label", { text: label });
    const input = wrap.createEl("input", { attr: { type: "number" } });
    if (initial !== undefined) {
      input.value = String(initial);
    }
    input.addEventListener("input", () => apply(this.parseNumber(input.value)));
  }

  private artifactCheckbox(
    bar: HTMLElement,
    label: string,
    part: ArtifactPart,
  ): void {
    const wrap = bar.createDiv({ cls: "paper-notes-library-filter" });
    const input = wrap.createEl("input", {
      attr: { type: "checkbox" },
    });
    if (this.filters.requiredArtifacts.includes(part)) {
      input.checked = true;
    }
    wrap.createEl("label", { text: label });
    input.addEventListener("change", () => {
      const current = this.filters.requiredArtifacts;
      const next = current.includes(part)
        ? current.filter((existing) => existing !== part)
        : [...current, part];
      this.updateFilters({ requiredArtifacts: next });
    });
  }

  private parseNumber(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }

  private updateFilters(patch: Partial<LibraryFilters>): void {
    const beforeAdvanced = hasActiveAdvancedFilters(this.filters);
    this.filters = { ...this.filters, ...patch };
    const afterAdvanced = hasActiveAdvancedFilters(this.filters);
    // Newly-activated advanced conditions force a re-open unless the user
    // has an explicit collapse override *and* the count was already > 0.
    // First activation always expands (policy D).
    if (afterAdvanced && !beforeAdvanced) {
      this.advancedFiltersExpanded = true;
      this.render();
      return;
    }
    // If the Advanced block is currently showing, keep inputs in sync by
    // re-rendering the bar; primary-only changes only need the table.
    if (this.isAdvancedFiltersExpanded()) {
      this.render();
      return;
    }
    this.renderResults();
  }

  private toggleSort(columnId: LibraryColumnId): void {
    if (this.sort.columnId === columnId) {
      this.sort = {
        columnId,
        direction: this.sort.direction === "asc" ? "desc" : "asc",
      };
    } else {
      this.sort = { columnId, direction: "asc" };
    }
    this.renderResults();
  }

  private queryItems(): LibraryItem[] {
    const records = this.source.getRecords();
    this.recordsById = new Map(records.map((record) => [record.paperId, record]));
    const searched = searchLibraryItems(
      this.buildItems(records, this.source.getInvalidRecords()),
      this.searchQuery,
    );
    const filtered = applyLibraryFilters(searched, this.filters);
    const sorted = sortLibraryItems(filtered, this.sort);
    const extras = this.fullTextExtras(filtered);
    return extras.length === 0 ? sorted : [...sorted, ...extras];
  }

  /**
   * Assemble display items for a record set with the view's volatile data
   * (frontmatter, artifact listing, metric cache). Used by both the
   * metadata pipeline (with the index's invalid rows) and the on-demand
   * full-text pass (full-text hits are always valid records).
   */
  private buildItems(
    records: PaperRecord[],
    invalidRecords: InvalidRecord[],
  ): LibraryItem[] {
    const cache = this.getMetricsCache();
    return buildLibraryItems(records, invalidRecords, {
      frontmatter: (path) => this.source.getFrontmatter(path),
      listDirectory: (dir) => this.source.listDirectory(dir),
      metrics: (paperId) => {
        const record = this.recordsById.get(paperId);
        const cached =
          record !== undefined ? cache?.getEntryFor(record) : undefined;
        return cached?.metrics ?? this.source.getMetrics?.(paperId);
      },
    });
  }

  /**
   * Full-text rows for the CURRENT query, deduplicated against the
   * metadata rows and still subject to the active filters. Rows produced
   * for an older query are stale and never merged.
   */
  private fullTextExtras(filtered: LibraryItem[]): LibraryItem[] {
    if (
      this.fullTextItems.length === 0 ||
      this.fullTextQuery !== this.searchQuery
    ) {
      return [];
    }
    const metadataPaths = new Set(filtered.map((item) => item.path));
    return this.fullTextItems.filter(
      (item) =>
        !metadataPaths.has(item.path) &&
        applyLibraryFilters([item], this.filters).length === 1,
    );
  }

  /**
   * On-demand MinerU full-text search (design spec §9.4; Repair: Task 23
   * R7): the synchronous metadata filter above already rendered; a
   * debounced async pass reads `minerUmd_<key>.md` for records the
   * metadata missed and appends any full-text hits. Sources without a
   * full-text bridge stay metadata-only. Emptying the query cancels any
   * pending search and restores the full list.
   */
  private scheduleFullTextSearch(): void {
    if (this.searchQuery.trim().length === 0) {
      this.cancelFullTextSearch();
      this.fullTextItems = [];
      this.fullTextQuery = undefined;
      this.renderResults();
      return;
    }
    if (this.source.searchFullText === undefined) {
      return;
    }
    if (this.fullTextTimer !== undefined) {
      clearTimeout(this.fullTextTimer);
    }
    this.fullTextTimer = setTimeout(
      () => void this.runFullTextSearch(),
      FULL_TEXT_SEARCH_DEBOUNCE_MS,
    );
  }

  /**
   * Run the on-demand full-text search for the current query. Any
   * in-flight request is cancelled first (stale results must never
   * overwrite the newer query's rows); the result is merged only if this
   * query is still the active one. Failures silently fall back to the
   * metadata results already on screen.
   */
  private async runFullTextSearch(): Promise<void> {
    this.fullTextTimer = undefined;
    const query = this.searchQuery;
    const searchFullText = this.source.searchFullText;
    if (query.trim().length === 0 || searchFullText === undefined) {
      return;
    }
    this.fullTextController?.abort();
    const controller = new AbortController();
    this.fullTextController = controller;
    const signal = controller.signal;
    this.fullTextSearching = true;
    this.renderResults();
    try {
      const records = await searchFullText(query, signal);
      if (signal.aborted || query !== this.searchQuery) {
        return; // stale: a newer query superseded this one
      }
      this.fullTextItems = this.buildItems(records, []);
      this.fullTextQuery = query;
    } catch {
      // Full-text search is best-effort: failures silently fall back to
      // the metadata results already rendered (never crash the view).
    } finally {
      if (this.fullTextController === controller) {
        this.fullTextController = undefined;
      }
      this.fullTextSearching = false;
      if (this.isOpen && query === this.searchQuery) {
        this.renderResults();
      }
    }
  }

  /** Cancel a pending debounce and any in-flight full-text request. */
  private cancelFullTextSearch(): void {
    if (this.fullTextTimer !== undefined) {
      clearTimeout(this.fullTextTimer);
      this.fullTextTimer = undefined;
    }
    this.fullTextController?.abort();
    this.fullTextController = undefined;
    this.fullTextSearching = false;
  }

  private renderResults(): void {
    this.renderTable();
    this.renderDetail();
  }

  private renderTable(): void {
    if (this.tableHost === null) {
      return;
    }
    this.tableHost.empty();
    if (this.fullTextSearching) {
      // Lightweight in-flight indicator for the on-demand MinerU pass.
      this.tableHost.createDiv({
        cls: "paper-notes-library-fulltext-status",
        text: "Searching MinerU full text…",
      });
    }
    const items = this.queryItems();
    // Batch 2 (D): column widths come from the persisted customizations
    // (seeded from settings.columnWidths, updated by the drag handler).
    const columns = resolveColumns(this.effectiveColumnWidths());
    const table = this.tableHost.createEl("table", {
      cls: "paper-notes-library-table",
    });
    // Batch 3: the table width follows the sum of the visible column
    // widths, so once the total exceeds the host's client width the host
    // (overflow:auto) shows a bottom horizontal scrollbar to reach the
    // right-hand columns. CSS `min-width: 100%` still fills the host when
    // the sum is narrower.
    const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
    table.style.width = `${totalWidth}px`;
    const headerRow = table.createEl("thead").createEl("tr");
    for (const column of columns) {
      const th = headerRow.createEl("th", { text: column.label });
      th.style.width = `${column.width}px`;
      if (column.id === this.sort.columnId) {
        th.addClass(this.sort.direction === "asc" ? "sorted-asc" : "sorted-desc");
      }
      th.addEventListener("click", () => this.toggleSort(column.id));
      // Right-edge drag handle: resizing must never trigger sorting, so
      // the handle swallows its own click and pointerdown.
      const handle = th.createEl("span", {
        cls: "paper-notes-col-resize-handle",
        attr: { "aria-hidden": "true" },
      });
      handle.addEventListener("pointerdown", (event: PointerEvent) =>
        this.beginColumnResize(event, th, column.id),
      );
      handle.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
      });
    }
    const body = table.createEl("tbody");
    if (items.length === 0) {
      const row = body.createEl("tr");
      row
        .createEl("td", {
          text: "No papers match the current search and filters.",
          attr: { colspan: String(columns.length) },
        })
        .addClass("paper-notes-library-empty");
    }
    for (const item of items) {
      const row = body.createEl("tr");
      if (item.path === this.selectedPath) {
        row.addClass("selected");
      }
      if (item.invalid !== undefined) {
        row.addClass("paper-notes-library-invalid");
      }
      for (const column of columns) {
        const kind = METRIC_COLUMN_KINDS[column.id];
        if (kind === undefined) {
          const cell = row.createEl("td", {
            cls: `paper-notes-col-${column.id}`,
          });
          this.renderPlainCell(cell, item, column.id);
          continue;
        }
        const cell = row.createEl("td", {
          cls: `paper-notes-col-${column.id}`,
        });
        const badge = metricBadgeStateOf(
          kind,
          this.metricEntryOf(item),
          Date.now(),
          this.metricTtlDays(),
        );
        if (badge !== undefined) {
          renderMetricBadge(cell, badge);
        }
      }
      row.addEventListener("click", () => {
        // Select immediately; open the Detail Drawer after a short delay
        // so a following dblclick can cancel and open the Primary PDF only.
        this.scheduleRowActivation(item);
      });
      row.addEventListener("dblclick", (event: MouseEvent) => {
        event.preventDefault();
        this.clearRowClickTimer();
        this.selectedPath = item.path;
        this.renderTable();
        this.openPrimaryPdf(item);
      });
    }
  }

  private renderDetail(): void {
    if (this.drawerOpen) {
      this.renderDetailDrawer();
    } else if (this.drawerHost !== null) {
      this.drawerHost.empty();
      this.drawerHost.addClass("is-hidden");
    }
  }

  /** Populate the right-side detail drawer with the selected paper. */
  private renderDetailDrawer(): void {
    if (this.drawerHost === null) {
      return;
    }
    this.drawerHost.empty();
    this.drawerHost.removeClass("is-hidden");
    const backdrop = this.drawerHost.createDiv({
      cls: "paper-notes-library-drawer-backdrop",
    });
    backdrop.addEventListener("click", () => this.closeDetailDrawer());
    const panel = this.drawerHost.createDiv({
      cls: "paper-notes-library-drawer-panel",
    });
    const header = panel.createDiv({ cls: "paper-notes-library-drawer-header" });
    header.createEl("span", {
      cls: "paper-notes-library-drawer-title",
      text: "Details",
    });
    const close = header.createEl("button", {
      cls: "paper-notes-library-drawer-close",
      text: "Close",
      attr: { type: "button", "aria-label": "Close details" },
    });
    close.addEventListener("click", () => this.closeDetailDrawer());
    // Batch 2 (A): the grouped action bar is a top bar between the drawer
    // header and the scrollable body — structurally outside the scroll
    // area, so it never scrolls away with a long abstract.
    const actionsBar = panel.createDiv({
      cls: "paper-notes-library-actions paper-notes-library-actions-bar",
    });
    const body = panel.createDiv({ cls: "paper-notes-library-drawer-body" });
    const selected = this.renderDetailInto(body);
    this.renderDetailActions(actionsBar, selected);
    this.attachDrawerKeyHandler();
  }

  /**
   * Shared read-only detail body (Batch 2 A+C): sectioned — header
   * (title/key/reading chip), bibliography, metric badges, attachments,
   * Abstract (>600 chars truncated with Expand), Cards block. The grouped
   * action bar is rendered separately by the drawer as a top bar and is
   * never part of the scrollable body. Returns the selected item so the
   * drawer can populate its action bar.
   */
  private renderDetailInto(host: HTMLElement): LibraryItem | undefined {
    host.empty();
    const items = this.queryItems();
    if (items.length === 0) {
      host.createEl("p", {
        cls: "paper-notes-library-empty",
        text: "No papers in the library yet.",
      });
      return undefined;
    }
    const selected = items.find((item) => item.path === this.selectedPath);
    if (selected === undefined) {
      host.createEl("p", {
        cls: "paper-notes-library-empty",
        text: "Select a paper to view its read-only details.",
      });
      return undefined;
    }
    const detail = buildPaperDetail(selected);
    // Header section: title + key + reading-status chip.
    const header = host.createDiv({
      cls: "paper-notes-library-detail-header",
    });
    header.createEl("h3", {
      cls: "paper-notes-library-detail-title",
      text: detail.title,
    });
    if (detail.key.length > 0) {
      header.createEl("div", {
        cls: "paper-notes-library-detail-key",
        text: detail.key,
      });
    }
    // Reading chip is always present and clickable (cycle via CLI).
    this.renderReadingStatusChip(header, selected);
    if (detail.invalid !== undefined) {
      const diagnostics = host.createDiv({
        cls: "paper-notes-library-diagnostics",
      });
      diagnostics.createEl("strong", { text: "Invalid metadata" });
      for (const reason of detail.invalid.reasons) {
        diagnostics.createEl("div", { text: `- ${reason}` });
      }
    }
    // Bibliography section: the read-only field table.
    const bibliography = host.createDiv({
      cls: "paper-notes-detail-section detail-section-bibliography",
    });
    bibliography.createEl("h4", {
      cls: "paper-notes-detail-section-heading",
      text: "Bibliography",
    });
    const table = bibliography.createEl("table", {
      cls: "paper-notes-library-detail",
    });
    for (const field of detail.fields) {
      const row = table.createEl("tr");
      row.createEl("th", { text: field.label });
      row.createEl("td", { text: field.value });
    }
    // Metrics section: one badge per present metric (UI-only, same badge
    // classes as the table so both surfaces share the token styling).
    if (detail.metrics.length > 0) {
      const metricsSection = host.createDiv({
        cls: "paper-notes-detail-section detail-section-metrics",
      });
      metricsSection.createEl("h4", {
        cls: "paper-notes-detail-section-heading",
        text: "Metrics",
      });
      const row = metricsSection.createDiv({
        cls: "paper-notes-detail-metrics-row",
      });
      for (const metric of detail.metrics) {
        const kind = metric.label.toLowerCase();
        row.createEl("span", {
          cls: `paper-notes-metric-badge paper-notes-metric-badge--${kind}`,
          text: metric.value,
          attr: { "aria-label": `${metric.label}: ${metric.value}` },
        });
      }
    }
    // Attachments section: PDF/MinerU/Figure presence chips.
    const attachments = host.createDiv({
      cls: "paper-notes-detail-section detail-section-artifacts",
    });
    attachments.createEl("h4", {
      cls: "paper-notes-detail-section-heading",
      text: "Attachments",
    });
    this.renderArtifactChips(attachments, detail.artifacts);
    // Abstract section: truncate long abstracts, Expand reveals the rest.
    if (detail.abstract !== undefined && detail.abstract.length > 0) {
      const abstractSection = host.createDiv({
        cls: "paper-notes-detail-section detail-section-abstract",
      });
      abstractSection.createEl("h4", {
        cls: "paper-notes-detail-section-heading",
        text: "Abstract",
      });
      const truncated =
        detail.abstract.length > ABSTRACT_TRUNCATE_CHARS;
      abstractSection.createDiv({
        cls: "paper-notes-detail-abstract",
        text: truncated && !this.abstractExpanded
          ? `${detail.abstract.slice(0, ABSTRACT_TRUNCATE_CHARS)}…`
          : detail.abstract,
      });
      if (truncated) {
        const expand = abstractSection.createEl("button", {
          cls: "paper-notes-detail-abstract-expand",
          text: this.abstractExpanded ? "Collapse" : "Expand",
          attr: { type: "button" },
        });
        expand.addEventListener("click", () => {
          this.abstractExpanded = !this.abstractExpanded;
          this.renderDetailDrawer();
        });
      }
    }
    this.renderCardsBlock(host, selected);
    return selected;
  }

  private renderPlainCell(
    cell: HTMLElement,
    item: LibraryItem,
    columnId: LibraryColumnId,
  ): void {
    if (columnId === "readingStatus") {
      this.renderReadingStatusChip(cell, item);
      return;
    }
    if (columnId === "artifacts") {
      this.renderArtifactChips(cell, item.artifacts);
      return;
    }
    // Prefer textContent over Obsidian's setText so unit-test element
    // stubs (and plain HTMLElement) both work without extra mocks.
    cell.textContent = formatColumnValue(item, columnId);
  }

  /**
   * Reading-status chip (table cell + drawer header). Always shown so the
   * cycle control exists even when frontmatter has no `reading_status`
   * yet (display falls back to `unread`). Activation is chip-local:
   * click and Enter/Space call `stopPropagation` so the row activation
   * path never opens or swaps the Detail Drawer.
   */
  private renderReadingStatusChip(host: HTMLElement, item: LibraryItem): void {
    const display = item.readingStatus ?? "unread";
    const clickable = item.invalid === undefined;
    const chip = host.createEl("span", {
      cls: clickable
        ? `paper-notes-status-chip paper-notes-status-chip--${display} is-clickable`
        : `paper-notes-status-chip paper-notes-status-chip--${display}`,
      text: display,
      attr: {
        "aria-label": clickable
          ? `Reading status: ${display}. Activate to cycle.`
          : `Reading status: ${display}`,
        role: clickable ? "button" : "status",
        tabindex: clickable ? "0" : "-1",
      },
    });
    if (!clickable) {
      return;
    }
    const activate = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      void this.cycleReadingStatus(item);
    };
    chip.addEventListener("click", activate);
    chip.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        activate(event);
      }
    });
  }

  private renderArtifactChips(
    host: HTMLElement,
    artifacts: LibraryItem["artifacts"],
  ): void {
    const row = host.createDiv({ cls: "paper-notes-chip-row" });
    for (const [key, label] of [
      ["pdf", "PDF"],
      ["minerU", "MinerU"],
      ["figure", "Figure"],
    ] as const) {
      const present = artifacts[key];
      row.createEl("span", {
        cls: present
          ? "paper-notes-artifact-chip is-present"
          : "paper-notes-artifact-chip",
        text: label,
        attr: present
          ? { "aria-label": `${label} available` }
          : { "aria-label": `${label} missing`, "aria-hidden": "true" },
      });
    }
  }

  /** Effective Advanced disclosure (auto when no manual override). */
  private isAdvancedFiltersExpanded(): boolean {
    if (this.advancedFiltersExpanded !== undefined) {
      return this.advancedFiltersExpanded;
    }
    return hasActiveAdvancedFilters(this.filters);
  }

  private openDetailDrawer(): void {
    this.drawerOpen = true;
    // Fresh per open: a previously expanded long Abstract collapses again.
    this.abstractExpanded = false;
    this.renderDetailDrawer();
  }

  private closeDetailDrawer(): void {
    this.drawerOpen = false;
    this.abstractExpanded = false;
    this.clearRowClickTimer();
    this.detachDrawerKeyHandler();
    if (this.drawerHost !== null) {
      this.drawerHost.empty();
      this.drawerHost.addClass("is-hidden");
    }
  }

  /** Cancel a pending single-click → drawer open (used by dblclick / close). */
  private clearRowClickTimer(): void {
    if (this.rowClickTimer !== undefined) {
      clearTimeout(this.rowClickTimer);
      this.rowClickTimer = undefined;
    }
  }

  /**
   * Row activation (CONSENSUS): select the row immediately, then open the
   * Detail Drawer after {@link ROW_CLICK_DELAY_MS}. A double-click clears
   * the timer and opens only the Primary PDF instead.
   */
  private scheduleRowActivation(item: LibraryItem): void {
    this.clearRowClickTimer();
    this.selectedPath = item.path;
    // Selection highlight only — never rebuild the whole shell here.
    this.renderTable();
    this.rowClickTimer = setTimeout(() => {
      this.rowClickTimer = undefined;
      if (!this.isOpen || this.selectedPath !== item.path) {
        return;
      }
      this.openDetailDrawer();
    }, ROW_CLICK_DELAY_MS);
  }

  private attachDrawerKeyHandler(): void {
    this.detachDrawerKeyHandler();
    this.boundDrawerKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.drawerOpen) {
        event.preventDefault();
        this.closeDetailDrawer();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.boundDrawerKey);
    }
  }

  private detachDrawerKeyHandler(): void {
    if (this.boundDrawerKey !== null) {
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", this.boundDrawerKey);
      }
      this.boundDrawerKey = null;
    }
  }

  /**
   * Resolve the plugin-side bridge (CLI client, live settings, data.json
   * persistence and command registration) off the app plugin registry.
   * Returns undefined when the plugin is not registered; the library then
   * stays read-only and badge-free — there is no direct-write fallback.
   */
  private resolvePluginBridge(): PluginBridge | undefined {
    // The obsidian types do not expose the plugin registry; the registry
    // is a stable desktop runtime API.
    const registry = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins;
    const plugin = registry?.plugins?.[PLUGIN_ID] as
      | {
          getCliClient?(): CliClient | undefined;
          settings?: PaperNotesSettings;
          loadData?(): Promise<unknown>;
          saveData?(data: unknown): Promise<void>;
          addCommand?(command: {
            id: string;
            name: string;
            callback: () => void;
          }): void;
        }
      | undefined;
    if (plugin === undefined) {
      return undefined;
    }
    const loadData = plugin.loadData;
    const saveData = plugin.saveData;
    const addCommand = plugin.addCommand;
    return {
      client: plugin.getCliClient?.(),
      settings: plugin.settings ?? DEFAULT_SETTINGS,
      loadData: loadData !== undefined ? () => loadData() : undefined,
      saveData:
        saveData !== undefined ? (data: unknown) => saveData(data) : undefined,
      addCommand:
        addCommand !== undefined
          ? (command) => addCommand(command)
          : undefined,
    };
  }

  /**
   * Resolve the CLI-backed action provider once. The plugin instance is
   * read off the app plugin registry (main.ts wires the bridge); the
   * absolute vault root comes from the vault adapter. Without either the
   * library stays read-only — there is no direct-write fallback.
   */
  private getActions(): ItemActions | undefined {
    if (this.actionsResolved) {
      return this.itemActions;
    }
    this.actionsResolved = true;
    const bridge = this.resolvePluginBridge();
    const adapter = this.app.vault?.adapter as { getBasePath?(): string } | undefined;
    const vaultRoot =
      typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : undefined;
    this.itemActions =
      bridge?.client === undefined || vaultRoot === undefined
        ? undefined
        : new ItemActions({ client: bridge.client, vaultRoot });
    return this.itemActions;
  }

  /**
   * Resolve the EasyScholar metric cache once. The cache persists through
   * the plugin's `data.json` under its own `metricsCache` namespace, so
   * settings survive untouched; every CLI call is the read-only
   * `metrics query`. Without the bridge the view stays badge-free.
   */
  private getMetricsCache(): MetricsCache | undefined {
    if (this.metricsResolved) {
      return this.metricsCache;
    }
    this.metricsResolved = true;
    const bridge = this.resolvePluginBridge();
    if (
      bridge === undefined ||
      bridge.client === undefined ||
      bridge.loadData === undefined ||
      bridge.saveData === undefined
    ) {
      return undefined;
    }
    const bridgeLoad = bridge.loadData;
    const bridgeSave = bridge.saveData;
    const cache = new MetricsCache({
      client: bridge.client,
      ttlDays: () => bridge.settings.metricTtlDays,
      enabled: () => metricsEnabledOf(bridge.settings),
      load: async () => {
        const data = await bridgeLoad();
        return typeof data === "object" && data !== null
          ? (data as Record<string, unknown>).metricsCache
          : undefined;
      },
      save: async (payload: unknown) => {
        const current = (await bridgeLoad().catch(() => undefined)) ?? {};
        const merged =
          typeof current === "object" && current !== null
            ? { ...(current as Record<string, unknown>), metricsCache: payload }
            : { metricsCache: payload };
        await bridgeSave(merged);
      },
    });
    this.metricsCache = cache;
    void cache.initialize().then(() => {
      // Persisted badges become visible as soon as they are parsed.
      if (this.isOpen) {
        this.render();
      }
    });
    this.registerMetricsCommands();
    return cache;
  }

  /** Register the two refresh commands (design §10.3) on the plugin. */
  private registerMetricsCommands(): void {
    const bridge = this.resolvePluginBridge();
    if (bridge?.addCommand === undefined) {
      return;
    }
    bridge.addCommand({
      id: REFRESH_JOURNAL_COMMAND,
      name: "Refresh metrics for the current journal",
      callback: () => void this.refreshCurrentJournal(),
    });
    bridge.addCommand({
      id: REFRESH_ALL_COMMAND,
      name: "Refresh all expired metrics",
      callback: () => void this.refreshAllExpired(),
    });
  }

  /** Human summary of one refresh attempt (surface via Notice). */
  private metricsNotice(result: RefreshResult): string {
    switch (result.status) {
      case "refreshed":
        return "Journal metrics refreshed.";
      case "backoff":
        return "Metrics refresh is on backoff (previous attempt failed).";
      case "failed":
        return "Metrics refresh failed; cached values were kept.";
      default:
        return "Nothing to refresh for this paper.";
    }
  }

  /** Command: refresh metrics for the currently selected paper's journal. */
  private async refreshCurrentJournal(): Promise<void> {
    const cache = this.getMetricsCache();
    if (cache === undefined) {
      this.notify("paper-notes CLI unavailable; metrics cannot refresh.");
      return;
    }
    const item = this.queryItems().find(
      (candidate) => candidate.path === this.selectedPath,
    );
    if (item?.record === undefined) {
      this.notify("Select a paper to refresh its journal metrics.");
      return;
    }
    const result = await cache.refresh(item.record);
    if (this.isOpen) {
      this.render();
    }
    this.notify(this.metricsNotice(result));
  }

  /** Background/command refresh of every missing or expired journal. */
  private async refreshAllExpired(): Promise<void> {
    const cache = this.getMetricsCache();
    if (cache === undefined) {
      return;
    }
    await cache.refreshExpired(this.source.getRecords());
    if (this.isOpen) {
      this.render();
    }
  }

  /** Cache entry behind one display row (badges), if any. */
  private metricEntryOf(item: LibraryItem): CachedMetricsEntry | undefined {
    const cache = this.metricsCache;
    if (cache === undefined || item.record === undefined) {
      return undefined;
    }
    return cache.getEntryFor(item.record);
  }

  /** Effective metric TTL from the live plugin settings. */
  private metricTtlDays(): number {
    const bridge = this.resolvePluginBridge();
    return bridge?.settings.metricTtlDays ?? DEFAULT_SETTINGS.metricTtlDays;
  }

  /** Lazily load the modal classes (kept off the static import graph). */
  private async loadModalClasses(): Promise<ModalClasses> {
    if (this.modalClasses === undefined) {
      const create = await import("../modals/create-item-modal");
      const confirmation = await import("../modals/confirmation-modal");
      const del = await import("../modals/delete-item-modal");
      this.modalClasses = {
        CreateItemModal: create.CreateItemModal,
        ConfirmationModal: confirmation.ConfirmationModal,
        TextPromptModal: confirmation.TextPromptModal,
        DeleteItemModal: del.DeleteItemModal,
      };
    }
    return this.modalClasses;
  }

  /** Surface a user notice (Repair: Gate D R8 — static `Notice` import). */
  private notify(message: string): void {
    new Notice(message);
  }

  /** Human message for any outcome (errors surface CLI diagnostics). */
  private outcomeMessage(outcome: ActionOutcome): string {
    return outcome.status === "error"
      ? outcome.message
      : "The operation is still pending confirmation.";
  }

  private async runCreate(): Promise<void> {
    const actions = this.getActions();
    if (actions === undefined) {
      this.notify("paper-notes CLI unavailable; the library is read-only.");
      return;
    }
    const { CreateItemModal } = await this.loadModalClasses();
    const callbacks: CreateItemCallbacks = {
      create: (input: CreateItemInput) => actions.create(input),
      confirm: (input: CreateItemInput, confirmed: Record<string, unknown>) =>
        actions.confirmCreate(input, confirmed),
      notify: (message: string) => this.notify(message),
    };
    new CreateItemModal(this.app, callbacks).open();
  }

  /** Open main/PDF/MinerU/Figure/cards assets (design spec §9.5). */
  private openAsset(kind: OpenAssetKind, item: LibraryItem): void {
    const target =
      kind === "cards"
        ? // Single-card quick-open path: the first (sorted) card note.
          resolveOpenTarget(
            kind,
            item.path,
            this.source.getCards(item.path.slice(0, item.path.lastIndexOf("/"))),
          )
        : resolveOpenTarget(kind, item.path);
    if (target === undefined) {
      return;
    }
    this.openTarget(target);
  }

  /**
   * Double-click row activation: open only the Primary PDF. Missing PDF
   * → Notice only; never open the Detail Drawer or the Figure note.
   */
  private openPrimaryPdf(item: LibraryItem): void {
    if (!item.artifacts.pdf) {
      this.notify("Primary PDF not found for this paper.");
      return;
    }
    const target = resolveOpenTarget("pdf", item.path);
    if (target === undefined) {
      this.notify("Primary PDF not found for this paper.");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(target.path);
    if (file === null || typeof file !== "object" || !("path" in file)) {
      this.notify("Primary PDF not found for this paper.");
      return;
    }
    void this.app.workspace.getLeaf(false)?.openFile(file as TFile);
  }

  /**
   * Open Folder (CONSENSUS API style C): reveal the Canonical Paper
   * Directory (`05 Literature/<key>/`) in Obsidian's in-app file explorer.
   * Never falls back to the OS Finder. Missing folder / unavailable
   * explorer API → Notice only. When no explorer leaf is mounted yet,
   * awaits `setViewState` before reveal so the view is actually ready.
   */
  private openPaperFolder(item: LibraryItem): void {
    void this.openPaperFolderAsync(item);
  }

  private async openPaperFolderAsync(item: LibraryItem): Promise<void> {
    const dir = paperDirectoryOf(item.path);
    if (dir.length === 0) {
      this.notify("Paper folder path could not be resolved.");
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (folder === null || typeof folder !== "object") {
      this.notify("Paper folder not found in the vault.");
      return;
    }
    const workspace = this.app.workspace as unknown as {
      getLeavesOfType?: (type: string) => WorkspaceLeaf[];
      getLeftLeaf?: (split: boolean) => WorkspaceLeaf | null;
      revealLeaf?: (leaf: WorkspaceLeaf) => void | Promise<void>;
    };
    let leaves = workspace.getLeavesOfType?.("file-explorer") ?? [];
    if (leaves.length === 0) {
      // Style C: open the file explorer leaf when none is mounted yet.
      const leaf = workspace.getLeftLeaf?.(false) ?? null;
      if (leaf !== null && typeof leaf.setViewState === "function") {
        try {
          await leaf.setViewState({ type: "file-explorer" });
        } catch {
          this.notify("Could not open the file explorer.");
          return;
        }
        // Re-query after the view has mounted (setViewState may attach
        // the explorer asynchronously onto a different leaf list).
        leaves = workspace.getLeavesOfType?.("file-explorer") ?? [];
        if (leaves.length === 0) {
          leaves = [leaf];
        }
      }
    }
    if (leaves.length === 0) {
      this.notify("Could not open the file explorer.");
      return;
    }
    const explorerLeaf = leaves[0];
    const view = (explorerLeaf as unknown as { view?: unknown }).view as
      | { revealInFolder?: (file: unknown) => void }
      | undefined;
    if (view === undefined || typeof view.revealInFolder !== "function") {
      this.notify(
        "File explorer reveal is unavailable in this Obsidian version.",
      );
      return;
    }
    view.revealInFolder(folder);
    if (typeof workspace.revealLeaf === "function") {
      void workspace.revealLeaf(explorerLeaf);
    }
  }

  /**
   * Open one specific card note (Gate D R3 interface reservation): the
   * future in-panel card view reuses this entry; the detail Cards block
   * is wired through it today. The shared `openCard()` helper keeps this
   * path and the single-card quick open consistent.
   */
  private openCardNote(notePath: string, cardName: string): void {
    const target = openCard(notePath, cardName);
    if (target !== undefined) {
      this.openTarget(target);
    }
  }

  /** Open a resolved asset file in the workspace. */
  private openTarget(target: OpenTarget): void {
    const file = this.app.vault.getAbstractFileByPath(target.path);
    if (file === null || typeof file !== "object" || !("path" in file)) {
      return;
    }
    void this.app.workspace.getLeaf(false)?.openFile(file as TFile);
  }

  /**
   * Cards block (Gate D R3 repair): lists every card note under the
   * paper's `cards/` directory; each row opens that exact card via
   * `openCard()`. The block replaces the former "Open cards" button —
   * the block is the multi-card entry point. No cards → no block.
   * TODO(future): upgrade this container into the in-panel card-view
   * component (view switching / card grid) per the user's long-term plan.
   */
  private renderCardsBlock(host: HTMLElement, item: LibraryItem): void {
    const dir = item.path.slice(0, item.path.lastIndexOf("/"));
    const cards = this.source.getCards(dir);
    if (cards.length === 0) {
      return;
    }
    const block = host.createDiv({ cls: "paper-notes-library-cards" });
    block.createEl("h4", {
      cls: "paper-notes-library-cards-heading",
      text: "Cards",
    });
    for (const card of cards) {
      const row = block.createEl("button", {
        cls: "paper-notes-library-cards-row",
        text: card.endsWith(".md") ? card.slice(0, -3) : card,
      });
      row.addEventListener("click", () => this.openCardNote(item.path, card));
    }
  }

  /**
   * Batch 2 (A): grouped top action bar — Open | Status | Danger. The bar
   * lives OUTSIDE the drawer's scrollable body (see renderDetailDrawer),
   * so it stays visible no matter how long the Abstract gets. Read-only
   * mode renders the CLI-unavailable hint instead of buttons.
   */
  private renderDetailActions(
    host: HTMLElement,
    item: LibraryItem | undefined,
  ): void {
    const actions = this.getActions();
    const bar = host.createDiv({ cls: "paper-notes-library-action-bar" });
    if (actions === undefined || item === undefined) {
      bar.createEl("span", {
        cls: "paper-notes-library-actions-hint",
        text: "paper-notes CLI unavailable — the library is read-only.",
      });
      return;
    }
    // Open group: asset openers (main is always available; artifacts only
    // when the file exists). "Open cards" was replaced by the detail Cards
    // block (Gate D R3): the block lists every card note and is the
    // multi-card entry point.
    const openGroup = bar.createDiv({
      cls: "paper-notes-library-action-group actions-open",
    });
    const open = (
      kind: OpenAssetKind,
      label: string,
      enabled: boolean,
    ): void => {
      const button = openGroup.createEl("button", {
        cls: "paper-notes-library-action-open",
        text: label,
      });
      if (!enabled) {
        button.disabled = true;
        button.title = `${label} unavailable`;
      }
      button.addEventListener("click", () => this.openAsset(kind, item));
    };
    open("main", "Open main", true);
    open("pdf", "Open PDF", item.artifacts.pdf);
    open("minerU", "Open MinerU", item.artifacts.minerU);
    open("figure", "Open Figure", item.artifacts.figure);
    // Open Folder: Canonical Paper Directory in the in-app explorer.
    const openFolder = openGroup.createEl("button", {
      cls: "paper-notes-library-action-open-folder",
      text: "Open Folder",
      attr: { type: "button", "aria-label": "Reveal paper folder in file explorer" },
    });
    openFolder.addEventListener("click", () => this.openPaperFolder(item));
    // Invalid-metadata rows have no canonical key to mutate.
    if (item.invalid !== undefined) {
      return;
    }
    // Status group: attach + rename. Reading status is cycled from the
    // table/drawer chips (the old "Reading: x → y" action-bar button is gone).
    const statusGroup = bar.createDiv({
      cls: "paper-notes-library-action-group actions-status",
    });
    const attach = statusGroup.createEl("button", { text: "Attach PDF" });
    attach.addEventListener("click", () => void this.startAttach(item));
    const rename = statusGroup.createEl("button", { text: "Rename key" });
    rename.addEventListener("click", () => void this.startRename(item));
    // Danger group: destructive, always mod-warning styled.
    const dangerGroup = bar.createDiv({
      cls: "paper-notes-library-action-group actions-danger",
    });
    const remove = dangerGroup.createEl("button", { text: "Delete" });
    remove.addClass("mod-warning");
    remove.addEventListener("click", () => this.startDelete(item));
  }

  /**
   * Effective column-width customizations (Batch 2 D): the view's live
   * state, seeded once from the persisted plugin settings. `resolveColumns`
   * applies them over the defaults; the drag handler mutates them.
   */
  private effectiveColumnWidths(): ColumnCustomizations {
    if (!this.columnWidthsSeeded) {
      this.columnWidthsSeeded = true;
      const persisted = this.resolvePluginBridge()?.settings.columnWidths;
      if (persisted !== undefined) {
        for (const [id, width] of Object.entries(persisted)) {
          if (typeof width === "number") {
            this.columnWidths[id as LibraryColumnId] = { width };
          }
        }
      }
    }
    return this.columnWidths;
  }

  /**
   * Begin a column resize on the header's right-edge handle. The drag
   * listens on `document` (pointermove/pointerup) so it tracks outside the
   * header; the handle's own pointerdown/click are swallowed so resizing
   * never triggers a sort.
   */
  private beginColumnResize(
    event: PointerEvent,
    th: HTMLElement,
    columnId: LibraryColumnId,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = parseFloat(th.style.width);
    this.columnResize = {
      columnId,
      th,
      startX: event.clientX,
      startWidth: Number.isFinite(startWidth) ? startWidth : 0,
    };
    if (typeof document !== "undefined") {
      this.boundColumnPointerMove = (move: PointerEvent) =>
        this.moveColumnResize(move);
      this.boundColumnPointerUp = (up: PointerEvent) =>
        void this.endColumnResize(up);
      document.addEventListener("pointermove", this.boundColumnPointerMove);
      document.addEventListener("pointerup", this.boundColumnPointerUp);
    }
  }

  /** Live width update while dragging (no ceiling; only the safety valve). */
  private moveColumnResize(event: PointerEvent): void {
    const state = this.columnResize;
    if (state === null) {
      return;
    }
    event.preventDefault();
    const width = clampColumnWidth(
      state.startWidth + (event.clientX - state.startX),
    );
    state.th.style.width = `${width}px`;
  }

  /**
   * Finish the drag: apply the final width (no ceiling), add it as a
   * customization, re-render the table and persist via merge-save (only
   * the `columnWidths` key changes; metricsCache and friends survive).
   */
  private async endColumnResize(event: PointerEvent): Promise<void> {
    const state = this.columnResize;
    if (state === null) {
      return;
    }
    this.columnResize = null;
    if (typeof document !== "undefined") {
      if (this.boundColumnPointerMove !== null) {
        document.removeEventListener("pointermove", this.boundColumnPointerMove);
      }
      if (this.boundColumnPointerUp !== null) {
        document.removeEventListener("pointerup", this.boundColumnPointerUp);
      }
      this.boundColumnPointerMove = null;
      this.boundColumnPointerUp = null;
    }
    const width = clampColumnWidth(
      state.startWidth + (event.clientX - state.startX),
    );
    if (width === state.startWidth) {
      return;
    }
    this.columnWidths[state.columnId] = { width };
    this.syncColumnWidthsToSettings();
    this.renderTable();
    await this.persistColumnWidths();
  }

  /**
   * Write the in-memory plugin settings copy so fresh renders/views see
   * the new widths immediately, without waiting for a reload.
   */
  private syncColumnWidthsToSettings(): void {
    const registry = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins;
    const plugin = registry?.plugins?.[PLUGIN_ID] as
      | { settings?: PaperNotesSettings }
      | undefined;
    if (plugin?.settings === undefined) {
      return;
    }
    const plain: Partial<Record<LibraryColumnId, number>> = {};
    for (const [id, customization] of Object.entries(this.columnWidths)) {
      if (customization?.width !== undefined) {
        plain[id as LibraryColumnId] = customization.width;
      }
    }
    plugin.settings = { ...plugin.settings, columnWidths: plain };
  }

  /**
   * Merge-save the column widths into the plugin `data.json`: load the
   * current payload, replace only the `columnWidths` key, write it back.
   * A save that overwrote the whole payload would drop `metricsCache`
   * and other persisted keys — the merge test guards against that class.
   */
  private async persistColumnWidths(): Promise<void> {
    const bridge = this.resolvePluginBridge();
    if (
      bridge?.loadData === undefined ||
      bridge?.saveData === undefined
    ) {
      return;
    }
    const plain: Record<string, number> = {};
    for (const [id, customization] of Object.entries(this.columnWidths)) {
      if (customization?.width !== undefined) {
        plain[id] = customization.width;
      }
    }
    const loaded = (await bridge.loadData().catch(() => undefined)) ?? {};
    const base =
      typeof loaded === "object" && loaded !== null ? loaded : {};
    await bridge.saveData({ ...base, columnWidths: plain });
  }

  /** Reading-status shortcuts route through `item update` (spec §9.5). */
  private async cycleReadingStatus(item: LibraryItem): Promise<void> {
    const actions = this.getActions();
    if (actions === undefined || item.invalid !== undefined) {
      return;
    }
    const next = nextReadingStatus(item.readingStatus);
    const outcome = await actions.updateReadingStatus(item.key, next);
    if (outcome.status === "success") {
      this.notify(`Reading status → ${next}`);
      this.refresh();
    } else {
      this.notify(this.outcomeMessage(outcome));
    }
  }

  private async startAttach(item: LibraryItem): Promise<void> {
    const actions = this.getActions();
    if (actions === undefined || item.invalid !== undefined) {
      return;
    }
    const { TextPromptModal } = await this.loadModalClasses();
    new TextPromptModal(
      this.app,
      {
        title: "Attach PDF",
        placeholder: "/absolute/path/to/paper.pdf",
        confirmLabel: "Attach",
      },
      {
        confirm: (value: string) => {
          const path = value.trim();
          if (path.length > 0) {
            void this.attachPdf(actions, item.key, path);
          }
        },
      },
    ).open();
  }

  private async attachPdf(
    actions: ItemActions,
    key: string,
    path: string,
  ): Promise<void> {
    const outcome = await actions.attachPdf(key, path);
    if (outcome.status === "needs_confirmation") {
      const token = outcome.token;
      const { ConfirmationModal } = await this.loadModalClasses();
      new ConfirmationModal(
        this.app,
        {
          title: "Confirm PDF attachment",
          lines: renderPlanLines(outcome.envelope.data.plan),
        },
        () => void this.confirmAttach(actions, key, path, token),
      ).open();
      return;
    }
    if (outcome.status === "success") {
      this.notify("PDF attached.");
      this.refresh();
    } else {
      this.notify(this.outcomeMessage(outcome));
    }
  }

  private async confirmAttach(
    actions: ItemActions,
    key: string,
    path: string,
    token: string,
  ): Promise<void> {
    const outcome = await actions.confirmAttach(key, path, token);
    if (outcome.status === "success") {
      this.notify("PDF attached.");
      this.refresh();
    } else {
      this.notify(this.outcomeMessage(outcome));
    }
  }

  private async startRename(item: LibraryItem): Promise<void> {
    const actions = this.getActions();
    if (actions === undefined || item.invalid !== undefined) {
      return;
    }
    const { TextPromptModal } = await this.loadModalClasses();
    new TextPromptModal(
      this.app,
      {
        title: "Rename citation key",
        placeholder: "new-citation-key",
        initial: item.key,
        confirmLabel: "Preview",
      },
      {
        confirm: (value: string) => {
          const newKey = value.trim();
          if (newKey.length === 0 || newKey === item.key) {
            return;
          }
          void this.renameKey(actions, item.key, newKey);
        },
      },
    ).open();
  }

  /** Rename always previews (`--dry-run`) before any confirm (spec §8.2). */
  private async renameKey(
    actions: ItemActions,
    key: string,
    newKey: string,
  ): Promise<void> {
    const outcome = await actions.previewRenameKey(key, newKey);
    if (outcome.status === "needs_confirmation") {
      const token = outcome.token;
      const { ConfirmationModal } = await this.loadModalClasses();
      new ConfirmationModal(
        this.app,
        {
          title: `Rename ${key} → ${newKey}`,
          lines: renderPlanLines(outcome.envelope.data.plan),
        },
        () => void this.confirmRename(actions, key, newKey, token),
      ).open();
      return;
    }
    this.notify(outcome.status === "success" ? "Key renamed." : this.outcomeMessage(outcome));
  }

  private async confirmRename(
    actions: ItemActions,
    key: string,
    newKey: string,
    token: string,
  ): Promise<void> {
    const outcome = await actions.confirmRenameKey(key, newKey, token);
    if (outcome.status === "success") {
      this.notify("Key renamed.");
      this.refresh();
    } else {
      this.notify(this.outcomeMessage(outcome));
    }
  }

  private startDelete(item: LibraryItem): void {
    const actions = this.getActions();
    if (actions === undefined || item.invalid !== undefined) {
      return;
    }
    void this.deletePreview(actions, item.key);
  }

  /** Deletion shows count/size/backlinks and requires the exact key (§8.3). */
  private async deletePreview(
    actions: ItemActions,
    key: string,
  ): Promise<void> {
    const outcome = await actions.previewDelete(key);
    if (outcome.status !== "needs_confirmation") {
      this.notify(this.outcomeMessage(outcome));
      return;
    }
    const preview = buildDeletePreview(outcome.envelope.data);
    if (preview.key.length === 0) {
      this.notify("Cannot plan deletion: missing citation key.");
      return;
    }
    const token = outcome.token;
    const { DeleteItemModal } = await this.loadModalClasses();
    new DeleteItemModal(this.app, preview, {
      confirm: () => this.confirmDelete(actions, key, token),
      notify: (message: string) => this.notify(message),
    }).open();
  }

  private async confirmDelete(
    actions: ItemActions,
    key: string,
    token: string,
  ): Promise<void> {
    const outcome = await actions.confirmDelete(key, key, token);
    if (outcome.status === "success") {
      this.notify("Paper deleted.");
      this.refresh();
    } else {
      this.notify(this.outcomeMessage(outcome));
    }
  }
}
