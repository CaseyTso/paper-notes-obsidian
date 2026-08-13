/**
 * Delete Literature Item modal (Library: Delete Flow).
 *
 * Opens IMMEDIATELY in a scanning state, runs the CLI dry-run preview
 * (`item delete --dry-run`) after open, then shows the file count, total
 * size, and external references. Delete stays disabled until a valid
 * `needs_confirmation` preview returns a token; the actual deletion is
 * executed by the CLI through the injected `confirm(token)` callback —
 * this modal never deletes anything itself. Final Delete disables all
 * controls and shows a deleting state, so double-submit is impossible.
 */

import { Modal, type App } from "obsidian";

import {
  buildDeletePreview,
  formatBytes,
  type ActionOutcome,
} from "../services/item-actions";

export interface DeleteItemCallbacks {
  /** Runs `item delete --dry-run`; resolves to the preview outcome. */
  preview(): Promise<ActionOutcome>;
  /** Executes the deletion with the preview token (CLI keeps its own checks). */
  confirm(token: string): void | Promise<void>;
  cancel?(): void;
  notify(message: string): void;
}

export class DeleteItemModal extends Modal {
  deleteButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private token: string | undefined;
  private deleting = false;
  private readonly callbacks: DeleteItemCallbacks;

  constructor(app: App, callbacks: DeleteItemCallbacks) {
    super(app);
    this.callbacks = callbacks;
  }

  onOpen(): void {
    this.titleEl.setText("Delete paper permanently");
    const body = this.contentEl.createDiv({ cls: "paper-notes-delete-preview" });
    this.statusEl = body.createDiv({
      cls: "paper-notes-delete-status is-scanning",
      text: "Scanning files and references…",
    });
    this.detailEl = body.createDiv({ cls: "paper-notes-delete-detail" });
    body.createDiv({
      cls: "paper-notes-delete-warning",
      text: "Permanently delete this paper folder and all files inside it. This cannot be undone.",
    });
    const actions = this.contentEl.createDiv({
      cls: "paper-notes-modal-actions",
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      if (this.deleting) {
        return;
      }
      this.close();
      this.callbacks.cancel?.();
    });
    this.deleteButton = actions.createEl("button", { text: "Delete" });
    this.deleteButton.addClass("mod-warning");
    this.deleteButton.disabled = true;
    this.deleteButton.addEventListener("click", () => this.confirmDelete());
    void this.runPreview();
  }

  /** Run the CLI dry-run; enable Delete only for a valid preview/token. */
  private async runPreview(): Promise<void> {
    const outcome = await this.callbacks.preview();
    if (this.deleting) {
      return;
    }
    if (outcome.status !== "needs_confirmation") {
      this.statusEl.removeClass("is-scanning");
      this.statusEl.addClass("is-error");
      this.statusEl.setText(
        outcome.status === "error"
          ? `Scan failed: ${outcome.message}`
          : "The CLI returned no deletion preview; deletion is not available.",
      );
      return;
    }
    const preview = buildDeletePreview(outcome.envelope.data);
    if (preview.key.length === 0) {
      this.statusEl.removeClass("is-scanning");
      this.statusEl.addClass("is-error");
      this.statusEl.setText("Cannot plan deletion: missing citation key.");
      return;
    }
    this.token = outcome.token;
    this.statusEl.removeClass("is-scanning");
    this.statusEl.setText(
      `Deletion preview ready — ${preview.fileCount} files, ${formatBytes(
        preview.totalBytes,
      )}, ${preview.backlinkCount} external reference(s).`,
    );
    this.detailEl.empty();
    this.detailEl.createDiv({
      cls: "paper-notes-delete-line",
      text: `Files: ${preview.fileCount}`,
    });
    this.detailEl.createDiv({
      cls: "paper-notes-delete-line",
      text: `Size: ${formatBytes(preview.totalBytes)}`,
    });
    this.detailEl.createDiv({
      cls: "paper-notes-delete-line",
      text: `References: ${preview.backlinkCount}`,
    });
    for (const line of preview.backlinkLines) {
      this.detailEl.createDiv({
        cls: "paper-notes-delete-backlink",
        text: line,
      });
    }
    this.deleteButton.disabled = false;
  }

  /** Final confirmation: single-shot, controls disabled while deleting. */
  private confirmDelete(): void {
    if (this.deleting || this.token === undefined) {
      return;
    }
    this.deleting = true;
    this.deleteButton.disabled = true;
    this.deleteButton.setText("Deleting…");
    this.statusEl.setText("Deleting…");
    void Promise.resolve(this.callbacks.confirm(this.token)).finally(() => {
      if (this.deleting) {
        this.close();
      }
    });
  }
}
