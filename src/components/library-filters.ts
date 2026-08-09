/**
 * Literature Library filters (Task 24).
 *
 * Pure filter model: `LibraryFilters` state + `applyLibraryFilters` with AND
 * semantics across year range, journal, CAS/JCR, IF/JCI ranges, reading
 * status and required artifact availability. Metrics-based filters operate
 * on the injected volatile metrics only — never on paper metadata.
 */

import type { LibraryItem, ReadingStatus } from "./library-table";

export type ArtifactPart = "pdf" | "minerU" | "figure";

export interface LibraryFilters {
  /** Inclusive year bounds. */
  yearFrom?: number;
  yearTo?: number;
  /** Case-insensitive exact journal match. */
  journal?: string;
  /** Case-insensitive exact CAS partition match (volatile metrics). */
  cas?: string;
  /** Case-insensitive exact JCR quartile match (volatile metrics). */
  jcr?: string;
  /** Inclusive IF range (volatile metrics). */
  ifMin?: number;
  ifMax?: number;
  /** Inclusive JCI range (volatile metrics). */
  jciMin?: number;
  jciMax?: number;
  readingStatus?: ReadingStatus;
  /** Every listed artifact must be present. */
  requiredArtifacts: ArtifactPart[];
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
  requiredArtifacts: [],
};

function equalsIgnoreCase(value: string | undefined, wanted: string): boolean {
  return value !== undefined && value.trim().toLowerCase() === wanted.trim().toLowerCase();
}

function inRange(
  value: number | undefined,
  min: number | undefined,
  max: number | undefined,
): boolean {
  if (value === undefined || !Number.isFinite(value)) {
    return false;
  }
  if (min !== undefined && value < min) {
    return false;
  }
  if (max !== undefined && value > max) {
    return false;
  }
  return true;
}

/**
 * Apply all set filters with AND semantics. Items missing the filtered
 * metadata (e.g. invalid rows without a year) are excluded, never passed
 * through accidentally.
 */
export function applyLibraryFilters(
  items: LibraryItem[],
  filters: LibraryFilters,
): LibraryItem[] {
  const {
    yearFrom,
    yearTo,
    journal,
    cas,
    jcr,
    ifMin,
    ifMax,
    jciMin,
    jciMax,
    readingStatus,
    requiredArtifacts,
  } = filters;
  return items.filter((item) => {
    if (yearFrom !== undefined || yearTo !== undefined) {
      if (!inRange(item.year, yearFrom, yearTo)) {
        return false;
      }
    }
    if (journal !== undefined && !equalsIgnoreCase(item.journal, journal)) {
      return false;
    }
    if (cas !== undefined && !equalsIgnoreCase(item.metrics?.cas, cas)) {
      return false;
    }
    if (jcr !== undefined && !equalsIgnoreCase(item.metrics?.jcr, jcr)) {
      return false;
    }
    if (ifMin !== undefined || ifMax !== undefined) {
      if (!inRange(item.metrics?.if, ifMin, ifMax)) {
        return false;
      }
    }
    if (jciMin !== undefined || jciMax !== undefined) {
      if (!inRange(item.metrics?.jci, jciMin, jciMax)) {
        return false;
      }
    }
    if (readingStatus !== undefined && item.readingStatus !== readingStatus) {
      return false;
    }
    return requiredArtifacts.every((part) => item.artifacts[part]);
  });
}


/**
 * Advanced (collapsible) filter fields — year/journal/metrics ranges.
 * Primary bar keeps Reading + artifact checkboxes only (Batch 1 layout).
 */
export function countActiveAdvancedFilters(filters: LibraryFilters): number {
  let count = 0;
  if (filters.yearFrom !== undefined) {
    count += 1;
  }
  if (filters.yearTo !== undefined) {
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
  if (filters.ifMin !== undefined) {
    count += 1;
  }
  if (filters.ifMax !== undefined) {
    count += 1;
  }
  if (filters.jciMin !== undefined) {
    count += 1;
  }
  if (filters.jciMax !== undefined) {
    count += 1;
  }
  return count;
}

/**
 * Whether the Advanced block should open automatically: any advanced
 * condition is set. Manual collapse is still allowed; the badge uses the
 * same count so a collapsed-but-active state stays visible.
 */
export function hasActiveAdvancedFilters(filters: LibraryFilters): boolean {
  return countActiveAdvancedFilters(filters) > 0;
}
