/**
 * MOC Directory component hosted within the Library navigation view.
 *
 * Provides a responsive light-card directory of Topic MOC notes with instant
 * content search across Topic MOC titles and visible Topic Table columns
 * (Title, Figure link label, Summary, Card link labels).
 */

import { Notice, setIcon } from "obsidian";
import {
  indexTopicMocs,
  searchTopicMocs,
  type MocSearchResult,
  type ParsedMoc,
} from "../services/moc-index";

export interface MocDirectorySource {
  readonly literatureRoot: string;
  readText(path: string): Promise<string>;
  listMarkdownFiles(dir: string): string[];
  createMoc?(): Promise<string | undefined>;
  openNote(path: string, newTab: boolean, signal?: AbortSignal): Promise<void>;
}

/**
 * Safely renders text with highlighted search terms into parent.
 * Uses only safe DOM methods (createEl / createSpan / appendText / text nodes),
 * NEVER raw innerHTML.
 */
export function renderHighlightedText(
  parent: HTMLElement,
  text: string,
  terms: readonly string[],
): void {
  if (!text) return;
  const lowerText = text.toLowerCase();
  const validTerms = terms
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .filter((t) => lowerText.includes(t));

  if (validTerms.length === 0) {
    appendSafeText(parent, text);
    return;
  }

  // Find all match ranges [start, end]
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of validTerms) {
    let startIdx = 0;
    while (startIdx < lowerText.length) {
      const pos = lowerText.indexOf(term, startIdx);
      if (pos === -1) break;
      ranges.push({ start: pos, end: pos + term.length });
      startIdx = pos + term.length;
    }
  }

  // Sort by start ascending, then end descending
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  // Merge overlapping or contiguous ranges
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
    } else {
      const prev = merged[merged.length - 1];
      if (r.start <= prev.end) {
        prev.end = Math.max(prev.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }
  }

  // Render tokens
  let lastIndex = 0;
  for (const { start, end } of merged) {
    if (start > lastIndex) {
      appendSafeText(parent, text.slice(lastIndex, start));
    }
    parent.createEl("mark", {
      cls: "paper-notes-moc-match",
      text: text.slice(start, end),
    });
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    appendSafeText(parent, text.slice(lastIndex));
  }
}

function appendSafeText(parent: HTMLElement, text: string): void {
  if (!text) return;
  if (typeof (parent as unknown as { appendText?: (t: string) => void }).appendText === "function") {
    (parent as unknown as { appendText: (t: string) => void }).appendText(text);
  } else {
    parent.createSpan({ text });
  }
}

function createIconButton(
  parent: HTMLElement,
  cls: string,
  icon: string,
  label: string,
): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: `paper-notes-icon-button ${cls}`.trim(),
    attr: {
      type: "button",
      "aria-label": label,
      title: label,
      "data-tooltip": label,
    },
  });
  if (typeof setIcon === "function") {
    setIcon(button, icon);
  } else {
    button.textContent = label;
  }
  return button;
}

type LoadStatus = "idle" | "loading" | "error" | "ready";

export class MocDirectory {
  private host: HTMLElement | undefined;
  private list: HTMLElement | undefined;
  private status: HTMLElement | undefined;
  private createButton: HTMLButtonElement | undefined;

  private loadStatus: LoadStatus = "idle";
  private errorMessage = "";
  private loadedMocs: ParsedMoc[] = [];
  private searchQuery = "";
  private generation = 0;
  private lifetime: AbortController | undefined;
  private creating = false;

  constructor(private readonly source: MocDirectorySource) {}

  mount(host: HTMLElement): void {
    this.dispose();
    this.host = host;
    this.lifetime = new AbortController();

    const header = host.createDiv({ cls: "paper-notes-moc-header" });

    // Permanent Search Bar at top
    const searchWrap = header.createDiv({ cls: "paper-notes-moc-search-wrap" });
    const searchIcon = searchWrap.createEl("span", {
      cls: "paper-notes-moc-search-icon",
      attr: { "aria-hidden": "true" },
    });
    if (typeof setIcon === "function") {
      setIcon(searchIcon, "search");
    }

    const searchInput = searchWrap.createEl("input", {
      cls: "paper-notes-moc-search-input",
      attr: {
        type: "search",
        "aria-label": "搜索主题或表格内容",
        placeholder: "搜索主题或表格内容…",
      },
    });
    searchInput.value = this.searchQuery;

    const searchClear = createIconButton(
      searchWrap,
      "paper-notes-moc-search-clear" + (this.searchQuery ? "" : " is-hidden"),
      "x",
      "清除搜索",
    );

    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      if (this.searchQuery) {
        searchClear.removeClass?.("is-hidden");
      } else {
        searchClear.addClass?.("is-hidden");
      }
      this.applySearch();
    });

    searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.searchQuery) {
        e.stopPropagation();
        this.searchQuery = "";
        searchInput.value = "";
        searchClear.addClass?.("is-hidden");
        this.applySearch();
      }
    });

    searchClear.addEventListener("click", () => {
      this.searchQuery = "";
      searchInput.value = "";
      searchClear.addClass?.("is-hidden");
      this.applySearch();
      searchInput.focus?.();
    });

    // Actions Toolbar: New Topic button + Refresh icon button
    const toolbar = header.createDiv({ cls: "paper-notes-moc-toolbar" });
    const create = toolbar.createEl("button", {
      text: "新建主题",
      cls: "paper-notes-moc-create mod-cta",
      attr: { type: "button" },
    });
    this.createButton = create;
    create.disabled = !this.source.createMoc || this.creating;
    create.addEventListener("click", () => void this.create(create));

    const refresh = createIconButton(
      toolbar,
      "paper-notes-moc-refresh",
      "refresh-cw",
      "刷新",
    );
    refresh.addEventListener("click", () => void this.refresh());

    // Status message & MOC light-card list
    this.loadStatus = "loading";
    this.errorMessage = "";
    this.status = host.createDiv({
      cls: "paper-notes-moc-status",
      attr: { role: "status" },
    });
    this.status.textContent = "正在加载主题…";

    this.list = host.createEl("ul", {
      cls: "paper-notes-moc-list",
      attr: { role: "list", "aria-label": "Topic MOC" },
    });

    void this.refresh();
  }

  dispose(): void {
    this.generation++;
    this.lifetime?.abort();
    this.loadStatus = "idle";
    this.errorMessage = "";
    this.host = undefined;
    this.list = undefined;
    this.status = undefined;
    this.createButton = undefined;
    this.loadedMocs = [];
  }

  async refresh(): Promise<void> {
    if (!this.host) return;
    const generation = ++this.generation;
    this.loadStatus = "loading";
    this.errorMessage = "";
    if (this.status) {
      this.status.textContent = "正在加载主题…";
    }

    try {
      const dir = `${this.source.literatureRoot.replace(/\/$/u, "")}/MOCs`;
      const fileNames = this.source.listMarkdownFiles(dir);
      const notes = await Promise.all(
        fileNames.map(async (name) => {
          const path = `${dir}/${name}`;
          return { path, text: await this.source.readText(path) };
        }),
      );

      if (
        !this.host ||
        generation !== this.generation ||
        this.lifetime?.signal.aborted
      ) {
        return;
      }

      this.loadStatus = "ready";
      this.loadedMocs = indexTopicMocs(notes);
      this.applySearch();
    } catch (error) {
      if (
        !this.host ||
        generation !== this.generation ||
        this.lifetime?.signal.aborted
      ) {
        return;
      }
      this.loadStatus = "error";
      this.errorMessage = String(error);
      if (this.status) {
        this.status.textContent = `无法加载主题，请刷新重试：${this.errorMessage}`;
      }
      this.list?.empty();
    }
  }

  private applySearch(): void {
    if (!this.list || !this.status) return;

    if (this.loadStatus === "loading") {
      this.status.textContent = "正在加载主题…";
      return;
    }
    if (this.loadStatus === "error") {
      this.status.textContent = `无法加载主题，请刷新重试：${this.errorMessage}`;
      return;
    }
    if (this.loadStatus !== "ready") {
      return;
    }

    const query = this.searchQuery.trim();
    if (!query) {
      this.renderOrdinaryList(this.loadedMocs);
      return;
    }

    const searchTerms = query.split(/\s+/u).filter(Boolean);
    const results = searchTopicMocs(this.loadedMocs, query);
    this.renderSearchResults(results, searchTerms);
  }

  private renderOrdinaryList(mocs: ParsedMoc[]): void {
    const focusedPath = this.list
      ?.querySelector<HTMLElement>(":focus")
      ?.getAttribute("data-moc-path");

    this.list!.empty();

    if (mocs.length === 0) {
      this.status!.textContent = "还没有 Topic MOC。点「新建主题」创建一个。";
      return;
    }

    this.status!.textContent = "";

    for (const moc of mocs) {
      const row = this.list!.createEl("li", {
        cls: "paper-notes-moc-list-item-wrap",
      });
      const button = row.createEl("button", {
        cls: "paper-notes-moc-list-item paper-notes-moc-card",
        attr: { type: "button", "data-moc-path": moc.path },
      });

      const main = button.createDiv({ cls: "paper-notes-moc-card-main" });
      const icon = main.createEl("span", {
        cls: "paper-notes-moc-card-icon",
        attr: { "aria-hidden": "true" },
      });
      if (typeof setIcon === "function") {
        setIcon(icon, "bookmark");
      }

      main.createEl("span", {
        cls: "paper-notes-moc-card-title",
        text: moc.title,
      });

      button.addEventListener("click", (event: MouseEvent) => {
        void this.open(moc.path, Boolean(event.metaKey || event.ctrlKey));
      });

      if (focusedPath === moc.path) {
        button.focus();
      }
    }
  }

  private renderSearchResults(
    results: MocSearchResult[],
    searchTerms: string[],
  ): void {
    const focusedPath = this.list
      ?.querySelector<HTMLElement>(":focus")
      ?.getAttribute("data-moc-path");

    this.list!.empty();

    if (results.length === 0) {
      this.status!.textContent = "未找到匹配的主题或表格内容。";
      return;
    }

    this.status!.textContent = `共找到 ${results.length} 个匹配主题`;

    for (const result of results) {
      const { moc, matchingRowCount, excerpts } = result;
      const row = this.list!.createEl("li", {
        cls: "paper-notes-moc-list-item-wrap",
      });
      const button = row.createEl("button", {
        cls: "paper-notes-moc-list-item paper-notes-moc-card is-search-result",
        attr: { type: "button", "data-moc-path": moc.path },
      });

      const main = button.createDiv({ cls: "paper-notes-moc-card-main" });
      const icon = main.createEl("span", {
        cls: "paper-notes-moc-card-icon",
        attr: { "aria-hidden": "true" },
      });
      if (typeof setIcon === "function") {
        setIcon(icon, "bookmark");
      }

      const titleEl = main.createEl("span", {
        cls: "paper-notes-moc-card-title",
      });
      renderHighlightedText(titleEl, moc.title, searchTerms);

      if (matchingRowCount > 0) {
        main.createEl("span", {
          cls: "paper-notes-moc-card-badge",
          text: `${matchingRowCount} 处匹配`,
        });
      }

      // Up to 2 meaningful short excerpts with highlighted terms
      if (excerpts.length > 0) {
        const snippetsEl = button.createDiv({
          cls: "paper-notes-moc-card-snippets",
        });
        for (const excerpt of excerpts) {
          const itemEl = snippetsEl.createDiv({
            cls: "paper-notes-moc-card-snippet",
          });
          itemEl.createEl("span", {
            cls: "paper-notes-moc-snippet-tag",
            text: excerpt.columnLabel,
          });
          const textEl = itemEl.createEl("span", {
            cls: "paper-notes-moc-snippet-text",
          });
          renderHighlightedText(textEl, excerpt.snippet, searchTerms);
        }
      }

      button.addEventListener("click", (event: MouseEvent) => {
        void this.open(moc.path, Boolean(event.metaKey || event.ctrlKey));
      });

      if (focusedPath === moc.path) {
        button.focus();
      }
    }
  }

  private async open(path: string, newTab: boolean): Promise<void> {
    const signal = this.lifetime?.signal;
    if (!signal || signal.aborted) return;
    try {
      await this.source.openNote(path, newTab, signal);
    } catch (error) {
      if (!signal.aborted) new Notice(`无法打开主题：${String(error)}`);
    }
  }

  private async create(button: HTMLButtonElement): Promise<void> {
    if (this.creating || !this.source.createMoc) return;
    const lifetime = this.lifetime;
    this.creating = true;
    button.disabled = true;
    try {
      const path = await this.source.createMoc();
      if (lifetime?.signal.aborted || !this.host || !path) return;
      await this.refresh();
      if (!lifetime?.signal.aborted) await this.open(path, false);
    } catch (error) {
      if (!lifetime?.signal.aborted) new Notice(`无法创建主题：${String(error)}`);
    } finally {
      this.creating = false;
      button.disabled = false;
      if (this.createButton) this.createButton.disabled = !this.source.createMoc;
    }
  }
}
