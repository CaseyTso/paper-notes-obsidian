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
 * (artifact availability) and an optional volatile metrics provider. Nothing
 * here ever writes back to the vault; metrics are UI data only.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";

import type { InvalidRecord, PaperRecord } from "../types/paper";
import {
  buildLibraryItems,
  formatColumnValue,
  resolveColumns,
  searchLibraryItems,
  sortLibraryItems,
  type LibraryColumnId,
  type LibraryItem,
  type LibrarySort,
  type PaperMetrics,
} from "../components/library-table";
import {
  EMPTY_LIBRARY_FILTERS,
  applyLibraryFilters,
  type ArtifactPart,
  type LibraryFilters,
} from "../components/library-filters";
import { buildPaperDetail } from "../components/paper-detail";

export const VIEW_TYPE_PAPER_NOTES = "paper-notes-open-library";

export interface LibraryViewSource {
  /** Canonical, validated paper records from the in-memory index. */
  getRecords(): PaperRecord[];
  /** Invalid-metadata records (kept visible with diagnostics, §17.1). */
  getInvalidRecords(): InvalidRecord[];
  /** Raw frontmatter per path (reading status is read from here). */
  getFrontmatter(path: string): Record<string, unknown> | undefined;
  /** Basenames of the paper directory (`<root>/<key>/`). */
  listDirectory(dir: string): string[];
  /** Volatile EasyScholar metrics per paper id (Task 26 wires the cache). */
  getMetrics?(paperId: string): PaperMetrics | undefined;
}

export class PaperNotesLibraryView extends ItemView {
  private searchQuery = "";
  private filters: LibraryFilters = { ...EMPTY_LIBRARY_FILTERS };
  private sort: LibrarySort = { columnId: "year", direction: "desc" };
  private selectedPath: string | undefined;
  private open = false;
  private tableHost: HTMLElement | null = null;
  private detailHost: HTMLElement | null = null;

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
    this.open = true;
    this.render();
  }

  async onClose(): Promise<void> {
    this.open = false;
    this.tableHost = null;
    this.detailHost = null;
    this.containerEl.empty();
  }

  /** Re-render after vault events; a no-op while the view is closed. */
  refresh(): void {
    if (this.open) {
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
    });
    const clear = toolbar.createEl("button", {
      cls: "paper-notes-library-clear",
      text: "Clear filters",
    });
    clear.addEventListener("click", () => {
      this.filters = { ...EMPTY_LIBRARY_FILTERS };
      this.render();
    });

    this.renderFilterBar(container);

    const split = container.createDiv({ cls: "paper-notes-library-split" });
    this.tableHost = split.createDiv({ cls: "paper-notes-library-table-host" });
    this.detailHost = split.createDiv({ cls: "paper-notes-library-detail-host" });
    this.renderResults();
  }

  private renderFilterBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "paper-notes-library-filters" });
    bar.createEl("span", {
      cls: "paper-notes-library-filter-heading",
      text: "Filters",
    });
    this.filterNumberInput(
      bar,
      "Year from",
      this.filters.yearFrom,
      (value) => this.updateFilters({ yearFrom: value }),
    );
    this.filterNumberInput(
      bar,
      "Year to",
      this.filters.yearTo,
      (value) => this.updateFilters({ yearTo: value }),
    );
    this.filterTextInput(
      bar,
      "Journal",
      this.filters.journal,
      (value) => this.updateFilters({ journal: value }),
    );
    this.filterTextInput(
      bar,
      "CAS",
      this.filters.cas,
      (value) => this.updateFilters({ cas: value }),
    );
    this.filterTextInput(
      bar,
      "JCR",
      this.filters.jcr,
      (value) => this.updateFilters({ jcr: value }),
    );
    this.filterNumberInput(
      bar,
      "IF min",
      this.filters.ifMin,
      (value) => this.updateFilters({ ifMin: value }),
    );
    this.filterNumberInput(
      bar,
      "IF max",
      this.filters.ifMax,
      (value) => this.updateFilters({ ifMax: value }),
    );
    this.filterNumberInput(
      bar,
      "JCI min",
      this.filters.jciMin,
      (value) => this.updateFilters({ jciMin: value }),
    );
    this.filterNumberInput(
      bar,
      "JCI max",
      this.filters.jciMax,
      (value) => this.updateFilters({ jciMax: value }),
    );

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
        readingStatus: value === "" ? undefined : (value as LibraryFilters["readingStatus"]),
      });
    });

    this.artifactCheckbox(bar, "PDF", "pdf");
    this.artifactCheckbox(bar, "MinerU", "minerU");
    this.artifactCheckbox(bar, "Figure", "figure");
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
    this.filters = { ...this.filters, ...patch };
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
    const items = buildLibraryItems(
      this.source.getRecords(),
      this.source.getInvalidRecords(),
      {
        frontmatter: (path) => this.source.getFrontmatter(path),
        listDirectory: (dir) => this.source.listDirectory(dir),
        metrics: (paperId) => this.source.getMetrics?.(paperId),
      },
    );
    const searched = searchLibraryItems(items, this.searchQuery);
    const filtered = applyLibraryFilters(searched, this.filters);
    return sortLibraryItems(filtered, this.sort);
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
    const items = this.queryItems();
    // Column customizations are view-level UI state; Task 24 uses the defaults.
    const columns = resolveColumns({});
    const table = this.tableHost.createEl("table", {
      cls: "paper-notes-library-table",
    });
    const headerRow = table.createEl("thead").createEl("tr");
    for (const column of columns) {
      const th = headerRow.createEl("th", { text: column.label });
      th.style.width = `${column.width}px`;
      if (column.id === this.sort.columnId) {
        th.addClass(this.sort.direction === "asc" ? "sorted-asc" : "sorted-desc");
      }
      th.addEventListener("click", () => this.toggleSort(column.id));
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
        row.createEl("td", { text: formatColumnValue(item, column.id) });
      }
      row.addEventListener("click", () => {
        this.selectedPath = item.path;
        this.renderResults();
      });
    }
  }

  private renderDetail(): void {
    if (this.detailHost === null) {
      return;
    }
    this.detailHost.empty();
    const items = this.queryItems();
    if (items.length === 0) {
      this.detailHost
        .createEl("p", {
          cls: "paper-notes-library-empty",
          text: "No papers in the library yet.",
        });
      return;
    }
    const selected = items.find((item) => item.path === this.selectedPath);
    if (selected === undefined) {
      this.detailHost
        .createEl("p", {
          cls: "paper-notes-library-empty",
          text: "Select a paper to view its read-only details.",
        });
      return;
    }
    const detail = buildPaperDetail(selected);
    this.detailHost.createEl("h3", {
      cls: "paper-notes-library-detail-title",
      text: detail.title,
    });
    if (detail.invalid !== undefined) {
      const diagnostics = this.detailHost.createEl("div", {
        cls: "paper-notes-library-diagnostics",
      });
      diagnostics.createEl("strong", { text: "Invalid metadata" });
      for (const reason of detail.invalid.reasons) {
        diagnostics.createEl("div", { text: `- ${reason}` });
      }
    }
    const table = this.detailHost.createEl("table", {
      cls: "paper-notes-library-detail",
    });
    for (const field of detail.fields) {
      const row = table.createEl("tr");
      row.createEl("th", { text: field.label });
      row.createEl("td", { text: field.value });
    }
  }
}
