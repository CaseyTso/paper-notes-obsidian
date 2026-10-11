/**
 * Pending (draft) Library Filters (Task 24 redesign).
 *
 * The Filter Panel edits a *draft* of the applied filters instead of
 * mutating the live query on every keystroke. Numeric controls
 * (year from/to, IF/JCI minimum) keep their **raw string** content so an
 * in-progress value such as `20` (while typing `2001`) or `0.` survives
 * round-trips; only an atomic, validated Apply converts the draft into a
 * usable `LibraryFilters` snapshot.
 *
 * Final product contract (plan v1): no sliders, minimum-only IF/JCI, no
 * upper bounds anywhere in the canonical draft/UI. `LibraryFilters` still
 * declares the legacy `ifMax`/`jciMax` fields for old callers, but nothing
 * in this module ever produces, propagates or reads them.
 *
 * Pure and vault-free: no DOM, no Obsidian, no metrics-cache access.
 */

import type { LibraryFilters, ArtifactPart } from "./library-filters";

/** The four raw numeric draft fields, used to key per-field errors. */
export type NumericFilterField = "yearFrom" | "yearTo" | "ifMin" | "jciMin";

/** A raw-string draft of the applied filters (pending panel state). */
export interface LibraryFilterDraft {
  /** Raw publication-year lower bound, 1000..9999; blank = unbounded. */
  yearFrom: string;
  /** Raw publication-year upper bound, 1000..9999; blank = unbounded. */
  yearTo: string;
  /** Raw non-negative decimal IF minimum; blank = unset (NOT "no limit"). */
  ifMin: string;
  /** Raw non-negative decimal JCI minimum; blank = unset (NOT "no limit"). */
  jciMin: string;
  /** Exact (case-insensitive) journal selection, or unset. */
  journal?: string;
  /** CAS partition selection: "1区" | "2区" | "3区" | "4区", or unset. */
  cas?: string;
  /** JCR quartile selection: "Q1" | "Q2" | "Q3" | "Q4", or unset. */
  jcr?: string;
  readingStatus?: LibraryFilters["readingStatus"];
  /** Cloned artifact requirements; every listed artifact must be present. */
  requiredArtifacts: ArtifactPart[];
}

/** Result of validating a draft: applicable filters, or per-field errors. */
export interface LibraryFilterDraftValidation {
  /**
   * Present only when the whole draft converted successfully. Never a
   * partially-applicable snapshot: an invalid draft yields no filters.
   */
  filters?: LibraryFilters;
  errors: Partial<Record<NumericFilterField, string>>;
}

/** Per-field native number-input failure flags (`validity.badInput`). */
export type LibraryFilterBadInput = Partial<Record<NumericFilterField, boolean>>;

/** The four fixed CAS partition choices offered by the panel. */
export const CAS_PARTITION_CHOICES: readonly string[] = [
  "1区",
  "2区",
  "3区",
  "4区",
];

/** The four fixed JCR quartile choices offered by the panel. */
export const JCR_QUARTILE_CHOICES: readonly string[] = ["Q1", "Q2", "Q3", "Q4"];

/**
 * A publication year is a four-digit integer in 1000..9999: the digit count
 * alone is not enough, because `0000`/`0001`/`0999` would otherwise
 * convert to 0/1/999 and could never reopen as a valid raw string.
 */
const YEAR_PATTERN = /^([1-9]\d{3})$/;
/** Inclusive numeric bounds for a publication year. */
const YEAR_MIN = 1000;
const YEAR_MAX = 9999;
/**
 * Non-negative decimal literals, including the forms a native
 * `type=number` input accepts while the user is still typing (`.5`, `5.`)
 * and scientific notation (`1e3`). Negative signs, `+`, `NaN` and
 * `Infinity` are rejected: the minimum is a non-negative finite number.
 */
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;


/**
 * EasyScholar CAS spellings seen in the wild. The dataset formats the value
 * as an OPTIONAL subject/vendor prefix followed by the partition rank:
 * `综合性期刊1区`, `医学1区`, `生物2区`, `中科院一区`, `CAS 1区`, or a bare
 * `1区` / `一区`.
 *
 * The rank is located as the trailing token and the preceding head must be
 * either empty or a pure-CJK subject/vendor label (`医学`, `生物`, `中科院`,
 * `综合性期刊`, …) or the ASCII vendor token `CAS`. That keeps the strict
 * rejections: `13区` (head digit), `1区2区` / `1区/2区` (mixed head),
 * `top1区` (ASCII head), `-1区`, `1.5区`, `5区`, `中科院五区`, and
 * suffixed forms like `中科院1区top` never resolve to a partition.
 */
const CAS_CJK_HEAD_PATTERN = /^[\u4e00-\u9fff]+$/;
const CAS_ASCII_VENDOR_PATTERN = /^CAS$/i;
const CAS_RANK_TAIL_PATTERN = /([1-4]|[一二三四])\s*区?$/;
const CAS_RANK_DIGITS = "1234";
const CAS_RANK_CHINESE = "一二三四";

/**
 * JCR spellings: a bare contiguous Q1–Q4 token (any case) after trimming
 * surrounding whitespace. Internal whitespace between the letter and the
 * digit (`Q 1`, `Q\n1`, `Q\t1`) is deliberately NOT accepted: the quartile
 * token is contiguous, and only outer trim plus case folding apply.
 */
const JCR_QUARTILE_PATTERN = /^Q([1-4])$/i;

/**
 * Canonical rank 1–4 for a raw CAS partition string, or `undefined` when
 * the value is missing, unknown or ambiguous.
 */
export function casPartitionRank(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const match = CAS_RANK_TAIL_PATTERN.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  // Everything before the trailing rank must be empty or a pure subject
  // label; digits, ASCII words other than CAS, or stray 区 make it invalid.
  const head = trimmed.slice(0, match.index).trim();
  if (
    head.length > 0 &&
    !CAS_CJK_HEAD_PATTERN.test(head) &&
    !CAS_ASCII_VENDOR_PATTERN.test(head)
  ) {
    return undefined;
  }
  const token = match[1];
  const arabic = CAS_RANK_DIGITS.indexOf(token);
  if (arabic >= 0) {
    return arabic + 1;
  }
  return CAS_RANK_CHINESE.indexOf(token) + 1;
}

/** Canonical quartile 1–4 for a raw JCR string, or `undefined`. */
export function jcrQuartile(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = JCR_QUARTILE_PATTERN.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

/**
 * Whether a raw CAS partition string belongs to the canonical partition
 * `wanted`. Missing/unknown/ambiguous values never match, so an unknown
 * rank can never behave like a wildcard.
 */
export function matchesCasPartition(value: string | undefined, wanted: string): boolean {
  const wantedRank = casPartitionRank(wanted);
  if (wantedRank === undefined) {
    return false;
  }
  return casPartitionRank(value) === wantedRank;
}

/** Whether a raw JCR string equals the canonical quartile `wanted`. */
export function matchesJcrQuartile(value: string | undefined, wanted: string): boolean {
  const wantedQuartile = jcrQuartile(wanted);
  if (wantedQuartile === undefined) {
    return false;
  }
  return jcrQuartile(value) === wantedQuartile;
}

/** Fresh empty draft (all raw fields blank, no conditions). */
export function createEmptyLibraryFilterDraft(): LibraryFilterDraft {
  return {
    yearFrom: "",
    yearTo: "",
    ifMin: "",
    jciMin: "",
    requiredArtifacts: [],
  };
}

/**
 * Clone applied filters into an editable draft. Raw numeric fields render
 * the applied numbers back as text; legacy upper bounds are intentionally
 * NOT propagated, so reopening the panel never resurrects `ifMax`/`jciMax`.
 * The `requiredArtifacts` array is copied (and de-duplicated) so panel
 * edits can never reach the applied state.
 */
export function createLibraryFilterDraft(applied: LibraryFilters): LibraryFilterDraft {
  const draft = createEmptyLibraryFilterDraft();
  if (applied.yearFrom !== undefined) {
    draft.yearFrom = String(applied.yearFrom);
  }
  if (applied.yearTo !== undefined) {
    draft.yearTo = String(applied.yearTo);
  }
  if (applied.ifMin !== undefined) {
    draft.ifMin = String(applied.ifMin);
  }
  if (applied.jciMin !== undefined) {
    draft.jciMin = String(applied.jciMin);
  }
  if (applied.journal !== undefined && applied.journal.trim().length > 0) {
    draft.journal = applied.journal;
  }
  if (applied.cas !== undefined && applied.cas.trim().length > 0) {
    draft.cas = applied.cas;
  }
  if (applied.jcr !== undefined && applied.jcr.trim().length > 0) {
    draft.jcr = applied.jcr;
  }
  if (applied.readingStatus !== undefined) {
    draft.readingStatus = applied.readingStatus;
  }
  draft.requiredArtifacts = uniqueArtifactParts(applied.requiredArtifacts);
  return draft;
}

/**
 * Validate one raw numeric field.
 *
 * `kind` selects the accepted shape: four-digit integer years or
 * non-negative decimal minima. A blank value is always valid (unbounded /
 * unset). Native `type=number` inputs report `validity.badInput` while the
 * user has typed something unparseable — the browser then exposes
 * `value === ""`, which must be rejected rather than read as "unbounded".
 */
function parseNumericField(
  kind: NumericFilterField,
  raw: string,
  badInput: boolean,
): { value?: number; error?: string } {
  const label =
    kind === "yearFrom"
      ? "Year from"
      : kind === "yearTo"
        ? "Year to"
        : kind === "ifMin"
          ? "IF minimum"
          : "JCI minimum";
  if (badInput) {
    return {
      error:
        kind === "yearFrom" || kind === "yearTo"
          ? `${label} must be a four-digit year from 1000 to 9999.`
          : `${label} must be a non-negative number.`,
    };
  }
  const text = raw.trim();
  if (text.length === 0) {
    return {};
  }
  if (kind === "yearFrom" || kind === "yearTo") {
    if (!YEAR_PATTERN.test(text)) {
      return { error: `${label} must be a four-digit year from 1000 to 9999.` };
    }
    const year = Number(text);
    if (year < YEAR_MIN || year > YEAR_MAX) {
      return { error: `${label} must be a four-digit year from 1000 to 9999.` };
    }
    return { value: year };
  }
  if (!DECIMAL_PATTERN.test(text)) {
    return { error: `${label} must be a non-negative number.` };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${label} must be a non-negative number.` };
  }
  return { value };
}

const NUMERIC_FIELDS: readonly NumericFilterField[] = [
  "yearFrom",
  "yearTo",
  "ifMin",
  "jciMin",
];

/**
 * Convert a pending draft into applicable filters.
 *
 * Returns `filters` only when every field is valid (including a coherent
 * year interval); otherwise returns per-field `errors` and no filters, so
 * an invalid draft can never be applied partially. The returned snapshot
 * is fresh: its `requiredArtifacts` is a new array and it never carries
 * `ifMax`/`jciMax`.
 */
export function validateLibraryFilterDraft(
  draft: LibraryFilterDraft,
  badInput: LibraryFilterBadInput = {},
): LibraryFilterDraftValidation {
  const errors: Partial<Record<NumericFilterField, string>> = {};
  const parsed: Partial<Record<NumericFilterField, number>> = {};
  for (const field of NUMERIC_FIELDS) {
    const result = parseNumericField(field, draft[field], badInput[field] === true);
    if (result.error !== undefined) {
      errors[field] = result.error;
    } else if (result.value !== undefined) {
      parsed[field] = result.value;
    }
  }
  const yearFrom = parsed.yearFrom;
  const yearTo = parsed.yearTo;
  if (
    errors.yearFrom === undefined &&
    errors.yearTo === undefined &&
    yearFrom !== undefined &&
    yearTo !== undefined &&
    yearFrom > yearTo
  ) {
    errors.yearFrom = "Year from must not be after year to.";
    errors.yearTo = "Year to must not be before year from.";
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  const filters: LibraryFilters = { requiredArtifacts: [] };
  if (yearFrom !== undefined) {
    filters.yearFrom = yearFrom;
  }
  if (yearTo !== undefined) {
    filters.yearTo = yearTo;
  }
  if (parsed.ifMin !== undefined) {
    filters.ifMin = parsed.ifMin;
  }
  if (parsed.jciMin !== undefined) {
    filters.jciMin = parsed.jciMin;
  }
  if (draft.journal !== undefined && draft.journal.trim().length > 0) {
    filters.journal = draft.journal.trim();
  }
  if (draft.cas !== undefined && draft.cas.trim().length > 0) {
    filters.cas = draft.cas.trim();
  }
  if (draft.jcr !== undefined && draft.jcr.trim().length > 0) {
    filters.jcr = draft.jcr.trim();
  }
  if (draft.readingStatus !== undefined) {
    filters.readingStatus = draft.readingStatus;
  }
  filters.requiredArtifacts = uniqueArtifactParts(draft.requiredArtifacts);
  return { filters, errors };
}

/**
 * Unique artifact parts, first-seen order. The caller's array is never
 * mutated: a fresh array is always returned, so a legacy duplicated list
 * (`['pdf','pdf',…]`) counts and summarizes one condition per part.
 */
function uniqueArtifactParts(parts: readonly ArtifactPart[]): ArtifactPart[] {
  const seen = new Set<ArtifactPart>();
  const unique: ArtifactPart[] = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      unique.push(part);
    }
  }
  return unique;
}

/** Whether an applied filter object holds no condition at all. */
function isEmptyFilters(filters: LibraryFilters): boolean {
  return (
    filters.yearFrom === undefined &&
    filters.yearTo === undefined &&
    (filters.journal === undefined || filters.journal.trim().length === 0) &&
    (filters.cas === undefined || filters.cas.trim().length === 0) &&
    (filters.jcr === undefined || filters.jcr.trim().length === 0) &&
    filters.ifMin === undefined &&
    filters.jciMin === undefined &&
    filters.readingStatus === undefined &&
    filters.requiredArtifacts.length === 0
  );
}

/**
 * Number of active filter **groups** (not fields, not matching papers):
 * a year range counts once even with both ends set, each minimum metric
 * counts once, and every other active condition or required artifact
 * counts once (a duplicated requirement is still one condition). Legacy
 * `ifMax`/`jciMax` are not counted as groups because the final UI has no
 * upper bounds.
 */
export function countActiveLibraryFilterGroups(filters: LibraryFilters): number {
  let count = 0;
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    count += 1;
  }
  if (filters.ifMin !== undefined) {
    count += 1;
  }
  if (filters.jciMin !== undefined) {
    count += 1;
  }
  if (filters.journal !== undefined && filters.journal.trim().length > 0) {
    count += 1;
  }
  if (filters.cas !== undefined && filters.cas.trim().length > 0) {
    count += 1;
  }
  if (filters.jcr !== undefined && filters.jcr.trim().length > 0) {
    count += 1;
  }
  if (filters.readingStatus !== undefined) {
    count += 1;
  }
  count += uniqueArtifactParts(filters.requiredArtifacts).length;
  return count;
}

const ARTIFACT_LABELS: Record<ArtifactPart, string> = {
  pdf: "PDF",
  minerU: "MinerU",
  figure: "Figure",
};

const READING_LABELS: Record<string, string> = {
  unread: "Unread",
  reading: "Reading",
  read: "Read",
};

/** Readable applied-filter summary lines (one per active group). */
export function describeLibraryFilters(filters: LibraryFilters): string[] {
  if (isEmptyFilters(filters)) {
    return [];
  }
  const lines: string[] = [];
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    if (filters.yearFrom !== undefined && filters.yearTo !== undefined) {
      lines.push(`Year ${filters.yearFrom}–${filters.yearTo}`);
    } else if (filters.yearFrom !== undefined) {
      lines.push(`Year from ${filters.yearFrom}`);
    } else {
      lines.push(`Year to ${filters.yearTo}`);
    }
  }
  if (filters.ifMin !== undefined) {
    lines.push(`IF ≥ ${filters.ifMin}`);
  }
  if (filters.jciMin !== undefined) {
    lines.push(`JCI ≥ ${filters.jciMin}`);
  }
  if (filters.journal !== undefined && filters.journal.trim().length > 0) {
    lines.push(`Journal: ${filters.journal.trim()}`);
  }
  if (filters.cas !== undefined && filters.cas.trim().length > 0) {
    lines.push(`CAS: ${filters.cas.trim()}`);
  }
  if (filters.jcr !== undefined && filters.jcr.trim().length > 0) {
    lines.push(`JCR: ${filters.jcr.trim()}`);
  }
  if (filters.readingStatus !== undefined) {
    lines.push(`Reading: ${READING_LABELS[filters.readingStatus] ?? filters.readingStatus}`);
  }
  for (const part of uniqueArtifactParts(filters.requiredArtifacts)) {
    lines.push(`Has ${ARTIFACT_LABELS[part] ?? part}`);
  }
  return lines;
}

/**
 * Journal names offered by the panel: every distinct journal in the whole
 * library (never just the currently filtered rows), trimmed, deduplicated
 * case-insensitively and ordered deterministically by first appearance.
 */
export function collectJournalOptions(
  records: readonly { journal?: string }[],
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const record of records) {
    const raw = record.journal;
    if (raw === undefined) {
      continue;
    }
    const name = raw.trim();
    if (name.length === 0) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push(name);
  }
  return options;
}
