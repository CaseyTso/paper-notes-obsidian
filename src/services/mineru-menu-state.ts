/**
 * Pure decision model for the Item Context Menu's MinerU entry (Task: MinerU).
 *
 * The row right-click and the Drawer ⋯ button share one menu; the MinerU
 * item stays visible but disabled with an explanatory reason when the row
 * is invalid, the CLI is unavailable, there is no Primary PDF, or no
 * MinerU Key is configured (in that priority order). Label switches to
 * "Re-convert with MinerU…" when a `minerUmd_<key>.md` already exists.
 */

export interface MineruMenuFlags {
  /** Metadata-invalid row: all mutations disabled. */
  invalid: boolean;
  /** CLI unavailable / protocol mismatch: read-only mode. */
  readOnly: boolean;
  /** Primary PDF present at `<key>/<key>.pdf`. */
  hasPdf: boolean;
  /** `config mineru status` reported a configured key. */
  keyConfigured: boolean;
}

export interface MineruMenuItemState {
  label: "Convert with MinerU…" | "Re-convert with MinerU…";
  enabled: boolean;
  reason?: string;
}

const REASONS = {
  invalid: "invalid metadata",
  readOnly: "CLI unavailable",
  noPdf: "no primary PDF",
  noKey: "MinerU key not configured",
} as const;

/** Decide the MinerU menu item's label, enabled state, and disable reason. */
export function mineruMenuItemState(
  hasExistingMinerU: boolean,
  flags: MineruMenuFlags,
): MineruMenuItemState {
  const label = hasExistingMinerU
    ? ("Re-convert with MinerU…" as const)
    : ("Convert with MinerU…" as const);
  if (flags.invalid) {
    return { label, enabled: false, reason: REASONS.invalid };
  }
  if (flags.readOnly) {
    return { label, enabled: false, reason: REASONS.readOnly };
  }
  if (!flags.hasPdf) {
    return { label, enabled: false, reason: REASONS.noPdf };
  }
  if (!flags.keyConfigured) {
    return { label, enabled: false, reason: REASONS.noKey };
  }
  return { label, enabled: true };
}
