import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { MocDirectory, type MocDirectorySource } from "../src/components/moc-directory";
import { PaperNotesMocView, VIEW_TYPE_TOPIC_MOC } from "../src/views/topic-moc-view";
import { TextPromptModal } from "../src/modals/confirmation-modal";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  ItemView: class {
    constructor(public leaf: unknown) {}
    open(): void {}
  },
  Modal: class {
    close(): void { (this as unknown as TextPromptModal).onClose(); }
  },
  setIcon: (el: unknown, icon: string) => {
    if (el && typeof el === "object" && "attrs" in el) {
      (el as { attrs: Record<string, string> }).attrs["data-icon"] = icon;
    }
  },
}));

/** Event-recording DOM double: assertions dispatch real registered handlers. */
class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, (event: unknown) => void> = {};
  private _textContent?: string;
  get textContent(): string {
    if (this._textContent !== undefined) return this._textContent;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(val: string) {
    this._textContent = val;
  }
  disabled = false;
  focused = false;
  value = "";
  constructor(public tag = "div", public cls = "") {}
  empty(): void {
    this.children = [];
    this._textContent = undefined;
  }
  createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): El {
    const el = new El(tag, options.cls);
    if (options.text !== undefined) el.textContent = options.text;
    el.attrs = options.attr ?? {};
    this.children.push(el);
    return el;
  }
  createDiv(options: Parameters<El["createEl"]>[1]): El { return this.createEl("div", options); }
  createSpan(options: Parameters<El["createEl"]>[1]): El { return this.createEl("span", options); }
  appendText(text: string): void {
    this.createEl("span", { text });
  }
  addClass(cls: string): void {
    const tokens = this.cls.split(" ").filter(Boolean);
    if (!tokens.includes(cls)) {
      this.cls = [...tokens, cls].join(" ");
    }
  }
  removeClass(cls: string): void {
    this.cls = this.cls.split(" ").filter((c) => c !== cls).join(" ");
  }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners[type] = listener; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  querySelector(selector: string): El | undefined {
    if (selector === ":focus") return this.all().find((el) => el.focused);
    if (selector.startsWith(".")) {
      const targetCls = selector.slice(1);
      return this.all().find((el) => el.cls.split(" ").includes(targetCls));
    }
    return undefined;
  }
  querySelectorAll(selector: string): El[] {
    if (selector.startsWith(".")) {
      const targetCls = selector.slice(1);
      return this.all().filter((el) => el.cls.split(" ").includes(targetCls));
    }
    return [];
  }
  focus(): void { this.focused = true; }
  trigger(type: string, event: unknown = {}): void { this.listeners[type]?.(event); }
  all(): El[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  click(event = {}): void { if (!this.disabled) this.listeners.click?.(event); }
}
const tick = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
const note = (title = "Theme"): string => `---\nkind: topic-moc\ntitle: ${title}\n---\nBody not rendered [[card_link]]`;
function setup(notes: Record<string, string> = { "Theme.md": note() }): { source: MocDirectorySource; page: MocDirectory; host: El } {
  const source: MocDirectorySource = {
    literatureRoot: "Custom Literature",
    listMarkdownFiles: vi.fn(() => Object.keys(notes)),
    readText: vi.fn(async (path) => notes[path.split("/").pop()!] ?? ""),
    openNote: vi.fn(async () => {}),
    createMoc: vi.fn(async () => undefined),
  };
  const page = new MocDirectory(source);
  const host = new El();
  page.mount(host as unknown as HTMLElement);
  return { source, page, host };
}
const rows = (host: El): El[] => host.all().filter((el) => el.cls.split(" ").includes("paper-notes-moc-list-item"));
const createButton = (host: El): El => host.all().find((el) => el.tag === "button" && el.textContent.includes("新建主题"))!;
const searchInput = (host: El): El => host.all().find((el) => el.attrs.type === "search")!;
const clearButton = (host: El): El => host.all().find((el) => el.cls.split(" ").includes("paper-notes-moc-search-clear"))!;
const statusEl = (host: El): El => host.all().find((el) => el.cls.split(" ").includes("paper-notes-moc-status"))!;

beforeEach(() => { notices.length = 0; });
describe("internal MOC directory", () => {
  it("lists names only in name order, without tables, cards, or Edit", async () => {
    const { host, source } = setup({ "z.md": note("Z"), "a.md": note("A"), "no.md": "# Unmarked" });
    await tick();
    expect(source.listMarkdownFiles).toHaveBeenCalledWith("Custom Literature/MOCs");
    expect(rows(host).map((row) => row.textContent)).toEqual(["A", "Z"]);
    expect(host.all().some((el) => ["table", "a"].includes(el.tag))).toBe(false);
    expect(host.all().map((el) => el.textContent).join(" ")).not.toMatch(/编辑|card_link|Body not rendered/);
    expect(rows(host).every((row) => row.tag === "button" && row.attrs.type === "button")).toBe(true);
  });

  it.each([{}, { metaKey: true }, { ctrlKey: true }])("dispatches normal/modifier native button activation (%j)", async (event) => {
    const { host, source } = setup();
    await tick();
    rows(host)[0].click(event);
    await tick();
    expect(source.openNote).toHaveBeenCalledWith("Custom Literature/MOCs/Theme.md", Boolean(event.metaKey || event.ctrlKey), expect.any(AbortSignal));
  });

  it("updates titles and paths after rename/delete and preserves focus on unchanged items", async () => {
    const notes = { "Theme.md": note() } as Record<string, string>;
    const { host, page } = setup(notes);
    await tick();
    rows(host)[0].focus();
    await page.refresh();
    expect(rows(host)[0].focused).toBe(true);
    delete notes["Theme.md"];
    notes["Renamed.md"] = note("Renamed");
    await page.refresh();
    expect(rows(host)[0].attrs["data-moc-path"]).toBe("Custom Literature/MOCs/Renamed.md");
    delete notes["Renamed.md"];
    await page.refresh();
    expect(rows(host)).toEqual([]);
    expect(host.all().some((el) => el.textContent.includes("还没有 Topic MOC"))).toBe(true);
  });

  it("ignores stale refreshes and never renders after disposal", async () => {
    const { host, page, source } = setup();
    await tick();
    const stale = deferred<string>();
    source.readText = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(note("Latest"));
    const old = page.refresh();
    await page.refresh();
    stale.resolve(note("Stale"));
    await old;
    expect(rows(host)[0].textContent).toBe("Latest");
    const pending = deferred<string>();
    source.readText = () => pending.promise;
    const refresh = page.refresh();
    page.dispose();
    host.empty();
    pending.resolve(note());
    await refresh;
    await page.refresh();
    expect(host.children).toEqual([]);
  });

  it("reports refresh failure and retries through the refresh button", async () => {
    const { source, page, host } = setup();
    await tick();
    source.readText = vi.fn().mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(note());
    await page.refresh();
    expect(host.all().some((el) => el.textContent.includes("read failed"))).toBe(true);
    host.all().find((el) => el.textContent === "刷新" || el.getAttribute("aria-label") === "刷新")!.click();
    await tick();
    expect(rows(host)).toHaveLength(1);
  });

  it("creates via source once, refreshes, then opens the created note", async () => {
    const notes: Record<string, string> = {};
    const { source, host } = setup(notes);
    source.createMoc = vi.fn(async () => {
      notes["New.md"] = note("New");
      return "Custom Literature/MOCs/New.md";
    });
    createButton(host).click();
    createButton(host).click();
    expect(createButton(host).disabled).toBe(true);
    await tick();
    expect(source.createMoc).toHaveBeenCalledTimes(1);
    expect(rows(host)[0].textContent).toBe("New");
    expect(source.openNote).toHaveBeenCalledWith("Custom Literature/MOCs/New.md", false, expect.any(AbortSignal));
    expect(createButton(host).disabled).toBe(false);
  });

  it("cancellation/failure do not open notes and allow retry", async () => {
    const { source, host } = setup();
    createButton(host).click();
    await tick();
    expect(source.openNote).not.toHaveBeenCalled();
    source.createMoc = vi.fn().mockRejectedValue(new Error("CLI failed"));
    createButton(host).click();
    await tick();
    expect(source.openNote).not.toHaveBeenCalled();
    expect(notices.join()).toContain("CLI failed");
    expect(createButton(host).disabled).toBe(false);
  });

  it("does not navigate after closing during create; returning to page restores Create", async () => {
    const { source, host, page } = setup();
    const pending = deferred<string>();
    source.createMoc = () => pending.promise;
    createButton(host).click();
    page.dispose();
    const nextHost = new El();
    page.mount(nextHost as unknown as HTMLElement);
    expect(createButton(nextHost).disabled).toBe(true);
    pending.resolve("Custom Literature/MOCs/New.md");
    await tick();
    expect(source.openNote).not.toHaveBeenCalled();
    expect(createButton(nextHost).disabled).toBe(false);
  });

  it("surfaces native open errors", async () => {
    const { source, host } = setup();
    await tick();
    source.openNote = vi.fn().mockRejectedValue(new Error("open failed"));
    rows(host)[0].click();
    await tick();
    expect(notices.join()).toContain("open failed");
  });

  it("searches table content, highlights terms, shows badges/snippets, and resets via clear/Escape", async () => {
    const notes = {
      "NMF.md": `---
kind: topic-moc
title: 单细胞NMF分析
---
| Title | Figure解读 | 总结 | 卡片 |
| --- | --- | --- | --- |
| 测序论文 | [[Figure解读_sc2024\\|单细胞图谱]] | 采用多样本质控评估 | [[card_1\\|质控卡片]] |
`,
      "CRS.md": `---
kind: topic-moc
title: CART-CRS核心机制
---
| Title | Figure解读 | 总结 | 卡片 |
| --- | --- | --- | --- |
| 细胞因子论文 | [[Figure解读_crs\\|CRS解读]] | 涉及巨噬细胞活化 | [[card_2\\|CRS卡片]] |
`,
    };

    const { host } = setup(notes);
    await tick();

    // 1. Ordinary state: 2 topic cards, no badges, no count
    expect(rows(host)).toHaveLength(2);
    expect(host.querySelectorAll(".paper-notes-moc-card-badge")).toHaveLength(0);
    expect(statusEl(host).textContent).toBe("");

    // 2. Search query matching table content of one topic
    const input = searchInput(host);
    input.value = "质控评估";
    input.trigger("input");

    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0].attrs["data-moc-path"]).toBe("Custom Literature/MOCs/NMF.md");
    expect(statusEl(host).textContent).toBe("共找到 1 个匹配主题");

    // Check badge & snippet
    const badge = host.querySelector(".paper-notes-moc-card-badge");
    expect(badge).toBeDefined();
    expect(badge?.textContent).toBe("1 处匹配");

    const snippetText = host.querySelector(".paper-notes-moc-snippet-text");
    expect(snippetText?.textContent).toContain("质控评估");
    const mark = host.querySelector(".paper-notes-moc-match");
    expect(mark).toBeDefined();
    expect(mark?.textContent).toBe("质控评估");

    // 3. Clear button click clears search and restores ordinary list
    const clear = clearButton(host);
    expect(clear.cls.split(" ")).not.toContain("is-hidden");
    clear.click();
    expect(input.value).toBe("");
    expect(clear.cls.split(" ")).toContain("is-hidden");
    expect(rows(host)).toHaveLength(2);
    expect(host.querySelectorAll(".paper-notes-moc-card-badge")).toHaveLength(0);

    // 4. Escape key clears search
    input.value = "CART";
    input.trigger("input");
    expect(rows(host)).toHaveLength(1);
    input.trigger("keydown", { key: "Escape", stopPropagation: () => {} });
    expect(input.value).toBe("");
    expect(rows(host)).toHaveLength(2);
  });

  it("preserves loading and error states without being overwritten by search input", async () => {
    // 1. Loading state preservation
    const pending = deferred<string>();
    const source: MocDirectorySource = {
      literatureRoot: "Custom Literature",
      listMarkdownFiles: vi.fn(() => ["Theme.md"]),
      readText: vi.fn(() => pending.promise),
      openNote: vi.fn(async () => {}),
      createMoc: vi.fn(async () => undefined),
    };
    const page = new MocDirectory(source);
    const host = new El();
    page.mount(host as unknown as HTMLElement);

    expect(statusEl(host).textContent).toBe("正在加载主题…");

    // Type while loading
    const input = searchInput(host);
    input.value = "something";
    input.trigger("input");

    // Status remains loading, not overwritten with "未找到匹配的主题"
    expect(statusEl(host).textContent).toBe("正在加载主题…");

    // Resolve the readText promise
    pending.resolve(note("Something Theme"));
    await tick();

    // After loading completes, search for "something" automatically applies
    expect(statusEl(host).textContent).toBe("共找到 1 个匹配主题");
    expect(rows(host)).toHaveLength(1);

    // 2. Error state preservation
    source.readText = vi.fn().mockRejectedValue(new Error("disk failure"));
    await page.refresh();
    expect(statusEl(host).textContent).toContain("无法加载主题，请刷新重试：Error: disk failure");

    // Typing in error state does not erase error status
    input.value = "other";
    input.trigger("input");
    expect(statusEl(host).textContent).toContain("无法加载主题，请刷新重试：Error: disk failure");
  });

  it("re-applies active search query after refresh", async () => {
    const notes: Record<string, string> = {
      "A.md": note("Alpha"),
      "B.md": note("Beta"),
    };
    const { host, page } = setup(notes);
    await tick();

    const input = searchInput(host);
    input.value = "Alpha";
    input.trigger("input");
    expect(rows(host)).toHaveLength(1);

    // Add another matching note and refresh
    notes["A2.md"] = note("Alpha 2");
    await page.refresh();

    // Query "Alpha" is still active and applied to new data
    expect(rows(host)).toHaveLength(2);
    expect(rows(host).map((r) => r.attrs["data-moc-path"])).toEqual([
      "Custom Literature/MOCs/A.md",
      "Custom Literature/MOCs/A2.md",
    ]);
  });
});

describe("legacy saved MOC leaf", () => {
  it("redirects to the internal page then detaches without rendering", async () => {
    const leaf = { detach: vi.fn() };
    const route = vi.fn(async () => {});
    const view = new PaperNotesMocView(leaf as unknown as WorkspaceLeaf, route);
    expect(typeof (view as unknown as { open: unknown }).open).toBe("function");
    expect(view.getViewType()).toBe(VIEW_TYPE_TOPIC_MOC);
    await view.onOpen();
    expect(route).toHaveBeenCalledOnce();
    expect(leaf.detach).toHaveBeenCalledOnce();
  });
  it("does not detach again if closed while redirecting", async () => {
    const leaf = { detach: vi.fn() };
    const pending = deferred<void>();
    const view = new PaperNotesMocView(leaf as unknown as WorkspaceLeaf, () => pending.promise);
    const opening = view.onOpen();
    await view.onClose();
    pending.resolve();
    await opening;
    expect(leaf.detach).not.toHaveBeenCalled();
  });
});

describe("new-theme text prompt", () => {
  it("settles cancel on Escape/backdrop close exactly once", () => {
    const callbacks = { confirm: vi.fn(), cancel: vi.fn() };
    const modal = new TextPromptModal({} as App, { title: "新建主题" }, callbacks);
    modal.onClose();
    modal.onClose();
    expect(callbacks.cancel).toHaveBeenCalledOnce();
    expect(callbacks.confirm).not.toHaveBeenCalled();
  });
  it("submits once and does not cancel the submitted operation on close", () => {
    const callbacks = { confirm: vi.fn(), cancel: vi.fn() };
    const modal = new TextPromptModal({} as App, { title: "新建主题" }, callbacks);
    modal.inputEl = { value: "New theme" } as HTMLInputElement;
    modal.submit();
    modal.submit();
    expect(callbacks.confirm).toHaveBeenCalledExactlyOnceWith("New theme");
    expect(callbacks.cancel).not.toHaveBeenCalled();
  });
});
