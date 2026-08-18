/**
 * Pure decision model for the Item Context Menu's Fetch PDF entry.
 *
 * Mirrors `mineru-menu-state.ts`: the item stays visible but disabled with
 * an explanatory reason. Fetch PDF needs a deterministic identifier the
 * paper-fetch CLI accepts (DOI / PMID / PMCID), no existing Primary PDF,
 * both CLIs available, and valid row metadata.
 */

export interface FetchMenuFlags {
  /** Metadata-invalid row: all mutations disabled. */
  invalid: boolean;
  /** paper-notes CLI unavailable / protocol mismatch: read-only mode. */
  readOnly: boolean;
  /** paper-fetch CLI present and probeable. */
  fetchAvailable: boolean;
  /** Primary PDF present at `<key>/<key>.pdf`. */
  hasPdf: boolean;
  /** Record carries DOI / PMID / PMCID (paper-fetch compatible). */
  hasIdentifier: boolean;
}

export interface FetchMenuItemState {
  enabled: boolean;
  reason?: string;
}

const REASONS = {
  invalid: "invalid metadata",
  readOnly: "CLI unavailable",
  fetchUnavailable: "paper-fetch CLI unavailable",
  hasPdf: "primary PDF present",
  noIdentifier: "no DOI/PMID/PMCID",
} as const;

/** Decide the Fetch PDF menu item's enabled state and disable reason. */
export function fetchMenuItemState(flags: FetchMenuFlags): FetchMenuItemState {
  if (flags.invalid) {
    return { enabled: false, reason: REASONS.invalid };
  }
  if (flags.readOnly) {
    return { enabled: false, reason: REASONS.readOnly };
  }
  if (!flags.fetchAvailable) {
    return { enabled: false, reason: REASONS.fetchUnavailable };
  }
  if (flags.hasPdf) {
    return { enabled: false, reason: REASONS.hasPdf };
  }
  if (!flags.hasIdentifier) {
    return { enabled: false, reason: REASONS.noIdentifier };
  }
  return { enabled: true };
}