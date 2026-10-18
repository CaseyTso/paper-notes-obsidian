/**
 * CSL Style Manager modal (Task 28).
 *
 * Thin Obsidian wrapper over `src/services/csl-style-manager.ts`: lists
 * the imported styles (title/id/file), marks the current global default,
 * lets the user import a local `.csl` file and switch the default.
 *
 * The modal imports `Modal` statically (Repair: Gate D R8): a dynamic
 * `import("obsidian")` survives esbuild's CJS bundle and fails at runtime,
 * because Obsidian injects the `obsidian` module via `require`, not the
 * ESM loader. The shared test mock provides `Modal`.
 *
 * File picking is delegated to the caller through `pickCslFile` so the
 * DOM-specific part lives where Obsidian APIs are available; everything
 * this file does is plain element wiring over injected callbacks.
 */
import { Modal, sanitizeHTMLToDom, type App } from "obsidian";

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
  /** Return cached preview HTML fragment or null if not yet generated. */
  readPreviewHtml(file: string): Promise<string | null>;
  /** Trigger background preview generation for the given style file. */
  generatePreview(file: string): Promise<void>;
  /** Delete a style file and its preview cache. Throws if default. */
  deleteStyle(file: string): Promise<void>;
}

export interface CslStyleModalHandle {
  open(): void;
  close(): void;
  contentEl: HTMLElement;
}

/**
 * Create the CSL style manager modal (Repair: Gate D R8 — `Modal`
 * statically imported; dynamic `import("obsidian")` fails in the CJS
 * bundle).
 */
export function createCslStyleModal(
  app: App,
  callbacks: CslStyleModalCallbacks,
  onCloseCallback?: () => void,
): CslStyleModalHandle {
  class CslStyleModal extends Modal {
    private styles: CslStyleMeta[] = [];
    private selectedStyleFile: string | null = null;
    private listEl!: HTMLElement;
    private messageEl!: HTMLElement;
    private previewEl!: HTMLElement;
    private previewInFlight = new Set<string>();

    constructor(
      modalApp: App,
      private readonly cb: CslStyleModalCallbacks,
    ) {
      super(modalApp);
    }

    onOpen(): void {
      this.titleEl.setText("CSL styles");
      if (typeof this.contentEl.addClass === "function") {
        this.contentEl.addClass("paper-notes-csl-modal");
      }
      this.messageEl = this.contentEl.createDiv({
        cls: "paper-notes-csl-message",
      });
      this.listEl = this.contentEl.createDiv({
        cls: "paper-notes-csl-list",
      });
      this.previewEl = this.contentEl.createDiv({
        cls: "paper-notes-csl-preview",
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

    onClose(): void {
      onCloseCallback?.();
    }

    private async refresh(): Promise<void> {
      try {
        this.styles = await this.cb.listStyles();
        if (
          this.selectedStyleFile &&
          !this.styles.some((s) => s.file === this.selectedStyleFile)
        ) {
          this.selectedStyleFile = null;
        }
        this.renderList();
        await this.refreshPreview();
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Could not list CSL styles.",
        );
      }
    }

    private renderList(): void {
      this.listEl.empty();
      const currentDef = this.cb.currentDefault();
      for (const style of this.styles) {
        const isDefault = style.file === currentDef;
        const isSelected = style.file === this.selectedStyleFile;
        const row = this.listEl.createDiv({
          cls: `paper-notes-csl-row${isSelected ? " is-selected" : ""}`,
          text: style.title,
        });
        row.addEventListener("click", () => {
          void this.selectStyle(style.file);
        });

        row.createDiv({
          cls: "paper-notes-csl-id",
          text: `${style.id} (${style.file})`,
        });

        const action = row.createEl("button", {
          text: isDefault ? "Default" : "Set default",
        });
        if (!isDefault) {
          action.addEventListener("click", (event?: unknown) => {
            (event as { stopPropagation?: () => void })?.stopPropagation?.();
            void this.setDefault(style.file);
          });
        }

        const deleteBtn = row.createEl("button", {
          text: "Delete",
        });
        if (isDefault) {
          if (
            typeof (
              deleteBtn as unknown as {
                setAttr?: (k: string, v: string) => void;
              }
            ).setAttr === "function"
          ) {
            (
              deleteBtn as unknown as {
                setAttr: (k: string, v: string) => void;
              }
            ).setAttr("disabled", "true");
          }
          (deleteBtn as HTMLButtonElement).disabled = true;
        } else {
          deleteBtn.addEventListener("click", (event?: unknown) => {
            (event as { stopPropagation?: () => void })?.stopPropagation?.();
            void this.deleteStyle(style.file);
          });
        }
      }
    }

    private async selectStyle(file: string): Promise<void> {
      this.selectedStyleFile = file;
      this.renderList();
      await this.refreshPreview();
    }

    private async refreshPreview(): Promise<void> {
      if (!this.previewEl) {
        return;
      }
      this.previewEl.empty();
      if (!this.selectedStyleFile) {
        this.previewEl.createDiv({
          cls: "paper-notes-csl-preview-empty",
          text: "Select a style to preview.",
        });
        return;
      }

      const file = this.selectedStyleFile;
      const html = await this.cb.readPreviewHtml(file);
      if (this.selectedStyleFile !== file) {
        return;
      }

      this.previewEl.empty();
      if (html !== null && html.trim().length > 0) {
        const previewContent = this.previewEl.createDiv({
          cls: "paper-notes-csl-preview-content",
        });
        previewContent.appendChild(sanitizeHTMLToDom(html));
      } else {
        this.previewEl.createDiv({
          cls: "paper-notes-csl-preview-empty",
          text: "Preview not yet generated.",
        });
        void this.triggerBackgroundPreview(file);
      }
    }

    private async triggerBackgroundPreview(file: string): Promise<void> {
      if (this.previewInFlight.has(file)) {
        return;
      }
      this.previewInFlight.add(file);
      try {
        await this.cb.generatePreview(file);
        if (this.selectedStyleFile === file) {
          const html = await this.cb.readPreviewHtml(file);
          if (this.selectedStyleFile === file) {
            this.previewEl.empty();
            if (html !== null && html.trim().length > 0) {
              const previewContent = this.previewEl.createDiv({
                cls: "paper-notes-csl-preview-content",
              });
              previewContent.appendChild(sanitizeHTMLToDom(html));
            } else {
              this.previewEl.createDiv({
                cls: "paper-notes-csl-preview-empty",
                text: "Preview unavailable.",
              });
            }
          }
        }
      } catch (error) {
        if (this.selectedStyleFile === file) {
          this.showMessage(
            error instanceof Error ? error.message : "Preview generation failed.",
          );
        }
      } finally {
        this.previewInFlight.delete(file);
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

    private async deleteStyle(file: string): Promise<void> {
      if (file === this.cb.currentDefault()) {
        this.showMessage("Cannot delete the current default style.");
        return;
      }
      try {
        await this.cb.deleteStyle(file);
        if (this.selectedStyleFile === file) {
          this.selectedStyleFile = null;
        }
        this.showMessage(`Deleted style "${file}".`);
        await this.refresh();
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Delete failed.",
        );
      }
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
          void this.cb.generatePreview(outcome.meta.file).catch(() => {});
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
