/**
 * Create Literature Item modal (Task 25, Phase P7 / R6).
 *
 * Flow: User input → Preview dry-run (`previewCreate`) → Metadata review UI
 * → Confirmation (`confirmCreate`) → Item created.
 *
 * When cancelling or navigating back, zero mutations occur.
 * If the item already exists in the vault (`duplicate_exists`), creation is
 * prevented and a direct "Open existing paper" entry is offered instead.
 *
 * The modal never writes anything itself: all preview dry-runs and mutations
 * go through the CLI-backed callbacks provided by the view.
 */

import { existsSync } from "node:fs";

import { Modal, type App } from "obsidian";

import {
  buildCreateInput,
  confirmedValuesOf,
  isPreviewUnsupportedError,
  parseCreateInput,
  parseCreatePreview,
  type ActionOutcome,
  type CreateItemInput,
  type CreatePreviewData,
} from "../services/item-actions";
import type { ConfirmationModal } from "./confirmation-modal";

export interface CreateItemCallbacks {
  /**
   * Deprecated mutating create handler.
   * In Phase P7 / R6, creation must always use the preview-then-confirm flow
   * (previewCreate -> confirmCreate). Direct create is NEVER called by the modal,
   * even as a fallback, to prevent silent direct writes without review.
   * Retained in interface for caller backwards compatibility.
   */
  create?(input: CreateItemInput): Promise<ActionOutcome>;
  /** Preview dry-run for item create (Phase P7 / R6). */
  previewCreate?(input: CreateItemInput): Promise<ActionOutcome>;
  /** Resubmit confirmed create with token. */
  confirmCreate?(
    input: CreateItemInput,
    confirmed: Record<string, unknown>,
    confirmToken?: string,
  ): Promise<ActionOutcome>;
  /** Resubmit confirmed create (legacy alias). */
  confirm?(
    input: CreateItemInput,
    confirmed: Record<string, unknown>,
    confirmToken?: string,
  ): Promise<ActionOutcome>;
  cancel?(): void;
  notify(message: string): void;
  /** Local-file existence check for PDF inputs; defaults to `fs`. */
  fileExists?(path: string): boolean;
  /** Open an existing literature item in the vault (e.g. when duplicate_exists). */
  openExisting?(pathOrKey: string): void;
}

function formatPreviewAuthors(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(raw)) {
    const formatted = raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          if (typeof rec.literal === "string" && rec.literal.trim()) {
            return rec.literal.trim();
          }
          if (typeof rec.name === "string" && rec.name.trim()) {
            return rec.name.trim();
          }
          const family = typeof rec.family === "string" ? rec.family.trim() : "";
          const given = typeof rec.given === "string" ? rec.given.trim() : "";
          const combined = [family, given].filter(Boolean).join(" ");
          if (combined.length > 0) return combined;
        }
        return "";
      })
      .filter(Boolean);
    return formatted.length > 0 ? formatted.join("; ") : undefined;
  }
  return undefined;
}

function formatPreviewYear(yearRaw: unknown, dateRaw: unknown): string | undefined {
  if (typeof yearRaw === "number" && Number.isFinite(yearRaw)) {
    return String(yearRaw);
  }
  if (typeof yearRaw === "string" && yearRaw.trim()) {
    return yearRaw.trim();
  }
  if (typeof dateRaw === "string" && dateRaw.trim()) {
    const match = dateRaw.match(/\b(19\d\d|20\d\d)\b/);
    if (match) return match[1];
    return dateRaw.trim();
  }
  return undefined;
}

function extractIdentifiers(
  values: Record<string, unknown>,
  input: CreateItemInput,
): Array<{ label: string; value: string }> {
  const ids: Array<{ label: string; value: string }> = [];
  const doi = (values.doi ?? input.doi) as string | undefined;
  if (typeof doi === "string" && doi.trim().length > 0) {
    ids.push({ label: "DOI", value: doi.trim() });
  }
  const pmid = (values.pmid ?? input.pmid) as string | undefined;
  if (typeof pmid === "string" && pmid.trim().length > 0) {
    ids.push({ label: "PMID", value: pmid.trim() });
  }
  const pmcid = (values.pmcid ?? input.pmcid) as string | undefined;
  if (typeof pmcid === "string" && pmcid.trim().length > 0) {
    ids.push({ label: "PMCID", value: pmcid.trim() });
  }
  const arxiv = (values.arxiv ?? input.arxiv) as string | undefined;
  if (typeof arxiv === "string" && arxiv.trim().length > 0) {
    ids.push({ label: "arXiv", value: arxiv.trim() });
  }
  return ids;
}

export class CreateItemModal extends Modal {
  /** Maintained for backward compatibility with callers/tests. */
  confirmationModal: ConfirmationModal | undefined = undefined;
  inputEl!: HTMLInputElement;
  submitButton!: HTMLButtonElement;
  confirmButton: HTMLButtonElement | undefined;
  openExistingButton: HTMLButtonElement | undefined;
  backButton: HTMLButtonElement | undefined;
  retryButton: HTMLButtonElement | undefined;
  cancelButton: HTMLButtonElement | undefined;
  mode: "input" | "preview" | "error" = "input";

  private errorEl!: HTMLElement;
  private readonly callbacks: CreateItemCallbacks;
  private currentInputValue: string;
  private currentInput: CreateItemInput | undefined;
  private previewData: CreatePreviewData | undefined;
  private isSubmitting = false;
  private isClosed = false;
  private sessionId = 0;

  constructor(app: App, callbacks: CreateItemCallbacks, initialText = "") {
    super(app);
    this.callbacks = callbacks;
    this.currentInputValue = initialText;
  }

  override onOpen(): void {
    this.isClosed = false;
    this.renderInputView();
  }

  override close(): void {
    this.isClosed = true;
    this.sessionId++;
    super.close();
    this.callbacks.cancel?.();
  }

  renderInputView(): void {
    this.mode = "input";
    this.confirmButton = undefined;
    this.openExistingButton = undefined;
    this.retryButton = undefined;
    this.backButton = undefined;
    this.cancelButton = undefined;

    this.contentEl.empty();
    this.titleEl.setText("Create literature item");

    this.contentEl.createDiv({
      cls: "paper-notes-create-hint",
      text: "Enter a DOI, PMID, PMCID, arXiv identifier, an https URL, or a local PDF path.",
    });

    this.inputEl = this.contentEl.createEl("input", {
      type: "text",
      cls: "paper-notes-create-input",
      placeholder: "10.xxxx/..., PMID, arXiv, https://..., or /path/to/paper.pdf",
    });
    this.inputEl.value = this.currentInputValue;
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        void this.submit();
      }
    });

    this.errorEl = this.contentEl.createDiv({
      cls: "paper-notes-create-error is-hidden",
      attr: { role: "alert" },
    });

    const actions = this.contentEl.createDiv({ cls: "paper-notes-modal-actions" });
    this.cancelButton = actions.createEl("button", {
      text: "Cancel",
      cls: "paper-notes-btn-cancel",
    });
    this.cancelButton.addEventListener("click", () => this.close());

    this.submitButton = actions.createEl("button", { text: "Preview" });
    this.submitButton.addClass("mod-cta");
    this.submitButton.addEventListener("click", () => void this.submit());
  }

  /** Classify, validate, and route input to previewCreate dry-run. */
  async submit(): Promise<void> {
    const rawValue = this.inputEl?.value ?? this.currentInputValue;
    this.currentInputValue = rawValue;
    const parsed = parseCreateInput(rawValue);
    if (parsed.kind === "empty") {
      this.setError("Enter an identifier, URL, or local PDF path.");
      this.callbacks.notify("Enter an identifier, URL, or local PDF path.");
      return;
    }
    if (parsed.kind === "unrecognized") {
      this.setError(
        "Unrecognized input: use a DOI/PMID/PMCID/arXiv identifier, an https URL, or a local PDF path.",
      );
      this.callbacks.notify(
        "Unrecognized input: use a DOI/PMID/PMCID/arXiv identifier, an https URL, or a local PDF path.",
      );
      return;
    }
    if (parsed.kind === "pdf") {
      const fileExists = this.callbacks.fileExists ?? existsSync;
      if (!fileExists(parsed.path)) {
        this.setError(`PDF not found: ${parsed.path}`);
        this.callbacks.notify(`PDF not found: ${parsed.path}`);
        return;
      }
    }
    const input = buildCreateInput(parsed);
    if (input === undefined) {
      this.setError("Unrecognized input.");
      this.callbacks.notify("Unrecognized input.");
      return;
    }
    this.currentInput = input;
    this.setError(undefined);
    this.submitButton.disabled = true;
    this.submitButton.addClass("is-loading");
    this.submitButton.setText("正在获取元数据…");

    const session = ++this.sessionId;

    try {
      const outcome = await this.runPreview(input);
      if (this.isClosed || session !== this.sessionId) {
        return;
      }
      if (outcome.status === "needs_confirmation" || outcome.status === "success") {
        this.renderPreviewView(input, outcome);
        return;
      }
      this.renderErrorView(input, outcome);
    } catch (error: unknown) {
      if (this.isClosed || session !== this.sessionId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.renderErrorView(input, {
        status: "error",
        code: "preview_failed",
        message: `元数据获取失败: ${message}`,
      });
    } finally {
      if (this.mode === "input" && !this.isClosed) {
        this.submitButton.removeClass("is-loading");
        this.submitButton.setText("Preview");
        this.submitButton.disabled = false;
      }
    }
  }

  private setError(message: string | undefined): void {
    if (message === undefined) {
      this.errorEl.addClass("is-hidden");
      this.errorEl.setText("");
      return;
    }
    this.errorEl.removeClass("is-hidden");
    this.errorEl.setText(message);
  }

  private async runPreview(input: CreateItemInput): Promise<ActionOutcome> {
    if (this.callbacks.previewCreate) {
      return this.callbacks.previewCreate(input);
    }
    return {
      status: "error",
      code: "preview_unsupported",
      message:
        "paper-notes CLI does not support preview (--dry-run). Please upgrade the core CLI.",
    };
  }

  private async runConfirm(
    input: CreateItemInput,
    confirmed: Record<string, unknown>,
    token?: string,
  ): Promise<ActionOutcome> {
    if (this.callbacks.confirmCreate) {
      return this.callbacks.confirmCreate(input, confirmed, token);
    }
    if (this.callbacks.confirm) {
      return this.callbacks.confirm(input, confirmed, token);
    }
    return {
      status: "error",
      code: "confirm_unsupported",
      message: "No confirmation handler provided.",
    };
  }

  private renderPreviewView(input: CreateItemInput, outcome: ActionOutcome): void {
    this.mode = "preview";
    this.currentInput = input;
    const parsedPreview = parseCreatePreview(outcome);
    const dataObj =
      outcome.status !== "error" &&
      typeof outcome.envelope?.data === "object" &&
      outcome.envelope.data !== null
        ? (outcome.envelope.data as Record<string, unknown>)
        : {};

    const preview: CreatePreviewData = parsedPreview ?? {
      confirmation_token:
        outcome.status === "needs_confirmation"
          ? outcome.token
          : (typeof dataObj.confirmation_token === "string" ? dataObj.confirmation_token : ""),
      action:
        typeof dataObj.action === "string"
          ? dataObj.action
          : outcome.status === "needs_confirmation"
            ? "create_with_confirmation"
            : "create",
      plan:
        typeof dataObj.plan === "object" && dataObj.plan !== null && !Array.isArray(dataObj.plan)
          ? (dataObj.plan as Record<string, unknown>)
          : undefined,
      candidates: Array.isArray(dataObj.candidates)
        ? (dataObj.candidates as Array<Record<string, unknown>>)
        : undefined,
      citation_key: typeof dataObj.citation_key === "string" ? dataObj.citation_key : undefined,
      paper_id: typeof dataObj.paper_id === "string" ? dataObj.paper_id : undefined,
      path: typeof dataObj.path === "string" ? dataObj.path : undefined,
      pdf_sha256: typeof dataObj.pdf_sha256 === "string" ? dataObj.pdf_sha256 : null,
    };
    this.previewData = preview;

    const action =
      preview.action ??
      (typeof preview.plan?.action === "string" ? preview.plan.action : "create_with_confirmation");
    const isDuplicate = action === "duplicate_exists";
    const isReady = action === "create";
    const toneClass = isDuplicate ? "is-duplicate" : isReady ? "is-ready" : "is-warning";

    this.titleEl.setText(isDuplicate ? "库中已有文献" : "文献导入预览");
    this.contentEl.empty();
    const container = this.contentEl.createDiv({ cls: "paper-notes-create-preview" });

    // 1. Status Banner
    const statusBanner = container.createDiv({
      cls: `paper-notes-preview-status ${toneClass}`,
      attr: { role: "status" },
    });
    statusBanner.createEl("span", {
      cls: `paper-notes-preview-badge ${toneClass}`,
      text: isDuplicate ? "库中已有" : isReady ? "可创建" : "需确认",
    });
    const message =
      typeof preview.plan?.message === "string" && preview.plan.message.length > 0
        ? preview.plan.message
        : isDuplicate
          ? "文献库中已存在该条目，无需重复导入。"
          : isReady
            ? "元数据获取成功，确认后创建文献。"
            : "部分元数据缺失或需确认，确认后创建文献。";
    statusBanner.createEl("span", {
      cls: "paper-notes-preview-message",
      text: message,
    });

    // 2. Metadata Card
    const card = container.createDiv({ cls: "paper-notes-preview-card" });
    const planValues =
      typeof preview.plan?.values === "object" && preview.plan.values !== null
        ? (preview.plan.values as Record<string, unknown>)
        : undefined;
    const dataValues =
      typeof dataObj.values === "object" && dataObj.values !== null
        ? (dataObj.values as Record<string, unknown>)
        : undefined;

    const valuesPool: Record<string, unknown> = {
      ...dataObj,
      ...(dataValues ?? {}),
      ...(planValues ?? {}),
    };

    const title = (valuesPool.title ?? preview.plan?.title) as string | undefined;
    const authors = formatPreviewAuthors(valuesPool.authors ?? preview.plan?.authors);
    const journal = (valuesPool.journal ??
      valuesPool.venue ??
      valuesPool.publication_title) as string | undefined;
    const year = formatPreviewYear(valuesPool.year, valuesPool.publication_date);
    const identifiers = extractIdentifiers(valuesPool, input);
    const abstract = (valuesPool.abstract ?? valuesPool.summary) as string | undefined;

    this.renderFieldRow(card, "标题", typeof title === "string" ? title : undefined);
    this.renderFieldRow(card, "作者", authors);
    this.renderFieldRow(card, "期刊", typeof journal === "string" ? journal : undefined);
    this.renderFieldRow(card, "年份", year);

    // Identifiers row
    const idRow = card.createDiv({ cls: "paper-notes-preview-field" });
    idRow.createEl("span", { cls: "paper-notes-preview-label", text: "标识符" });
    if (identifiers.length > 0) {
      const idWrap = idRow.createDiv({ cls: "paper-notes-preview-value paper-notes-preview-ids" });
      for (const id of identifiers) {
        idWrap.createEl("span", {
          cls: "paper-notes-preview-id-badge",
          text: `${id.label}: ${id.value}`,
        });
      }
    } else {
      idRow.createEl("span", {
        cls: "paper-notes-preview-value is-missing paper-notes-preview-missing",
        text: "缺失",
      });
    }

    // Abstract (shown only when present)
    if (typeof abstract === "string" && abstract.trim().length > 0) {
      const abstractBlock = container.createDiv({ cls: "paper-notes-preview-abstract" });
      abstractBlock.createDiv({ cls: "paper-notes-preview-abstract-label", text: "摘要" });
      abstractBlock.createDiv({
        cls: "paper-notes-preview-abstract-content",
        text: abstract.trim(),
      });
    }

    // 3. Actions
    const actions = container.createDiv({ cls: "paper-notes-modal-actions" });
    if (isDuplicate) {
      this.openExistingButton = actions.createEl("button", {
        text: "打开已有文献",
        cls: "mod-cta paper-notes-btn-open-existing",
      });
      this.openExistingButton.addEventListener("click", () => {
        const target =
          preview.path ??
          (typeof preview.plan?.path === "string" ? preview.plan.path : undefined) ??
          preview.citation_key ??
          "";
        this.callbacks.openExisting?.(target);
        this.close();
      });

      this.cancelButton = actions.createEl("button", {
        text: "取消",
        cls: "paper-notes-btn-cancel",
      });
      this.cancelButton.addEventListener("click", () => this.close());
    } else {
      this.backButton = actions.createEl("button", {
        text: "返回修改",
        cls: "paper-notes-btn-back",
      });
      this.backButton.addEventListener("click", () => {
        if (this.isSubmitting) return;
        this.renderInputView();
      });

      this.cancelButton = actions.createEl("button", {
        text: "取消",
        cls: "paper-notes-btn-cancel",
      });
      this.cancelButton.addEventListener("click", () => {
        if (this.isSubmitting) return;
        this.close();
      });

      this.confirmButton = actions.createEl("button", {
        text: "确认创建",
        cls: "mod-cta paper-notes-btn-confirm",
      });
      this.confirmButton.addEventListener("click", () => {
        void this.confirm();
      });
    }
  }

  private renderFieldRow(
    parent: HTMLElement,
    label: string,
    value: string | undefined,
  ): HTMLElement {
    const row = parent.createDiv({ cls: "paper-notes-preview-field" });
    row.createEl("span", { cls: "paper-notes-preview-label", text: label });
    if (value !== undefined && value.trim().length > 0) {
      row.createEl("span", { cls: "paper-notes-preview-value", text: value.trim() });
    } else {
      row.createEl("span", {
        cls: "paper-notes-preview-value is-missing paper-notes-preview-missing",
        text: "缺失",
      });
    }
    return row;
  }

  async confirm(): Promise<void> {
    if (this.isSubmitting) {
      return;
    }
    if (!this.currentInput || !this.previewData) {
      return;
    }
    this.isSubmitting = true;
    if (this.confirmButton) {
      this.confirmButton.disabled = true;
      this.confirmButton.addClass("is-loading");
      this.confirmButton.setText("正在创建…");
    }

    const session = ++this.sessionId;

    try {
      const confirmed = confirmedValuesOf(this.previewData.plan) ?? {};
      const token = this.previewData.confirmation_token;

      const outcome = await this.runConfirm(this.currentInput, confirmed, token);
      if (this.isClosed || session !== this.sessionId) {
        return;
      }

      if (outcome.status === "success") {
        this.close();
        const key = outcome.envelope.data?.citation_key;
        this.callbacks.notify(
          `Created ${typeof key === "string" ? key : "literature item"}.`,
        );
        return;
      }

      if (outcome.status === "error") {
        this.callbacks.notify(outcome.message);
        return;
      }

      this.callbacks.notify(
        "The item still needs confirmation; please review the plan.",
      );
    } catch (error: unknown) {
      if (this.isClosed || session !== this.sessionId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.notify(`创建失败: ${message}`);
    } finally {
      if (!this.isClosed) {
        this.isSubmitting = false;
        if (this.confirmButton) {
          this.confirmButton.disabled = false;
          this.confirmButton.removeClass("is-loading");
          this.confirmButton.setText("确认创建");
        }
      }
    }
  }

  private renderErrorView(input: CreateItemInput, outcome: ActionOutcome): void {
    this.mode = "error";
    this.currentInput = input;
    this.contentEl.empty();
    this.titleEl.setText("Create literature item");

    const container = this.contentEl.createDiv({ cls: "paper-notes-create-preview" });
    const isUnsupported =
      outcome.status === "error" &&
      (outcome.code === "preview_unsupported" || isPreviewUnsupportedError(outcome));

    const errorBanner = container.createDiv({
      cls: "paper-notes-preview-status is-error",
      attr: { role: "alert" },
    });
    errorBanner.createEl("span", {
      cls: "paper-notes-preview-badge is-error",
      text: isUnsupported ? "预览不支持" : "元数据获取失败",
    });
    errorBanner.createEl("span", {
      cls: "paper-notes-preview-message",
      text:
        outcome.status === "error"
          ? isUnsupported
            ? "paper-notes CLI 不支持预览功能（--dry-run），请升级 core CLI。"
            : outcome.message
          : "Failed to fetch metadata.",
    });

    const actions = container.createDiv({ cls: "paper-notes-modal-actions" });

    if (!isUnsupported) {
      this.retryButton = actions.createEl("button", {
        text: "重试",
        cls: "mod-cta paper-notes-btn-retry",
      });
      this.retryButton.addEventListener("click", () => void this.submit());
    }

    this.backButton = actions.createEl("button", {
      text: "返回修改",
      cls: "paper-notes-btn-back",
    });
    this.backButton.addEventListener("click", () => this.renderInputView());

    this.cancelButton = actions.createEl("button", {
      text: "取消",
      cls: "paper-notes-btn-cancel",
    });
    this.cancelButton.addEventListener("click", () => this.close());
  }
}
