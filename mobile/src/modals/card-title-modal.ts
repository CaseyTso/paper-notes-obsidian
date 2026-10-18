/**
 * Mobile-friendly card title prompt.
 *
 * A bottom-sheet modal with a large multi-line input, sized for thumbs and the
 * on-screen keyboard: it is anchored to the bottom of the screen, keeps the
 * excerpt preview above the input, and submits on Enter.
 *
 * This deliberately does **not** reuse the desktop `LiteratureCardModal`:
 * that one is a centred dialog tuned for a mouse and keyboard, and its DOM /
 * styling live in the desktop plugin's stylesheet. Only its *logic* (blank
 * titles rejected, Enter submits, Esc cancels, errors keep the input) is
 * mirrored here.
 */

import { Modal, type App } from "obsidian";

export interface CardTitleModalOptions {
  /** Selection excerpt, shown above the input for context. */
  excerpt: string;
  /** Resolves with the trimmed title, or `null` when the user cancelled. */
  onSubmit: (title: string) => Promise<boolean> | boolean;
}

const MAX_EXCERPT_LENGTH = 240;

export class CardTitleModal extends Modal {
  private readonly options: CardTitleModalOptions;
  private inputEl!: HTMLTextAreaElement;
  private errorEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private isSubmitting = false;
  private settled = false;

  constructor(app: App, options: CardTitleModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.titleEl.setText("新建 Literature Card");

    // Bottom sheet: full width, anchored to the bottom edge, above the
    // keyboard. Inline styles keep the mobile plugin self-contained (its
    // manifest loads no stylesheet).
    const modalEl = this.modalEl as HTMLElement & { style: CSSStyleDeclaration };
    modalEl.style.position = "fixed";
    modalEl.style.left = "0";
    modalEl.style.right = "0";
    modalEl.style.bottom = "0";
    modalEl.style.top = "auto";
    modalEl.style.width = "100%";
    modalEl.style.maxWidth = "100%";
    modalEl.style.maxHeight = "85%";
    modalEl.style.margin = "0";
    modalEl.style.borderRadius = "16px 16px 0 0";
    modalEl.style.display = "flex";
    modalEl.style.flexDirection = "column";
    modalEl.style.overflow = "hidden";
    modalEl.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
    const contentEl = this.contentEl as HTMLElement & { style: CSSStyleDeclaration };
    contentEl.style.padding = "16px";
    contentEl.style.overflowY = "auto";
    contentEl.style.flex = "1 1 auto";

    const container = this.contentEl.createDiv({ cls: "paper-notes-mobile-card-sheet" });

    // Excerpt preview (read-only quote block) so the user can see what they
    // selected before naming the card.
    const preview = container.createDiv({ cls: "paper-notes-mobile-card-preview" });
    preview.setText(
      this.options.excerpt.length > MAX_EXCERPT_LENGTH
        ? `${this.options.excerpt.slice(0, MAX_EXCERPT_LENGTH)}…`
        : this.options.excerpt,
    );

    // Title input — a textarea, not a one-line field, so long CJK titles stay
    // readable on a phone keyboard.
    const inputGroup = container.createDiv({ cls: "paper-notes-mobile-card-input-group" });
    inputGroup.createEl("label", { text: "卡片标题（必填）" });
    this.inputEl = inputGroup.createEl("textarea", {
      placeholder: "输入卡片标题…",
      attr: { "aria-label": "卡片标题", rows: "2" },
    });
    this.inputEl.addClass("paper-notes-mobile-card-input");
    this.inputEl.value = "";
    // Autofocus without stealing the keyboard before the sheet has animated.
    setTimeout(() => {
      this.inputEl?.focus?.();
    }, 0);

    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !this.isSubmitting) {
        // Enter submits; Shift+Enter stays a newline for multi-line titles.
        event.preventDefault();
        void this.submit();
      }
    });

    this.errorEl = container.createDiv({ cls: "paper-notes-mobile-card-error" });
    this.errorEl.style.display = "none";

    const actions = container.createDiv({ cls: "paper-notes-mobile-card-actions" });
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
      void Promise.resolve(this.options.onSubmit("")).catch(() => false);
    }
  }

  private showError(message: string): void {
    this.errorEl.setText(message);
    this.errorEl.style.display = "block";
  }

  private clearError(): void {
    this.errorEl.setText("");
    this.errorEl.style.display = "none";
  }

  private setSubmitting(submitting: boolean): void {
    this.isSubmitting = submitting;
    this.inputEl.disabled = submitting;
    this.submitBtn.disabled = submitting;
    this.cancelBtn.disabled = submitting;
    this.submitBtn.setText(submitting ? "创建中…" : "创建");
  }

  private async submit(): Promise<void> {
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
        // Conflict / failure: keep the input so the title can be edited and
        // resubmitted without retyping.
        this.setSubmitting(false);
        this.inputEl.focus?.();
      }
    } catch (error) {
      this.setSubmitting(false);
      this.showError(error instanceof Error ? error.message : String(error));
      this.inputEl.focus?.();
    }
  }
}
