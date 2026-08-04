/**
 * Confirmation and text-prompt modals (Task 25).
 *
 * `ConfirmationModal` renders a `needs_confirmation` payload (plan lines,
 * optional candidates) and invokes `onConfirm` exactly once when the user
 * confirms; the caller owns the token resubmission. `TextPromptModal` is
 * a single-input prompt used by the view for rename-key and PDF-attach
 * input. Both are thin Obsidian wrappers over the pure render helpers in
 * `src/services/item-actions.ts`.
 */

import { Modal, type App } from "obsidian";

export interface ConfirmationData {
  title: string;
  /** Human-readable plan lines (from `renderPlanLines`). */
  lines: string[];
  /** Optional candidate lines (from `renderCandidateLines`). */
  candidates?: string[];
  confirmLabel?: string;
}

export class ConfirmationModal extends Modal {
  private readonly data: ConfirmationData;
  private readonly onConfirm: () => void;
  private readonly onCancel: (() => void) | undefined;
  private confirmed = false;

  constructor(
    app: App,
    data: ConfirmationData,
    onConfirm: () => void,
    onCancel?: () => void,
  ) {
    super(app);
    this.data = data;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    this.titleEl.setText(this.data.title);
    const body = this.contentEl.createDiv({ cls: "paper-notes-confirmation" });
    for (const line of this.data.lines) {
      body.createDiv({ cls: "paper-notes-confirmation-line", text: line });
    }
    if (this.data.candidates !== undefined && this.data.candidates.length > 0) {
      const heading = body.createDiv({ cls: "paper-notes-confirmation-heading" });
      heading.setText("Candidates");
      for (const candidate of this.data.candidates) {
        body.createDiv({ cls: "paper-notes-confirmation-candidate", text: candidate });
      }
    }
    const actions = this.contentEl.createDiv({ cls: "paper-notes-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.close();
      this.onCancel?.();
    });
    const confirm = actions.createEl("button", {
      text: this.data.confirmLabel ?? "Confirm",
    });
    confirm.addClass("mod-cta");
    confirm.addEventListener("click", () => this.confirm());
  }

  /** Confirm the operation; guarded so `onConfirm` fires at most once. */
  confirm(): void {
    if (this.confirmed) {
      return;
    }
    this.confirmed = true;
    this.close();
    this.onConfirm();
  }
}

export interface TextPromptData {
  title: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
}

export interface TextPromptCallbacks {
  confirm(value: string): void;
  cancel?(): void;
}

export class TextPromptModal extends Modal {
  inputEl!: HTMLInputElement;
  private readonly data: TextPromptData;
  private readonly callbacks: TextPromptCallbacks;

  constructor(app: App, data: TextPromptData, callbacks: TextPromptCallbacks) {
    super(app);
    this.data = data;
    this.callbacks = callbacks;
  }

  onOpen(): void {
    this.titleEl.setText(this.data.title);
    this.inputEl = this.contentEl.createEl("input", {
      type: "text",
      placeholder: this.data.placeholder ?? "",
    });
    if (this.data.initial !== undefined) {
      this.inputEl.value = this.data.initial;
    }
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        this.submit();
      }
    });
    const actions = this.contentEl.createDiv({ cls: "paper-notes-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.close();
      this.callbacks.cancel?.();
    });
    const confirm = actions.createEl("button", {
      text: this.data.confirmLabel ?? "OK",
    });
    confirm.addClass("mod-cta");
    confirm.addEventListener("click", () => this.submit());
  }

  submit(): void {
    this.close();
    this.callbacks.confirm(this.inputEl.value);
  }
}
