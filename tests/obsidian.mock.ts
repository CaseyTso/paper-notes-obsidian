/**
 * Minimal runtime mock of the `obsidian` module (types-only package).
 *
 * Used by tests via `vi.mock("obsidian", () => import("./obsidian.mock"))`.
 * Records view types and command ids registered by the plugin so tests can
 * assert what the plugin wired up on load.
 */

export const registeredViews: string[] = [];
export const registeredCommands: string[] = [];
export const registeredCommandObjects: any[] = [];
export const registeredEvents: unknown[] = [];
export const recordedNotices: string[] = [];

export function resetRegistries(): void {
  registeredViews.length = 0;
  registeredCommands.length = 0;
  registeredCommandObjects.length = 0;
  registeredEvents.length = 0;
  recordedNotices.length = 0;
}

export class Plugin {
  app: unknown;
  manifest: unknown;

  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  registerView(type: string, _viewCreator: unknown): void {
    registeredViews.push(type);
  }

  addCommand(command: { id: string; [k: string]: any }): { id: string } {
    registeredCommands.push(command.id);
    registeredCommandObjects.push(command);
    return command;
  }

  addRibbonIcon(_icon: string, _title: string, _callback: () => void): void {
    // Ribbon is GUI-only; recorded for signature compatibility.
  }

  addSettingTab(_tab: unknown): void {
    // Recorded for signature compatibility; settings tabs are GUI-only and
    // not exercised by the headless mock suites.
  }

  registerEvent(eventRef: unknown): unknown {
    registeredEvents.push(eventRef);
    return eventRef;
  }
}

export class ItemView {
  leaf: unknown;
  containerEl: { empty: () => void; createEl: () => void };

  constructor(leaf: unknown) {
    this.leaf = leaf;
    this.containerEl = {
      empty: () => {},
      createEl: () => {},
    };
  }

  async setState(_state?: unknown, _result?: unknown): Promise<void> {}
  getState(): Record<string, unknown> {
    return {};
  }
}

export class WorkspaceLeaf {
  setViewState = (): void => {};
}

export function createMockEl(tag: string = "div"): any {
  const el: any = {
    tag,
    cls: "",
    textContent: "",
    value: "",
    disabled: false,
    style: {} as Record<string, string>,
    children: [] as any[],
    listeners: {} as Record<string, ((event?: any) => void)[]>,
    attrs: {} as Record<string, string>,
    addEventListener(type: string, fn: (event?: any) => void) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    removeEventListener(type: string, fn: (event?: any) => void) {
      if (this.listeners[type]) {
        this.listeners[type] = this.listeners[type].filter((f: any) => f !== fn);
      }
    },
    dispatchEvent(event: any) {
      const fns = this.listeners[event.type] ?? [];
      for (const fn of fns) fn(event);
    },
    setAttribute(name: string, val: string) {
      this.attrs[name] = val;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    setText(text: string) {
      this.textContent = text;
      return this;
    },
    addClass(cls: string) {
      this.cls = this.cls ? `${this.cls} ${cls}` : cls;
      return this;
    },
    removeClass(cls: string) {
      this.cls = this.cls
        .split(" ")
        .filter((c: string) => c !== cls)
        .join(" ");
      return this;
    },
    empty() {
      this.children = [];
    },
    createEl(t: string, opts: any = {}) {
      const child = createMockEl(t);
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text) child.setText(opts.text);
      if (opts.type) child.type = opts.type;
      if (opts.placeholder) child.placeholder = opts.placeholder;
      if (opts.attr) child.attrs = { ...opts.attr };
      this.children.push(child);
      return child;
    },
    createDiv(opts: any = {}) {
      return this.createEl("div", opts);
    },
    focus() {},
    blur() {},
    click() {
      const fns = this.listeners["click"] ?? [];
      for (const fn of fns) fn({});
    },
  };
  return el;
}

export class Modal {
  app: unknown;
  titleEl = createMockEl("div");
  contentEl = createMockEl("div");

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
}

export class Notice {
  message: string;
  duration?: number;
  constructor(message: string, duration?: number) {
    this.message = message;
    this.duration = duration;
    recordedNotices.push(message);
  }
}

export interface MockMenuItem {
  title: string;
  icon: string;
  disabled: boolean;
  onClickFn: () => void;
  setTitle(t: string): this;
  setIcon(i: string): this;
  setDisabled(d: boolean): this;
  onClick(cb: () => void): this;
}

export class Menu {
  items: MockMenuItem[] = [];

  addItem(cb: (item: MockMenuItem) => void): this {
    const item: MockMenuItem = {
      title: "",
      icon: "",
      disabled: false,
      onClickFn: () => {},
      setTitle(t: string) {
        this.title = t;
        return this;
      },
      setIcon(i: string) {
        this.icon = i;
        return this;
      },
      setDisabled(d: boolean) {
        this.disabled = d;
        return this;
      },
      onClick(fn: () => void) {
        this.onClickFn = fn;
        return this;
      },
    };
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_event: unknown): void {}
  showAtPosition(_position: unknown): void {}
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;

  constructor(path: string = "") {
    this.path = path;
    const parts = path.split("/");
    this.name = parts[parts.length - 1] ?? "";
    const dotIdx = this.name.lastIndexOf(".");
    this.extension = dotIdx >= 0 ? this.name.slice(dotIdx + 1) : "";
    this.basename = dotIdx >= 0 ? this.name.slice(0, dotIdx) : this.name;
  }
}

export class Editor {
  private text = "";
  private sel = "";
  private cursorFrom = { line: 0, ch: 0 };
  private cursorTo = { line: 0, ch: 0 };

  constructor(initialText: string = "") {
    this.text = initialText;
  }

  getValue(): string {
    return this.text;
  }

  setValue(val: string): void {
    this.text = val;
  }

  getSelection(): string {
    return this.sel;
  }

  setSelectionText(sel: string): void {
    this.sel = sel;
  }

  getCursor(which: "from" | "to" | "head" | "anchor" = "from"): { line: number; ch: number } {
    return which === "to" ? { ...this.cursorTo } : { ...this.cursorFrom };
  }

  setCursor(pos: { line: number; ch: number }): void {
    this.cursorFrom = { ...pos };
    this.cursorTo = { ...pos };
  }

  setSelectionCoords(from: { line: number; ch: number }, to: { line: number; ch: number }): void {
    this.cursorFrom = { ...from };
    this.cursorTo = { ...to };
  }

  focus(): void {}
  blur(): void {}
}

export class MarkdownView {
  file: TFile | null = null;
  editor: Editor | null = null;
  mode: "source" | "preview" = "source";
  leaf: unknown = null;
  containerEl = {
    empty: () => {},
    createEl: () => ({}),
    createDiv: () => ({}),
    style: {} as Record<string, string>,
    addClass: (_cls: string) => {},
    removeClass: (_cls: string) => {},
  };

  constructor(leaf?: unknown) {
    this.leaf = leaf ?? null;
    this.editor = new Editor();
  }

  getMode(): "source" | "preview" {
    return this.mode;
  }

  getState(): Record<string, unknown> {
    return { mode: this.mode, source: this.mode === "source" };
  }

  async save(): Promise<void> {}
}

export function setIcon(_el: unknown, _icon: string): void {}

/**
 * Headless stubs for the settings tab surface (src/settings-tab.ts). The
 * tab is GUI-only and never instantiated by the mock suites; these exist so
 * `import { PluginSettingTab, Setting } from "obsidian"` resolves.
 */
export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: { empty: () => void };

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = { empty: () => {} };
  }

  display(): void {}
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(_cb: (text: unknown) => void): this {
    return this;
  }
  addDropdown(_cb: (dropdown: unknown) => void): this {
    return this;
  }
  addToggle(_cb: (toggle: unknown) => void): this {
    return this;
  }
}
