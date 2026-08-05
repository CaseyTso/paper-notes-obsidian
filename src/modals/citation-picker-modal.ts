/**
 * Keyboard citation picker modal (Task 27).
 *
 * Command-driven, multi-select picker for Pandoc citations. `Modal` is
 * imported statically (Repair: Gate D R8): a dynamic `import("obsidian")`
 * survives esbuild's CJS bundle and fails at runtime, because Obsidian
 * injects the `obsidian` module via `require`, not the ESM loader. The
 * shared test mock provides `Modal`, so the static import stays testable.
 *
 * Interaction model:
 * - Typing in the search input filters the candidate records (title,
 *   author, year, journal, DOI, PMID, key, alias). Typing `@` is plain
 *   text input — the picker never auto-activates from editor input; it is
 *   opened only by the explicit command.
 * - Clicking a result row toggles it in/out of the selection. Selection
 *   order is click order, which becomes the multi-citation order.
 * - Enter (in the input) or the Insert button delivers the selected
 *   records, in selection order, via `onPick`.
 *
 * Pure search/label/selection/insertion logic lives in
 * `src/services/citation-inserter.ts`; this file is a thin Obsidian
 * wrapper.
 */
import { Modal, type App } from "obsidian";

import type { PaperRecord } from "../types/paper";
import {
  citationLabelOf,
  toggleCitationSelection,
} from "../services/citation-inserter";

export interface CitationPickerCallbacks {
  /** Filter the picker candidates for the current query. */
  search(query: string): PaperRecord[];
  /** Deliver the selected records, in selection order. */
  onPick(records: PaperRecord[]): void;
}

export interface CitationPickerHandle {
  open(): void;
  close(): void;
  contentEl: HTMLElement;
}

/**
 * Create the picker modal (Repair: Gate D R8 — `Modal` statically
 * imported; dynamic `import("obsidian")` fails in the CJS bundle).
 */
export function createCitationPickerModal(
  app: App,
  callbacks: CitationPickerCallbacks,
): CitationPickerHandle {
  class CitationPickerModal extends Modal {
    private inputEl!: HTMLInputElement;
    private resultsEl!: HTMLElement;
    private results: PaperRecord[] = [];
    private selected: PaperRecord[] = [];

    constructor(modalApp: App, private readonly picker: CitationPickerCallbacks) {
      super(modalApp);
    }

    onOpen(): void {
      this.titleEl.setText("Insert citation");
      this.inputEl = this.contentEl.createEl("input", {
        type: "text",
        placeholder: "Search title, author, year, journal, DOI, PMID, key…",
        cls: "paper-notes-citation-input",
      });
      this.inputEl.addEventListener("input", () => this.refresh());
      this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.insert();
        }
      });
      this.resultsEl = this.contentEl.createDiv({
        cls: "paper-notes-citation-results",
      });
      this.renderActions();
      this.refresh();
    }

    private refresh(): void {
      this.results = this.picker.search(this.inputEl.value);
      this.rerender();
    }

    private rerender(): void {
      this.resultsEl.empty();
      for (const record of this.results) {
        const row = this.resultsEl.createDiv({
          cls: "paper-notes-citation-row",
          text: citationLabelOf(record),
        });
        if (this.selected.some((item) => item.paperId === record.paperId)) {
          row.addClass("is-selected");
        }
        row.addEventListener("click", () => this.toggle(record));
      }
    }

    private toggle(record: PaperRecord): void {
      this.selected = toggleCitationSelection(this.selected, record);
      this.rerender();
    }

    private renderActions(): void {
      const actions = this.contentEl.createDiv({
        cls: "paper-notes-modal-actions",
      });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.close());
      const insert = actions.createEl("button", { text: "Insert" });
      insert.addClass("mod-cta");
      insert.addEventListener("click", () => this.insert());
    }

    private insert(): void {
      if (this.selected.length === 0) {
        return;
      }
      this.close();
      this.picker.onPick(this.selected);
    }
  }

  return new CitationPickerModal(app, callbacks);
}
