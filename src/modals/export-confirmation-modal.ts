/**
 * Export confirmation modal (Task 29).
 *
 * Thin Obsidian wrapper over the Pandoc exporter. Shows the target path,
 * citation style, engine line and an explicit overwrite warning when the
 * target already exists; the user confirms before anything runs. While the
 * export runs a Stop button aborts the child process; the outcome (success
 * with open / show-in-Finder actions, failure with stderr, blocked with
 * unknown keys, or cancelled) is rendered inline.
 *
 * `Modal` is imported statically (Repair: Gate D R8): a dynamic
 * `import("obsidian")` survives esbuild's CJS bundle and fails at runtime,
 * because Obsidian injects the `obsidian` module via `require`, not the
 * ESM loader. The shared test mock provides `Modal`.
 */
import { Modal, type App } from "obsidian";

import type {
  ExportFormat,
  ExportRunResult,
  OpenRevealActions,
} from "../services/pandoc-export";

export interface ExportConfirmationProps {
  format: ExportFormat;
  /** Absolute path of the final target. */
  targetPath: string;
  /** Whether the target already exists (requires explicit overwrite). */
  targetExists: boolean;
  /** Title of the selected CSL style. */
  cslTitle: string;
  /** One-line engine/reference description; hidden when empty. */
  engineLabel: string;
  /** Desktop open / show-in-Finder actions for the success row. */
  actions: OpenRevealActions;
  /** Called when the user cancels before the export starts. */
  onCancel(): void;
}

export interface ExportRunHandle {
  /** Abort the running export (kills the child, cleans the temp output). */
  abort(): void;
  result: Promise<ExportRunResult>;
}

export interface ExportConfirmationCallbacks {
  /** Start the export; the modal controls cancellation via the handle. */
  start(): ExportRunHandle;
}

export interface ExportConfirmationHandle {
  open(): void;
  close(): void;
  contentEl: HTMLElement;
}

/** Create the export confirmation modal (Repair: Gate D R8 — `Modal` statically imported). */
export function createExportConfirmationModal(
  app: App,
  props: ExportConfirmationProps,
  callbacks: ExportConfirmationCallbacks,
): ExportConfirmationHandle {
  class ExportConfirmationModal extends Modal {
    private statusEl!: HTMLElement;
    private actionsEl!: HTMLElement;
    private running = false;

    constructor(modalApp: App) {
      super(modalApp);
    }

    onOpen(): void {
      this.titleEl.setText(props.format === "docx" ? "Export DOCX" : "Export PDF");

      const summary = this.contentEl.createDiv({
        cls: "paper-notes-export-summary",
      });
      summary.createDiv({
        cls: "paper-notes-export-target",
        text: props.targetPath,
      });
      if (props.targetExists) {
        summary.createDiv({
          cls: "paper-notes-export-warning",
          text: "This will overwrite the existing file.",
        });
      }
      if (props.cslTitle.length > 0) {
        summary.createDiv({ text: `Citation style: ${props.cslTitle}` });
      }
      if (props.engineLabel.length > 0) {
        summary.createDiv({ text: props.engineLabel });
      }

      this.statusEl = this.contentEl.createDiv({
        cls: "paper-notes-export-status",
      });
      this.actionsEl = this.contentEl.createDiv({
        cls: "paper-notes-modal-actions",
      });
      this.renderIdle();
    }

    private renderIdle(): void {
      this.statusEl.empty();
      this.actionsEl.empty();
      const exportButton = this.actionsEl.createEl("button", { text: "Export" });
      exportButton.addEventListener("click", () => {
        void this.startExport();
      });
      const cancelButton = this.actionsEl.createEl("button", { text: "Cancel" });
      cancelButton.addEventListener("click", () => {
        props.onCancel();
        this.close();
      });
    }

    private async startExport(): Promise<void> {
      if (this.running) {
        return;
      }
      this.running = true;
      const handle = callbacks.start();
      this.statusEl.empty();
      this.statusEl.setText("Exporting…");
      this.actionsEl.empty();
      const stopButton = this.actionsEl.createEl("button", { text: "Stop" });
      stopButton.addEventListener("click", () => handle.abort());

      const result = await handle.result;
      this.renderResult(result);
    }

    private renderResult(result: ExportRunResult): void {
      this.statusEl.empty();
      this.actionsEl.empty();
      switch (result.status) {
        case "success": {
          const target = result.targetPath ?? props.targetPath;
          this.statusEl.setText(`Exported to ${target}`);
          for (const choice of [
            {
              label: "Open file",
              run: () => props.actions.open(target),
            },
            {
              label: "Show in Finder",
              run: () => props.actions.reveal(target),
            },
          ]) {
            const button = this.actionsEl.createEl("button", {
              text: choice.label,
            });
            button.addEventListener("click", () => {
              void choice.run();
            });
          }
          this.addDoneButton();
          break;
        }
        case "blocked": {
          const keys = result.unknownKeys?.join(", ") ?? "";
          this.statusEl.setText(
            `Export blocked — unknown citation key(s): ${keys}.`,
          );
          this.addDoneButton();
          break;
        }
        case "cancelled": {
          this.statusEl.setText("Export cancelled.");
          this.addDoneButton();
          break;
        }
        case "failed": {
          const detail =
            result.stderr.length > 2000
              ? `…${result.stderr.slice(-2000)}`
              : result.stderr;
          this.statusEl.setText(
            `Export failed${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}.`,
          );
          if (detail.length > 0) {
            this.statusEl.createEl("pre", {
              cls: "paper-notes-export-error",
              text: detail,
            });
          }
          this.addDoneButton();
          break;
        }
      }
    }

    private addDoneButton(): void {
      const doneButton = this.actionsEl.createEl("button", { text: "Done" });
      doneButton.addEventListener("click", () => this.close());
    }
  }

  return new ExportConfirmationModal(app);
}
