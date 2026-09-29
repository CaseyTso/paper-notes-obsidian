/**
 * Literature Card creation modal (Task: Card Selection).
 *
 * Prompts the user for a conclusive, user-authored Literature Card Title.
 * - Initial input is blank and automatically focused.
 * - Title is strictly required (whitespace-only rejected with error).
 * - Enter creates, Esc cancels.
 * - On conflict or backend failure: input is retained, error is shown,
 *   modal stays open for editing and resubmission.
 * - Never suggests or pre-fills AI titles.
 */

import { Modal, type App } from "obsidian";

export interface LiteratureCardModalOptions {
  sourceSelection: string;
  onSubmit: (title: string) => Promise<boolean>;
  onCancel?: () => void;
}

export class LiteratureCardModal extends Modal {
  inputEl!: HTMLInputElement;
  errorEl!: HTMLElement;
  submitBtn!: HTMLButtonElement;
  cancelBtn!: HTMLButtonElement;

  private isSubmitting = false;
  private settled = false;
  private readonly options: LiteratureCardModalOptions;

  constructor(app: App, options: LiteratureCardModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.titleEl.setText("新建 Literature Card");

    const container = this.contentEl.createDiv({ cls: "paper-notes-card-modal" });

    // Excerpt preview (read-only quote block)
    const previewContainer = container.createDiv({ cls: "paper-notes-card-selection-preview" });
    previewContainer.createEl("label", { text: "选中文本：" });
    const previewText = previewContainer.createEl("blockquote", {
      text:
        this.options.sourceSelection.length > 200
          ? `${this.options.sourceSelection.slice(0, 200)}…`
          : this.options.sourceSelection,
    });
    previewText.addClass("paper-notes-card-preview-quote");

    // Title input group
    const inputGroup = container.createDiv({ cls: "paper-notes-card-input-group" });
    inputGroup.createEl("label", { text: "卡片标题（必填）：" });
    this.inputEl = inputGroup.createEl("input", {
      type: "text",
      placeholder: "输入卡片标题...",
      attr: { "aria-label": "卡片标题" },
    });
    this.inputEl.addClass("paper-notes-create-input");

    // Auto-focus the blank input
    this.inputEl.value = "";
    setTimeout(() => {
      this.inputEl?.focus?.();
    }, 0);

    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !this.isSubmitting) {
        event.preventDefault();
        void this.submit();
      }
    });

    // Error message element (hidden by default)
    this.errorEl = container.createDiv({ cls: "paper-notes-create-error" });
    this.errorEl.style.display = "none";

    // Actions
    const actions = container.createDiv({ cls: "paper-notes-modal-actions" });
    this.cancelBtn = actions.createEl("button", { text: "取消" });
    this.cancelBtn.addEventListener("click", () => {
      this.close();
    });

    this.submitBtn = actions.createEl("button", { text: "创建" });
    this.submitBtn.addClass("mod-cta");
    this.submitBtn.addEventListener("click", () => {
      if (!this.isSubmitting) {
        void this.submit();
      }
    });
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.options.onCancel?.();
    }
  }

  showError(message: string): void {
    this.errorEl.setText(message);
    this.errorEl.style.display = "block";
  }

  clearError(): void {
    this.errorEl.setText("");
    this.errorEl.style.display = "none";
  }

  setSubmitting(submitting: boolean): void {
    this.isSubmitting = submitting;
    this.inputEl.disabled = submitting;
    this.submitBtn.disabled = submitting;
    this.cancelBtn.disabled = submitting;
    if (submitting) {
      this.submitBtn.addClass("is-loading");
      this.submitBtn.setText("创建中...");
    } else {
      this.submitBtn.removeClass("is-loading");
      this.submitBtn.setText("创建");
    }
  }

  async submit(): Promise<void> {
    const title = this.inputEl.value.trim();
    if (!title) {
      this.showError("卡片标题为必填项。");
      this.inputEl.focus?.();
      return;
    }

    this.clearError();
    this.setSubmitting(true);

    try {
      const ok = await this.options.onSubmit(title);
      if (ok) {
        this.settled = true;
        this.close();
      } else {
        // Failed / Conflict: preserve input value, re-enable input and buttons
        this.setSubmitting(false);
        this.inputEl.focus?.();
      }
    } catch (error) {
      // Failed: preserve input value, show error, re-enable input and buttons
      this.setSubmitting(false);
      this.showError(error instanceof Error ? error.message : String(error));
      this.inputEl.focus?.();
    }
  }
}
