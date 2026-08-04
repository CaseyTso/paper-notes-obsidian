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
  /** Globally selected CSL style (empty when unset). */
  selectedCsl: string;
  /** EasyScholar metric cache lifetime in days (design: 30). */
  metricTtlDays: number;
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
  return settings;
}
