/**
 * Topic MOC View (Tasks 8 + 9).
 *
 * An ItemView that opens in the **center** leaf, lists Topic MOC themes on
 * the left, and renders the selected MOC's four-column Topic Table on the
 * right. Figure解读 and card links open notes in a new tab; rows are not
 * clickable as a unit.
 *
 * Mirrors the lifecycle patterns of `PaperNotesLibraryView`: `isOpen` (not
 * `open`), `onOpen`/`onClose` gate, `refresh()`.
 */

import { ItemView, Notice, WorkspaceLeaf, type TFile } from "obsidian";

import { listTopicMocs, type MocListItem } from "../services/moc-index";
import { parseMocNote, type MocEntry, type ParsedMoc } from "../services/moc-parse";

export const VIEW_TYPE_TOPIC_MOC = "paper-notes-topic-moc";

/** Interface the view needs from the plugin to read MOC notes. */
export interface MocViewSource {
  /** Vault root path (for adapter.getBasePath()). */
  getVaultRoot(): string;
  /** Literature root setting (default "05 Literature"). */
  literatureRoot: string;
  /** Read cached text of a vault file by path. */
  readText(path: string): Promise<string>;
  /** List `.md` basenames under a vault directory. */
  listMarkdownFiles(dir: string): string[];
  /** Open the create-MOC modal and call the CLI; returns path on success. */
  createMoc?(): Promise<string | undefined>;
  /** Resolve a wikilink target to a vault file via metadataCache. */
  resolveLink?(target: string, sourcePath: string): TFile | undefined;
  /** Open a file in a new tab in the same center group. */
  openFile?(file: TFile): void;
}

export class PaperNotesMocView extends ItemView {
  private isOpen = false;
  private items: MocListItem[] = [];
  private parsedMoc: ParsedMoc | undefined;
  selectedPath: string | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly source: MocViewSource,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TOPIC_MOC;
  }

  getDisplayText(): string {
    return "Topic MOC";
  }

  getIcon(): string {
    return "list";
  }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
  }

  /** Re-read the MOC folder and re-render. No-op when closed. */
  async refresh(): Promise<void> {
    if (!this.isOpen) {
      return;
    }
    await this.loadItems();
    await this.loadSelectedMoc();
    this.render();
  }

  private async loadItems(): Promise<void> {
    const dir = `${this.source.literatureRoot}/MOCs`;
    const names = this.source.listMarkdownFiles(dir);
    const notes = await Promise.all(
      names.map(async (name) => ({
        path: `${dir}/${name}`,
        text: await this.source.readText(`${dir}/${name}`),
      })),
    );
    this.items = listTopicMocs(notes);
  }

  private async loadSelectedMoc(): Promise<void> {
    this.parsedMoc = undefined;
    if (this.selectedPath === undefined) {
      return;
    }
    const text = await this.source.readText(this.selectedPath);
    this.parsedMoc = parseMocNote(this.selectedPath, text);
  }

  private render(): void {
    const container = this.containerEl;
    container.empty();

    const root = container.createDiv({ cls: "paper-notes-moc" });

    // --- Sidebar ---
    const sidebar = root.createDiv({ cls: "paper-notes-moc-sidebar" });

    const createBtn = sidebar.createEl("button", { text: "新建主题" });
    createBtn.addClass("mod-cta");
    createBtn.addEventListener("click", () => {
      void this.handleCreateMoc();
    });

    const list = sidebar.createDiv({ cls: "paper-notes-moc-list" });

    if (this.items.length === 0) {
      sidebar.createDiv({
        cls: "paper-notes-moc-empty",
        text: "还没有 Topic MOC。点「新建主题」创建一个。",
      });
    } else {
      for (const item of this.items) {
        const btn = list.createEl("button", {
          cls: "paper-notes-moc-list-item",
          text: item.title,
        });
        if (item.path === this.selectedPath) {
          btn.addClass("is-active");
        }
        btn.addEventListener("click", () => {
          this.selectedPath = item.path;
          void this.refresh();
        });
      }
    }

    // --- Main ---
    const main = root.createDiv({ cls: "paper-notes-moc-main" });

    if (this.selectedPath === undefined || this.parsedMoc === undefined) {
      main.createDiv({
        cls: "paper-notes-moc-placeholder",
        text: "从左侧选择一个主题。",
      });
      return;
    }

    this.renderTable(main, this.parsedMoc);
  }

  private renderTable(main: HTMLElement, moc: ParsedMoc): void {
    const wrap = main.createDiv({ cls: "paper-notes-moc-table-wrap" });
    const table = wrap.createEl("table", { cls: "paper-notes-moc-table" });

    // Header
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    for (const header of ["Title", "Figure解读", "总结", "卡片"]) {
      headerRow.createEl("th", { text: header });
    }

    // Body
    const tbody = table.createEl("tbody");
    for (const entry of moc.entries) {
      this.renderEntryRow(tbody, entry, moc.path);
    }

    // Empty table message
    if (moc.entries.length === 0) {
      main.createDiv({
        cls: "paper-notes-moc-empty-table",
        text: "暂无条目。在 Markdown 中添加表格行即可在此显示。",
      });
    }
  }

  private renderEntryRow(tbody: HTMLElement, entry: MocEntry, mocPath: string): void {
    const row = tbody.createEl("tr");

    // Title cell — text only
    row.createEl("td", { text: entry.titleText });

    // Figure解读 cell — clickable link if figureLink is set
    const figureCell = row.createEl("td");
    if (entry.figureLink) {
      const link = figureCell.createEl("a", {
        cls: "paper-notes-moc-link",
        text: entry.figureLink.replace(/\.md$/u, ""),
      });
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.openTarget(entry.figureLink!, mocPath, entry.figureKey);
      });
    }

    // 总结 cell — bullet lines as <ul><li>, plain lines as <p>
    const summaryCell = row.createEl("td");
    const lines = entry.summaryText.split("\n");
    const bulletLines: string[] = [];
    const plainLines: string[] = [];
    for (const line of lines) {
      if (line.trim().startsWith("- ")) {
        bulletLines.push(line);
      } else if (line.trim().length > 0) {
        plainLines.push(line);
      }
    }
    // Render plain lines first (if any)
    for (const line of plainLines) {
      summaryCell.createEl("p", { cls: "paper-notes-moc-summary-plain", text: line });
    }
    // Render bullet lines as a semantic list
    if (bulletLines.length > 0) {
      const ul = summaryCell.createEl("ul", { cls: "paper-notes-moc-summary-list" });
      for (const line of bulletLines) {
        const item = ul.createEl("li");
        item.textContent = line.replace(/^\s*-\s*/u, "").trim();
      }
    }

    // 卡片 cell — one chip per cardLink
    const cardCell = row.createEl("td");
    cardCell.addClass("paper-notes-moc-card-cell");
    for (const cardLink of entry.cardLinks) {
      const chip = cardCell.createEl("a", {
        cls: "paper-notes-moc-card-chip",
        text: cardLink.replace(/\.md$/u, ""),
      });
      chip.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.openTarget(cardLink, mocPath, entry.figureKey);
      });
    }
  }

  /**
   * Resolve and open a wikilink target.
   *
   * 1. metadataCache.getFirstLinkpathDest if available
   * 2. Else if figureKey is known, open ${literatureRoot}/${key}/Figure解读_${key}.md
   * 3. Else if card-like, search ${literatureRoot}/${figureKey}/cards/${name}.md
   * 4. Fail → Notice
   */
  private openTarget(
    target: string,
    mocPath: string,
    figureKey: string | undefined,
  ): void {
    // Try resolveLink from the source (uses metadataCache)
    if (this.source.resolveLink) {
      const file = this.source.resolveLink(target, mocPath);
      if (file) {
        this.doOpenFile(file);
        return;
      }
    }

    // Fallback: construct path from figureKey
    const stem = target.replace(/\.md$/u, "");
    if (figureKey) {
      if (stem.startsWith("Figure解读_")) {
        const path = `${this.source.literatureRoot}/${figureKey}/Figure解读_${figureKey}.md`;
        this.openByPath(path);
        return;
      }
      if (stem.startsWith("card_") || !stem.includes("/")) {
        const path = `${this.source.literatureRoot}/${figureKey}/cards/${stem}.md`;
        this.openByPath(path);
        return;
      }
    }

    new Notice(`找不到笔记：${target}`);
  }

  private openByPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file !== null && typeof file === "object" && "path" in file) {
      this.doOpenFile(file as TFile);
    } else {
      new Notice(`找不到笔记：${path}`);
    }
  }

  private doOpenFile(file: TFile): void {
    if (this.source.openFile) {
      this.source.openFile(file);
      return;
    }
    // Default: open in a new tab
    this.app.workspace.getLeaf("tab")?.openFile(file);
  }

  private async handleCreateMoc(): Promise<void> {
    if (!this.source.createMoc) {
      return;
    }
    const newPath = await this.source.createMoc();
    if (newPath !== undefined) {
      this.selectedPath = newPath;
      await this.refresh();
    }
  }
}
