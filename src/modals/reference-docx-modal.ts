/**
 * Reference DOCX Template Library modal (Stage R3 / ADR 0005).
 *
 * Symmetrically modeled after `src/modals/csl-style-modal.ts`: lists
 * imported `.docx` templates under `.paper-notes/reference-docx/`, marks
 * the current global default, lets the user import a local `.docx` file
 * and switch or delete templates (deleting the default is blocked).
 *
 * DOCX templates are binary files, so there is no text preview panel.
 */
import { Modal, type App } from "obsidian";

export interface ReferenceDocxModalCallbacks {
  /** List imported template file names only. */
  listTemplates(): Promise<string[]>;
  /**
   * Ask the caller to pick a local `.docx` file and return its name and
   * source path; `null` when the user cancels the pick.
   */
  pickTemplateFile(): Promise<{ name: string; sourcePath: string } | null>;
  /** Copy the picked file into the vault template directory. */
  importTemplate(sourcePath: string, fileName: string): Promise<void>;
  /** Persist the new global default template. */
  setDefault(file: string): Promise<void>;
  /** Currently selected default file name ("" when unset). */
  currentDefault(): string;
  /** Delete a template file. Throws if the file is the current default. */
  deleteTemplate(file: string): Promise<void>;
}

export interface ReferenceDocxModalHandle {
  open(): void;
  close(): void;
  contentEl: HTMLElement;
}

export function createReferenceDocxModal(
  app: App,
  callbacks: ReferenceDocxModalCallbacks,
  onCloseCallback?: () => void,
): ReferenceDocxModalHandle {
  class ReferenceDocxModal extends Modal {
    private templates: string[] = [];
    private listEl!: HTMLElement;
    private messageEl!: HTMLElement;

    constructor(
      modalApp: App,
      private readonly cb: ReferenceDocxModalCallbacks,
    ) {
      super(modalApp);
    }

    onOpen(): void {
      this.titleEl.setText("Reference DOCX templates");
      if (typeof this.contentEl.addClass === "function") {
        this.contentEl.addClass("paper-notes-refdocx-modal");
      }
      this.messageEl = this.contentEl.createDiv({
        cls: "paper-notes-refdocx-message",
      });
      this.listEl = this.contentEl.createDiv({
        cls: "paper-notes-refdocx-list",
      });
      const actions = this.contentEl.createDiv({
        cls: "paper-notes-modal-actions",
      });
      const importButton = actions.createEl("button", {
        text: "Import .docx…",
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
        this.templates = await this.cb.listTemplates();
        this.renderList();
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Could not list templates.",
        );
      }
    }

    private renderList(): void {
      this.listEl.empty();
      const currentDef = this.cb.currentDefault();
      for (const file of this.templates) {
        const isDefault = file === currentDef;
        const row = this.listEl.createDiv({
          cls: "paper-notes-refdocx-row",
          text: file,
        });

        const action = row.createEl("button", {
          text: isDefault ? "Default" : "Set default",
        });
        if (!isDefault) {
          action.addEventListener("click", (event?: unknown) => {
            (event as { stopPropagation?: () => void })?.stopPropagation?.();
            void this.setDefault(file);
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
            void this.deleteTemplate(file);
          });
        }
      }
    }

    private async setDefault(file: string): Promise<void> {
      try {
        await this.cb.setDefault(file);
      } catch (error) {
        this.showMessage(
          error instanceof Error
            ? error.message
            : "Could not set default template.",
        );
      }
      this.renderList();
    }

    private async deleteTemplate(file: string): Promise<void> {
      if (file === this.cb.currentDefault()) {
        this.showMessage("Cannot delete the current default template.");
        return;
      }
      try {
        await this.cb.deleteTemplate(file);
        this.showMessage(`Deleted template "${file}".`);
        await this.refresh();
      } catch (error) {
        this.showMessage(
          error instanceof Error ? error.message : "Delete failed.",
        );
      }
    }

    private async startImport(): Promise<void> {
      const picked = await this.cb.pickTemplateFile();
      if (picked === null) {
        return;
      }
      try {
        await this.cb.importTemplate(picked.sourcePath, picked.name);
        this.showMessage(`Imported "${picked.name}".`);
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

  return new ReferenceDocxModal(app, callbacks);
}
