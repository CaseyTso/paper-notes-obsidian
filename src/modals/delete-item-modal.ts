/**
 * Delete Literature Item modal (Task 25).
 *
 * Shows the read-only deletion preview (file count, total size, and
 * backlink references) from `item delete --dry-run` and requires the
 * user to type the exact canonical citation key before the Delete
 * button enables (design spec §8.3). The actual deletion is executed by
 * the CLI through the injected `confirm` callback with the preview
 * token — this modal never deletes anything itself.
 */

import { Modal, type App } from "obsidian";

import { confirmKeyMatches, formatBytes, type DeletePreview } from "../services/item-actions";

export interface DeleteItemCallbacks {
  confirm(): void | Promise<void>;
  cancel?(): void;
  notify(message: string): void;
}

export class DeleteItemModal extends Modal {
  keyInput!: HTMLInputElement;
  deleteButton!: HTMLButtonElement;
  private readonly preview: DeletePreview;
  private readonly callbacks: DeleteItemCallbacks;

  constructor(app: App, preview: DeletePreview, callbacks: DeleteItemCallbacks) {
    super(app);
    this.preview = preview;
    this.callbacks = callbacks;
  }

  onOpen(): void {
    this.titleEl.setText("Delete paper permanently");
    const body = this.contentEl.createDiv({ cls: "paper-notes-delete-preview" });
    body.createDiv({ cls: "paper-notes-delete-line", text: `Files: ${this.preview.fileCount}` });
    body.createDiv({
      cls: "paper-notes-delete-line",
      text: `Size: ${formatBytes(this.preview.totalBytes)}`,
    });
    body.createDiv({
      cls: "paper-notes-delete-line",
      text: `References: ${this.preview.backlinkCount}`,
    });
    for (const line of this.preview.backlinkLines) {
      body.createDiv({ cls: "paper-notes-delete-backlink", text: line });
    }
    body.createDiv({
      cls: "paper-notes-delete-warning",
      text: "Deletion is permanent and cannot be undone. Type the exact citation key to confirm.",
    });
    this.keyInput = this.contentEl.createEl("input", {
      type: "text",
      placeholder: `Type ${this.preview.key} to confirm`,
    });
    this.keyInput.addEventListener("input", () => this.updateDeleteEnabled());
    const actions = this.contentEl.createDiv({ cls: "paper-notes-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.close();
      this.callbacks.cancel?.();
    });
    this.deleteButton = actions.createEl("button", { text: "Delete" });
    this.deleteButton.addClass("mod-warning");
    this.deleteButton.disabled = true;
    this.deleteButton.addEventListener("click", () => this.confirmDelete());
  }

  /** Re-evaluate the exact-key gate; fail closed. */
  updateDeleteEnabled(): void {
    this.deleteButton.disabled = !confirmKeyMatches(this.keyInput.value, this.preview.key);
  }

  confirmDelete(): void {
    this.close();
    void this.callbacks.confirm();
  }
}
