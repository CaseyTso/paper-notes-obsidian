/**
 * Minimal runtime mock of the `obsidian` module (types-only package).
 *
 * Used by tests via `vi.mock("obsidian", () => import("./obsidian.mock"))`.
 * Records view types and command ids registered by the plugin so tests can
 * assert what the plugin wired up on load.
 */

export const registeredViews: string[] = [];
export const registeredCommands: string[] = [];

export function resetRegistries(): void {
  registeredViews.length = 0;
  registeredCommands.length = 0;
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

  addCommand(command: { id: string }): { id: string } {
    registeredCommands.push(command.id);
    return command;
  }

  addSettingTab(_tab: unknown): void {
    // Recorded for signature compatibility; settings tabs are GUI-only and
    // not exercised by the headless mock suites.
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
}

export class WorkspaceLeaf {
  setViewState = (): void => {};
}

export class Modal {
  app: unknown;
  titleEl = { setText: () => {} };
  contentEl = {
    empty: () => {},
    createDiv: () => ({}),
    createEl: () => ({}),
  };

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
}

export class Notice {
  constructor(_message: string) {}
}

export class Menu {
  addItem(_cb: unknown): this {
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_event: unknown): void {}
  showAtPosition(_position: unknown): void {}
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
