/**
 * Import Review field model (Task 8).
 *
 * Pure, testable mapping from a Web Capture review plan to compact
 * field-by-field rows: field label, recommended value, official/web
 * evidence, required-missing editability, and explicit conflict choices.
 */

export interface ReviewConflictOption {
  source: string;
  value: string;
}

export interface ReviewFieldRow {
  field: string;
  label: string;
  /** Recommended value when the field is already sourced. */
  recommended?: string;
  /** Explicit options for a conflicting field (user must choose). */
  conflictOptions: ReviewConflictOption[];
  /** True when a required field is missing and must be entered. */
  editable: boolean;
  /** True when the field is required for an ID-less create. */
  required: boolean;
}

export const REVIEW_FIELD_ORDER = [
  "title",
  "authors",
  "year",
  "journal",
  "volume",
  "issue",
  "pages",
  "doi",
  "pmid",
  "pmcid",
  "arxiv",
  "issn",
  "abstract",
] as const;

const FIELD_LABELS: Record<string, string> = {
  item_type: "Item type",
  title: "Title",
  authors: "Authors",
  journal: "Journal",
  journal_abbreviation: "Journal abbreviation",
  publication_date: "Publication date",
  year: "Year",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  doi: "DOI",
  pmid: "PMID",
  pmcid: "PMCID",
  arxiv: "arXiv",
  url: "URL",
  issn: "ISSN",
  language: "Language",
  abstract: "Abstract",
};

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(stringValue).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function conflictsFor(
  conflicts: unknown,
  field: string,
): ReviewConflictOption[] {
  if (!Array.isArray(conflicts)) {
    return [];
  }
  for (const conflict of conflicts) {
    if (conflict === null || typeof conflict !== "object") {
      continue;
    }
    const record = conflict as Record<string, unknown>;
    if (record.field !== field || !Array.isArray(record.values)) {
      continue;
    }
    const options: ReviewConflictOption[] = [];
    for (const pair of record.values) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const source = typeof pair[0] === "string" ? pair[0] : "source";
        const value = stringValue(pair[1]);
        if (value !== undefined) {
          options.push({ source, value });
        }
      }
    }
    return options;
  }
  return [];
}

/**
 * Build review rows from a Web Capture plan.
 *
 * `create_with_confirmation`: rows from `plan.values` with editable
 * required fields when missing. `update_existing`: rows from
 * `plan.proposed_values`; missing fields are not editable (no new data is
 * invented for an existing item). Conflict evidence comes from
 * `plan.conflicts`.
 */
export function buildReviewRows(plan: Record<string, unknown>): ReviewFieldRow[] {
  const action = plan.action;
  const baseValues =
    action === "update_existing"
      ? (plan.proposed_values as Record<string, unknown> | undefined)
      : (plan.values as Record<string, unknown> | undefined);
  const conflicts = plan.conflicts;

  const rows: ReviewFieldRow[] = [];
  for (const field of REVIEW_FIELD_ORDER) {
    const value = baseValues?.[field];
    const options = conflictsFor(conflicts, field);
    const isCreate = action === "create_with_confirmation";
    const requiredMissing = isCreate && (field === "title" || field === "authors" || field === "year") && value === undefined;
    rows.push({
      field,
      label: FIELD_LABELS[field] ?? field,
      recommended: stringValue(value),
      conflictOptions: options,
      editable: requiredMissing,
      required: requiredMissing,
    });
  }
  return rows;
}
