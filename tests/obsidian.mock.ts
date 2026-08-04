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
