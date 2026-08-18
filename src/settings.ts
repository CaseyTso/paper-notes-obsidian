/**
 * Plugin settings (Task 22).
 *
 * Pure data model: `PaperNotesSettings` mirrors the plan's setting list
 * (CLI path, literature root, fixed export directory, Pandoc path, PDF
 * engine, reference DOCX, selected CSL, metric TTL). Persistence happens
 * through `Plugin.loadData`/`saveData` in `main.ts`; `normalizeSettings`
 * merges whatever was loaded over the defaults and drops unknown keys so
 * older `data.json` files keep working.
 */

import {
  clampColumnWidth,
  type LibraryColumnId,
} from "./components/library-table";

/** Known column ids accepted in persisted `columnWidths` (Batch 2 D). */
const COLUMN_IDS: readonly LibraryColumnId[] = [
  "title",
  "firstAuthor",
  "year",
  "journal",
  "cas",
  "jcr",
  "if",
  "jci",
  "artifacts",
  "readingStatus",
];

export interface PaperNotesSettings {
  /** Path to the paper-notes core CLI executable. */
  cliPath: string;
  /** Vault-relative root of the literature directories. */
  literatureRoot: string;
  /** Required, user-configured global export directory (no fallback). */
  exportDirectory: string;
  /** Pandoc binary used for DOCX/PDF export. */
  pandocPath: string;
  /** PDF engine passed to Pandoc (e.g. xelatex). */
  pdfEngine: string;
  /** Reference DOCX used for export styling (empty when unset). */
  referenceDocx: string;
  /**
   * Globally selected CSL style (Task 28): the style's file name inside
   * the vault-level `.paper-notes/csl/` directory (empty when unset).
   * CSL configuration is vault configuration, never paper metadata.
   */
  selectedCsl: string;
  /** EasyScholar metric cache lifetime in days (design: 30). */
  metricTtlDays: number;
  /**
   * Show EasyScholar metric badges in the library (UI-only volatile
   * data). Optional: absent means enabled (see `metricsEnabledOf`), so
   * the persisted-defaults contract of `DEFAULT_SETTINGS` stays stable.
   */
  metricsEnabled?: boolean;
  /**
   * Legacy detail-pane share of the former split layout (0–1), kept only
   * so older `data.json` files normalize cleanly. The Library shell no
   * longer reads it (full-width table + double-click drawer); the value
   * is tolerated but never consumed by the UI.
   */
  detailPaneRatio?: number;
  /**
   * Per-column width overrides (Batch 2 D), keyed by column id → px.
   * Persisted to `data.json` by the library view (merge-save, never
   * overwriting other keys); normalized here so corrupt values drop and
   * out-of-range widths clamp to the drag bounds.
   */
  columnWidths?: Partial<Record<LibraryColumnId, number>>;
  /**
   * Browser Connector toggle (Task 6). Absent means enabled so legacy
   * `data.json` files keep the Capture Bridge on by default.
   */
  browserConnectorEnabled?: boolean;
}

export const DEFAULT_SETTINGS: PaperNotesSettings = {
  cliPath: "paper-notes",
  literatureRoot: "05 Literature",
  exportDirectory: "",
  pandocPath: "pandoc",
  pdfEngine: "xelatex",
  referenceDocx: "",
  selectedCsl: "",
  metricTtlDays: 30,
};

/**
 * Vault-relative directory holding user-imported, validated CSL styles
 * (design spec §13). CSL styles are vault configuration assets, not
 * generated bibliographic data.
 */
export const CSL_STYLE_DIR = ".paper-notes/csl";

const STRING_FIELDS = [
  "cliPath",
  "literatureRoot",
  "exportDirectory",
  "pandocPath",
  "pdfEngine",
  "referenceDocx",
  "selectedCsl",
] as const satisfies readonly (keyof PaperNotesSettings)[];

export function normalizeSettings(loaded: unknown): PaperNotesSettings {
  const source =
    typeof loaded === "object" && loaded !== null
      ? (loaded as Record<string, unknown>)
      : {};
  const settings: PaperNotesSettings = { ...DEFAULT_SETTINGS };
  for (const key of STRING_FIELDS) {
    const value = source[key];
    if (typeof value === "string") {
      settings[key] = value;
    }
  }
  if (
    typeof source.metricTtlDays === "number" &&
    Number.isFinite(source.metricTtlDays)
  ) {
    settings.metricTtlDays = source.metricTtlDays;
  }
  if (typeof source.metricsEnabled === "boolean") {
    settings.metricsEnabled = source.metricsEnabled;
  }
  if (
    typeof source.detailPaneRatio === "number" &&
    Number.isFinite(source.detailPaneRatio)
  ) {
    // Soft-clamp here keeps data.json free of NaN/outliers; the layout
    // helper re-clamps on use for drag-time safety.
    const ratio = source.detailPaneRatio;
    if (ratio >= 0.05 && ratio <= 0.95) {
      settings.detailPaneRatio = ratio;
    }
  }
  if (
    typeof source.columnWidths === "object" &&
    source.columnWidths !== null
  ) {
    const raw = source.columnWidths as Record<string, unknown>;
    const normalized: Partial<Record<LibraryColumnId, number>> = {};
    for (const [id, width] of Object.entries(raw)) {
      if (
        (COLUMN_IDS as readonly string[]).includes(id) &&
        typeof width === "number" &&
        Number.isFinite(width)
      ) {
        normalized[id as LibraryColumnId] = clampColumnWidth(width);
      }
    }
    if (Object.keys(normalized).length > 0) {
      settings.columnWidths = normalized;
    }
  }
  return settings;
}

/**
 * Effective metrics-badge toggle: enabled unless explicitly disabled.
 * Absent/legacy `data.json` values keep badges on (UI-only volatile data).
 */
export function metricsEnabledOf(settings: PaperNotesSettings): boolean {
  return settings.metricsEnabled !== false;
}

/**
 * Effective Browser Connector toggle: enabled unless explicitly disabled.
 * Absent/legacy `data.json` values keep the Capture Bridge on.
 */
export function browserConnectorEnabledOf(settings: PaperNotesSettings): boolean {
  return settings.browserConnectorEnabled !== false;
}

/**
 * Export-relevant settings snapshot consumed by the Pandoc exporter
 * (Task 29). Keeps the export flow decoupled from the full settings object.
 */
export function exportConfigOf(settings: PaperNotesSettings): {
  exportDirectory: string;
  pandocPath: string;
  pdfEngine: string;
  referenceDocx: string;
  selectedCsl: string;
} {
  return {
    exportDirectory: settings.exportDirectory,
    pandocPath: settings.pandocPath,
    pdfEngine: settings.pdfEngine,
    referenceDocx: settings.referenceDocx,
    selectedCsl: settings.selectedCsl,
  };
}
