/**
 * CSL Style Manager modal (Task 28).
 *
 * Thin Obsidian wrapper over `src/services/csl-style-manager.ts`: lists
 * the imported styles (title/id/file), marks the current global default,
 * lets the user import a local `.csl` file and switch the default.
 *
 * The modal is intentionally kept off the static import graph: `Modal` is
 * only imported inside `createCslStyleModal`, so the plugin's static graph
 * stays obsidian-value free for the shared test mock (same pattern as the
 * citation picker modal).
 *
 * File picking is delegated to the caller through `pickCslFile` so the
 * DOM-specific part lives where Obsidian APIs are available; everything
 * this file does is plain element wiring over injected callbacks.
 */
import type { App } from "obsidian";

import type {
  CslImportResult,
  CslStyleMeta,
} from "../services/csl-style-manager";

export interface CslStyleModalCallbacks {
  /** List the imported styles (title/id/file). */
  listStyles(): Promise<CslStyleMeta[]>;
  /**
   * Ask the caller to pick a local `.csl` file and return its name and
   * text content; `null` when the user cancels the pick.
   */
  pickCslFile(): Promise<{ name: string; text: string } | null>;
  /** Import the picked style content (validated before any write). */
  importStyle(xml: string): Promise<CslImportResult>;
  /** Persist the new global default (settings.selectedCsl = file name). */
  setDefault(file: string): Promise<void>;
  /** Currently selected default file name ("" when none). */
  currentDefault(): string;
}

export interface CslStyleModalHandle {
  open(): void;
  close(): void;
  contentEl: HTMLElement;
}

/**
 * Create the CSL style manager modal. `Modal` is imported dynamically so
 * the static import graph never reaches the `obsidian` runtime module.
 */
export async function createCslStyleModal(
  app: App,
  callbacks: CslStyleModalCallbacks,
): Promise<CslStyleModalHandle> {
  const { Modal } = await import("obsidian");

  class CslStyleModal extends Modal {
    private styles: CslStyleMeta[] = [];
    private listEl!: HTMLElement;
    private messageEl!: HTMLElement;

    constructor(
      modalApp: App,
      private readonly cb: CslStyleModalCallbacks,
    ) {
      super(modalApp);
    }

    onOpen(): void {
      this.titleEl.setText("CSL styles");
      this.messageEl = this.contentEl.createDiv({
        cls: "paper-notes-csl-message",
      });
      this.listEl = this.contentEl.createDiv({
        cls: "paper-notes-csl-list",
      });
      const actions = this.contentEl.createDiv({
        cls: "paper-notes-modal-actions",
      });
      const importButton = actions.createEl("button", {
        text: "Import .csl…",
      });
      importButton.addEventListener("click", () => {
        void this.startImport();
      });
      const closeButton = actions.createEl("button", { text: "Close" });
      closeButton.addEventListener("click", () => this.close());
      void this.refresh();
    }

    private async refresh(): Promise<void> {
      try {
        this.styles = await this.cb.listStyles();
        this.renderList();
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Could not list CSL styles.",
        );
      }
    }

    private renderList(): void {
      this.listEl.empty();
      for (const style of this.styles) {
        const row = this.listEl.createDiv({
          cls: "paper-notes-csl-row",
          text: style.title,
        });
        row.createDiv({
          cls: "paper-notes-csl-id",
          text: `${style.id} (${style.file})`,
        });
        const isDefault = style.file === this.cb.currentDefault();
        const action = row.createEl("button", {
          text: isDefault ? "Default" : "Set default",
        });
        if (!isDefault) {
          action.addEventListener("click", () => {
            void this.setDefault(style.file);
          });
        }
      }
    }

    private async setDefault(file: string): Promise<void> {
      try {
        await this.cb.setDefault(file);
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Could not set default style.",
        );
      }
      this.renderList();
    }

    private async startImport(): Promise<void> {
      const picked = await this.cb.pickCslFile();
      if (picked === null) {
        return;
      }
      try {
        const outcome = await this.cb.importStyle(picked.text);
        if (outcome.status === "imported") {
          this.showMessage(
            `Imported "${outcome.meta.title}" from ${picked.name}.`,
          );
        } else {
          this.showMessage(
            `Style "${outcome.meta.title}" is already imported (${outcome.meta.file}).`,
          );
        }
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Import failed.",
        );
      }
      await this.refresh();
    }

    private showMessage(text: string): void {
      this.messageEl.setText(text);
    }
  }

  return new CslStyleModal(app, callbacks);
}
