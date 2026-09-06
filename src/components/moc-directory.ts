/** Name-only MOC page hosted by the existing Library navigation. */
import { Notice } from "obsidian";
import { listTopicMocs, type MocListItem } from "../services/moc-index";

export interface MocDirectorySource {
  readonly literatureRoot: string;
  readText(path: string): Promise<string>;
  listMarkdownFiles(dir: string): string[];
  createMoc?(): Promise<string | undefined>;
  openNote(path: string, newTab: boolean, signal?: AbortSignal): Promise<void>;
}

export class MocDirectory {
  private host: HTMLElement | undefined;
  private list: HTMLElement | undefined;
  private status: HTMLElement | undefined;
  private generation = 0;
  private lifetime: AbortController | undefined;
  private creating = false;
  private createButton: HTMLButtonElement | undefined;

  constructor(private readonly source: MocDirectorySource) {}

  mount(host: HTMLElement): void {
    this.dispose();
    this.host = host;
    this.lifetime = new AbortController();
    const toolbar = host.createDiv({ cls: "paper-notes-moc-toolbar" });
    toolbar.createEl("h2", { text: "Topic MOC" });
    const create = toolbar.createEl("button", { text: "新建主题", cls: "mod-cta" });
    this.createButton = create;
    create.disabled = !this.source.createMoc || this.creating;
    create.addEventListener("click", () => void this.create(create));
    const refresh = toolbar.createEl("button", { text: "刷新" });
    refresh.addEventListener("click", () => void this.refresh());
    this.status = host.createDiv({ cls: "paper-notes-moc-status", attr: { role: "status" } });
    this.list = host.createEl("ul", { cls: "paper-notes-moc-list", attr: { "aria-label": "Topic MOC" } });
    void this.refresh();
  }

  dispose(): void {
    this.generation++;
    this.lifetime?.abort();
    this.host = this.list = this.status = undefined;
    this.createButton = undefined;
  }

  async refresh(): Promise<void> {
    if (!this.host) return;
    const generation = ++this.generation;
    this.status!.textContent = "正在加载主题…";
    try {
      const dir = `${this.source.literatureRoot.replace(/\/$/u, "")}/MOCs`;
      const notes = await Promise.all(this.source.listMarkdownFiles(dir).map(async (name) => {
        const path = `${dir}/${name}`;
        return { path, text: await this.source.readText(path) };
      }));
      if (!this.host || generation !== this.generation) return;
      this.renderItems(listTopicMocs(notes));
    } catch (error) {
      if (!this.host || generation !== this.generation) return;
      this.status!.textContent = `无法加载主题，请刷新重试：${String(error)}`;
    }
  }

  private renderItems(items: MocListItem[]): void {
    // Preserve keyboard focus across rename/delete/background refresh where possible.
    const focusedPath = this.list?.querySelector<HTMLElement>(":focus")?.getAttribute("data-moc-path");
    this.list!.empty();
    this.status!.textContent = items.length ? "" : "还没有 Topic MOC。点「新建主题」创建一个。";
    for (const item of items) {
      const row = this.list!.createEl("li");
      const button = row.createEl("button", {
        cls: "paper-notes-moc-list-item",
        text: item.title,
        attr: { type: "button", "data-moc-path": item.path },
      });
      button.addEventListener("click", (event: MouseEvent) => {
        void this.open(item.path, Boolean(event.metaKey || event.ctrlKey));
      });
      if (focusedPath === item.path) button.focus();
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
