/**
 * Create Literature Item modal (Task 25).
 *
 * A single input accepts a strong identifier (DOI / PMID / PMCID /
 * arXiv), an https URL, or a local PDF path (design spec §7.1). On
 * submit the input is classified by the pure `parseCreateInput`, routed
 * to `item create` through the injected callbacks, and a
 * `needs_confirmation` result is displayed in a `ConfirmationModal`;
 * confirming resubmits with the confirmed values file (the deterministic
 * token carrier for `item create`).
 *
 * The modal never writes anything itself: all mutations go through the
 * CLI-backed callbacks provided by the view.
 */

import { existsSync } from "node:fs";

import { Modal, type App } from "obsidian";

import {
  buildCreateInput,
  confirmedValuesOf,
  parseCreateInput,
  renderCandidateLines,
  renderPlanLines,
  type ActionOutcome,
  type CreateItemInput,
} from "../services/item-actions";
import { ConfirmationModal } from "./confirmation-modal";

export interface CreateItemCallbacks {
  create(input: CreateItemInput): Promise<ActionOutcome>;
  confirm(input: CreateItemInput, confirmed: Record<string, unknown>): Promise<ActionOutcome>;
  notify(message: string): void;
  /** Local-file existence check for PDF inputs; defaults to `fs`. */
  fileExists?(path: string): boolean;
}

export class CreateItemModal extends Modal {
  /** Confirmation modal shown for `needs_confirmation` (exposed for tests). */
  confirmationModal: ConfirmationModal | undefined;
  inputEl!: HTMLInputElement;
  submitButton!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private readonly callbacks: CreateItemCallbacks;
  private readonly initialText: string;

  constructor(app: App, callbacks: CreateItemCallbacks, initialText = "") {
    super(app);
    this.callbacks = callbacks;
    this.initialText = initialText;
  }

  onOpen(): void {
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
    this.inputEl.value = this.initialText;
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
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    this.submitButton = actions.createEl("button", { text: "Create" });
    this.submitButton.addClass("mod-cta");
    this.submitButton.addEventListener("click", () => void this.submit());
  }

  /** Classify, validate, and route the current input to `item create`. */
  async submit(): Promise<void> {
    const parsed = parseCreateInput(this.inputEl.value);
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
    this.setError(undefined);
    this.submitButton.disabled = true;
    this.submitButton.addClass("is-loading");
    this.submitButton.setText("Creating…");
    try {
      const outcome = await this.callbacks.create(input);
      if (outcome.status === "success") {
        this.close();
        const key = outcome.envelope.data.citation_key;
        this.callbacks.notify(
          `Created ${typeof key === "string" ? key : "literature item"}.`,
        );
        return;
      }
      if (outcome.status === "needs_confirmation") {
        this.showConfirmation(input, outcome);
        return;
      }
      this.setError(outcome.message);
      this.callbacks.notify(outcome.message);
    } finally {
      this.submitButton.removeClass("is-loading");
      this.submitButton.setText("Create");
      this.submitButton.disabled = false;
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

  private showConfirmation(input: CreateItemInput, outcome: ActionOutcome): void {
    if (outcome.status !== "needs_confirmation") {
      return;
    }
    const confirmed = confirmedValuesOf(outcome.envelope.data.plan);
    this.confirmationModal = new ConfirmationModal(
      this.app,
      {
        title: "Confirm literature item",
        lines: renderPlanLines(outcome.envelope.data.plan),
        candidates: renderCandidateLines(outcome.envelope.data.candidates),
      },
      () => {
        void this.resubmitWithConfirmation(input, confirmed ?? {});
      },
    );
    this.confirmationModal.open();
  }

  private async resubmitWithConfirmation(
    input: CreateItemInput,
    confirmed: Record<string, unknown>,
  ): Promise<void> {
    const outcome = await this.callbacks.confirm(input, confirmed);
    if (outcome.status === "success") {
      this.close();
      const key = outcome.envelope.data.citation_key;
      this.callbacks.notify(
        `Created ${typeof key === "string" ? key : "literature item"}.`,
      );
      return;
    }
    this.callbacks.notify(
      outcome.status === "error"
        ? outcome.message
        : "The item still needs confirmation; please review the plan.",
    );
  }
}
