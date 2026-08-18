/**
 * Field-by-field Import Review modal (Task 8, UI polish round).
 *
 * Presents the review as grouped section cards instead of a dense wall of
 * text:
 * - one card per field with a bold label and the recommended/editable
 *   value;
 * - conflict rows render as selectable option cards with an official/web
 *   source badge (no hidden default — an explicit choice is required);
 * - required missing fields are highlighted and block submit until filled;
 * - the body scrolls and the action bar stays pinned; cancel is zero
 *   writes and confirm is one-shot.
 */

import { Modal, type App } from "obsidian";

import {
  buildReviewRows,
  REVIEW_FIELD_ORDER,
  type ReviewFieldRow,
} from "../services/review-model";
import type { PendingWebReview } from "../services/web-capture-actions";

export interface ImportReviewCallbacks {
  confirm(confirmed: Record<string, unknown>): void;
  cancel?(): void;
}

interface ReviewSection {
  title: string;
  fields: string[];
}

const REVIEW_SECTIONS: ReviewSection[] = [
  { title: "Paper", fields: ["item_type", "title", "authors", "publication_date", "year"] },
  {
    title: "Venue & pages",
    fields: ["journal", "journal_abbreviation", "volume", "issue", "pages"],
  },
  {
    title: "Identifiers & links",
    fields: ["doi", "pmid", "pmcid", "arxiv", "url", "issn"],
  },
  { title: "Text & language", fields: ["language", "abstract"] },
];

function parseConfirmedValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseAuthors(text: string): unknown {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    if (line.includes(",")) {
      const [family, given] = line.split(",", 2);
      return { family: family.trim(), given: (given ?? "").trim() };
    }
    return { literal: line };
  });
}

function isOfficialSource(source: string): boolean {
  return source === "crossref" || source === "pubmed" || source === "arxiv";
}

function sourceBadgeClass(source: string): string {
  return isOfficialSource(source) ? "is-official" : "is-web";
}

export class ImportReviewModal extends Modal {
  private confirmed = false;
  private readonly inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  private readonly radios = new Map<string, HTMLInputElement>();
  private submitButton!: HTMLButtonElement;
  private errorEl!: HTMLElement;

  constructor(
    app: App,
    private readonly review: PendingWebReview,
    private readonly callbacks: ImportReviewCallbacks,
  ) {
    super(app);
  }

  onOpen(): void {
    const plan = this.review.plan;
    const action = plan.action;
    const isUpdate = action === "update_existing";
    const isDuplicate = action === "confirm_candidates";

    this.titleEl.setText(
      isUpdate ? "Review metadata update" : isDuplicate ? "Possible duplicate" : "Review new capture",
    );

    this.modalEl.addClass("paper-notes-import-review-modal");
    const shell = this.contentEl.createDiv({ cls: "paper-notes-import-review" });

    // Summary header.
    const summary = shell.createDiv({ cls: "paper-notes-review-summary" });
    const badge = summary.createDiv({ cls: "paper-notes-review-badge" });
    badge.setText(isUpdate ? "Update" : isDuplicate ? "Duplicate" : "New capture");
    const message =
      typeof plan.message === "string" && plan.message.length > 0
        ? plan.message
        : isUpdate
          ? "A capture proposes metadata updates for an existing paper."
          : isDuplicate
            ? "A possible duplicate was found. Review before writing anything."
            : "A capture is ready to review. Confirm only what you want to keep.";
    summary.createDiv({ cls: "paper-notes-review-message", text: message });

    // Scrollable body with grouped section cards.
    const scroll = shell.createDiv({ cls: "paper-notes-review-scroll" });

    if (isDuplicate) {
      const hint = scroll.createDiv({ cls: "paper-notes-review-empty" });
      hint.setText(
        "This capture cannot be created automatically. Cancel to leave the library untouched, or create a new item explicitly.",
      );
    } else {
      const rowsByField = new Map<string, ReviewFieldRow>();
      for (const row of buildReviewRows(plan)) {
        rowsByField.set(row.field, row);
      }
      const fieldsInOrder = new Set<string>(REVIEW_FIELD_ORDER as readonly string[]);
      for (const section of REVIEW_SECTIONS) {
        const visible = section.fields.filter(
          (field) => fieldsInOrder.has(field) && rowsByField.has(field),
        );
        if (visible.length === 0) {
          continue;
        }
        const group = scroll.createDiv({ cls: "paper-notes-review-group" });
        group.createDiv({ cls: "paper-notes-review-group-title", text: section.title });
        for (const field of visible) {
          this.renderRow(group, rowsByField.get(field)!);
        }
      }
    }

    this.errorEl = shell.createDiv({
      cls: "paper-notes-review-error is-hidden",
      attr: { role: "alert" },
    });

    // Pinned action bar.
    const actions = shell.createDiv({ cls: "paper-notes-review-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.close();
      this.callbacks.cancel?.();
    });
    this.submitButton = actions.createEl("button", { text: this.confirmLabel() });
    this.submitButton.addClass("mod-cta");
    this.submitButton.addEventListener("click", () => this.confirm());

    // Focus the first required input (keyboard friendly).
    const firstRequired = [...this.inputs.values()].find((input) => {
      return input.closest(".paper-notes-review-row")?.hasClass?.("is-required") ?? false;
    });
    if (firstRequired !== undefined) {
      window.setTimeout(() => firstRequired.focus(), 0);
    }
  }

  private confirmLabel(): string {
    const action = this.review.plan.action;
    if (action === "update_existing") {
      return "Apply update";
    }
    if (action === "confirm_candidates") {
      return "Create anyway";
    }
    return "Create paper";
  }

  private renderRow(body: HTMLElement, row: ReviewFieldRow): void {
    const container = body.createDiv({ cls: "paper-notes-review-row" });
    if (row.editable && row.required) {
      container.addClass("is-required");
    }
    const labelRow = container.createDiv({ cls: "paper-notes-review-row-head" });
    const label = labelRow.createDiv({ cls: "paper-notes-review-field" });
    label.setText(row.label);
    if (row.required) {
      const required = labelRow.createEl("span", { cls: "paper-notes-review-required", text: "Required" });
      required.setAttribute("aria-label", "required");
    }
    if (row.conflictOptions.length > 0) {
      labelRow.createEl("span", { cls: "paper-notes-review-conflict-badge", text: "Conflicting" });
    }

    const valueArea = container.createDiv({ cls: "paper-notes-review-value-area" });

    if (row.editable) {
      const isTextarea = row.field === "authors";
      const input = isTextarea
        ? valueArea.createEl("textarea", {
            cls: "paper-notes-review-input",
            attr: {
              rows: "3",
              placeholder:
                row.field === "authors" ? "One author per line: Family, Given" : "Enter value…",
              "aria-label": `${row.label} (required)`,
            },
          })
        : valueArea.createEl("input", {
            cls: "paper-notes-review-input",
            attr: {
              type: row.field === "year" ? "number" : "text",
              placeholder: row.field === "year" ? "e.g. 2024" : "Enter value…",
              "aria-label": `${row.label} (required)`,
            },
          });
      input.addEventListener("input", () => {
        if (input.value.trim().length > 0) {
          container.removeClass("has-error");
          this.setError(undefined);
        }
      });
      this.inputs.set(row.field, input);
      return;
    }

    if (row.conflictOptions.length > 0) {
      valueArea.createDiv({ cls: "paper-notes-review-evidence", text: "Choose one source:" });
      const options = valueArea.createDiv({ cls: "paper-notes-review-options" });
      for (const option of row.conflictOptions) {
        const wrap = options.createDiv({ cls: "paper-notes-review-option" });
        const radio = wrap.createEl("input", {
          attr: {
            type: "radio",
            name: `field-${row.field}`,
            value: JSON.stringify(option.value),
            "data-source": option.source,
          },
        });
        wrap.createEl("span", {
          cls: `paper-notes-review-source-badge ${sourceBadgeClass(option.source)}`,
          text: option.source,
        });
        wrap.createEl("span", { cls: "paper-notes-review-option-value", text: option.value });
        radio.addEventListener("change", () => {
          this.radios.set(row.field, radio);
          wrap.addClass("is-selected");
          for (const sibling of wrap.parentElement?.children ?? []) {
            if (sibling !== wrap) {
              sibling.removeClass("is-selected");
            }
          }
          this.setError(undefined);
        });
      }
      return;
    }

    if (row.recommended !== undefined) {
      const value = valueArea.createDiv({ cls: "paper-notes-review-value" });
      value.setText(row.recommended);
    } else {
      const value = valueArea.createDiv({ cls: "paper-notes-review-muted" });
      value.setText("—");
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

  /** Build the confirmed values from explicit user choices only. */
  private buildConfirmed(): Record<string, unknown> {
    const confirmed: Record<string, unknown> = {};
    for (const [field, input] of this.inputs) {
      const value = input.value.trim();
      if (value.length === 0) {
        continue;
      }
      confirmed[field] = field === "authors" ? parseAuthors(value) : parseConfirmedValue(value);
    }
    for (const [field, radio] of this.radios) {
      if (!radio.checked) {
        continue;
      }
      const value = radio.getAttribute("value") ?? "";
      if (value.length > 0) {
        confirmed[field] = parseConfirmedValue(value);
      }
    }
    return confirmed;
  }

  private validate(): string | undefined {
    for (const [field, input] of this.inputs) {
      const row = input.closest(".paper-notes-review-row");
      if (row?.hasClass?.("is-required") && input.value.trim().length === 0) {
        row.addClass("has-error");
        return `${field === "title" ? "Title" : field === "authors" ? "Authors" : "Year"} is required.`;
      }
    }
    // For conflict rows, every conflict must be explicitly resolved.
    for (const row of this.contentEl.querySelectorAll(".paper-notes-review-row")) {
      const radios = row.querySelectorAll('input[type="radio"]');
      if (radios.length > 1) {
        const anyChecked = [...radios].some((radio) => (radio as HTMLInputElement).checked);
        if (!anyChecked) {
          const fieldLabel = row.querySelector(".paper-notes-review-field")?.textContent ?? "a field";
          return `Choose a value for ${fieldLabel}.`;
        }
      }
    }
    return undefined;
  }

  confirm(): void {
    if (this.confirmed) {
      return;
    }
    const validationError = this.validate();
    if (validationError !== undefined) {
      this.setError(validationError);
      return;
    }
    this.confirmed = true;
    this.submitButton.disabled = true;
    this.submitButton.setText("Working…");
    const confirmed = this.buildConfirmed();
    this.close();
    this.callbacks.confirm(confirmed);
  }
}
