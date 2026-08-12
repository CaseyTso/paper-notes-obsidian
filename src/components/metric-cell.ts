/**
 * Metric badge cell (Task 26 / metrics-engine).
 *
 * Renders one volatile EasyScholar metric (CAS/JCR/IF/JCI) as a small
 * badge in the library table, with a stale state, provenance tooltip,
 * and stable tone classes for partition / IF-scale coloring (css-polish
 * owns the actual colors; this module only emits class names).
 *
 * Pure UI: the value comes from the metrics cache entry and is never
 * written back anywhere.
 */

import type { CachedMetricsEntry } from "../services/metrics-cache";
import { isExpired } from "../services/metrics-cache";

/** The four volatile metric columns rendered as badges. */
export type MetricKind = "cas" | "jcr" | "if" | "jci";

/**
 * Ready-to-render badge state (pure; DOM-free for tests).
 *
 * `toneClasses` are stable CSS class names consumed by css-polish:
 * - CAS: `paper-notes-metric-badge--cas-p1` … `--cas-p4` (1–4 区)
 * - JCR: `paper-notes-metric-badge--jcr-q1` … `--jcr-q4`
 * - IF:  `paper-notes-metric-badge--if-lt1` | `--if-1-3` | `--if-3-5` |
 *        `--if-5-10` | `--if-10-20` | `--if-ge20`
 * - JCI: `paper-notes-metric-badge--jci-lt1` | `--jci-1-3` | `--jci-3-5` |
 *        `--jci-ge5`
 * Unknown / unparseable values omit a tone class (kind class still applies).
 */
export interface MetricBadgeState {
  kind: MetricKind;
  label: string;
  value: string;
  stale: boolean;
  tooltip: string;
  /** Extra tone classes (partition / IF scale); never includes the kind class. */
  toneClasses: string[];
}

const METRIC_LABELS: Record<MetricKind, string> = {
  cas: "CAS",
  jcr: "JCR",
  if: "IF",
  jci: "JCI",
};

export function metricLabelOf(kind: MetricKind): string {
  return METRIC_LABELS[kind];
}

function metricValueOf(
  kind: MetricKind,
  entry: CachedMetricsEntry,
): string | undefined {
  switch (kind) {
    case "cas":
      return entry.metrics.cas;
    case "jcr":
      return entry.metrics.jcr;
    case "if":
      return entry.metrics.if !== undefined ? String(entry.metrics.if) : undefined;
    case "jci":
      return entry.metrics.jci !== undefined ? String(entry.metrics.jci) : undefined;
  }
}

/**
 * Map a CAS partition label onto a stable 1–4 zone tone class.
 * Accepts EasyScholar forms such as `中科院1区`, `综合性期刊1区`, `1区`.
 */
export function casPartitionToneClass(value: string): string | undefined {
  const match = value.match(/([1-4])\s*区/);
  if (match === null) {
    return undefined;
  }
  return `paper-notes-metric-badge--cas-p${match[1]}`;
}

/**
 * Map a JCR quartile label onto a stable Q1–Q4 tone class.
 * Accepts `Q1`…`Q4` (any case, optional surrounding text).
 */
export function jcrQuartileToneClass(value: string): string | undefined {
  const match = value.match(/\bQ\s*([1-4])\b/i);
  if (match === null) {
    return undefined;
  }
  return `paper-notes-metric-badge--jcr-q${match[1]}`;
}

/**
 * Map an Impact Factor number onto a stable IF-scale tone class.
 * Bands (half-open except the top): &lt;1, 1–3, 3–5, 5–10, 10–20, ≥20.
 */
export function ifScaleToneClass(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (value < 1) {
    return "paper-notes-metric-badge--if-lt1";
  }
  if (value < 3) {
    return "paper-notes-metric-badge--if-1-3";
  }
  if (value < 5) {
    return "paper-notes-metric-badge--if-3-5";
  }
  if (value < 10) {
    return "paper-notes-metric-badge--if-5-10";
  }
  if (value < 20) {
    return "paper-notes-metric-badge--if-10-20";
  }
  return "paper-notes-metric-badge--if-ge20";
}

/**
 * Map a JCI number onto a coarse tone class (readable scale, not quartile).
 */
export function jciScaleToneClass(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (value < 1) {
    return "paper-notes-metric-badge--jci-lt1";
  }
  if (value < 3) {
    return "paper-notes-metric-badge--jci-1-3";
  }
  if (value < 5) {
    return "paper-notes-metric-badge--jci-3-5";
  }
  return "paper-notes-metric-badge--jci-ge5";
}

/** Tone classes for one metric kind + raw value (pure; testable). */
export function metricToneClassesOf(
  kind: MetricKind,
  entry: CachedMetricsEntry,
): string[] {
  switch (kind) {
    case "cas": {
      const raw = entry.metrics.cas;
      if (raw === undefined) {
        return [];
      }
      const tone = casPartitionToneClass(raw);
      return tone === undefined ? [] : [tone];
    }
    case "jcr": {
      const raw = entry.metrics.jcr;
      if (raw === undefined) {
        return [];
      }
      const tone = jcrQuartileToneClass(raw);
      return tone === undefined ? [] : [tone];
    }
    case "if": {
      const raw = entry.metrics.if;
      if (raw === undefined) {
        return [];
      }
      const tone = ifScaleToneClass(raw);
      return tone === undefined ? [] : [tone];
    }
    case "jci": {
      const raw = entry.metrics.jci;
      if (raw === undefined) {
        return [];
      }
      const tone = jciScaleToneClass(raw);
      return tone === undefined ? [] : [tone];
    }
  }
}

/**
 * Build the badge state for one metric column from the cache entry.
 * Returns undefined when there is no entry or no value for that metric.
 * The stale flag reflects both failed refreshes and expired TTLs.
 */
export function metricBadgeStateOf(
  kind: MetricKind,
  entry: CachedMetricsEntry | undefined,
  now: number,
  ttlDays: number,
): MetricBadgeState | undefined {
  if (entry === undefined) {
    return undefined;
  }
  const value = metricValueOf(kind, entry);
  if (value === undefined) {
    return undefined;
  }
  const expired = isExpired(entry, now, ttlDays);
  const stale = entry.stale || expired;
  const cachedOn = new Date(entry.fetchedAtMs).toISOString();
  const tooltip = stale
    ? entry.stale
      ? `Stale — refresh failed (${entry.lastErrorCode ?? "error"}), cached ${cachedOn}`
      : `Stale — cached ${cachedOn}`
    : `Cached ${cachedOn}`;
  return {
    kind,
    label: METRIC_LABELS[kind],
    value,
    stale,
    tooltip,
    toneClasses: metricToneClassesOf(kind, entry),
  };
}

/**
 * Render a metric badge into a table cell. Returns the badge element.
 * The value is display-only; no metadata is ever touched.
 */
export function renderMetricBadge(
  host: HTMLElement,
  state: MetricBadgeState,
): HTMLElement {
  const classTokens = [
    "paper-notes-metric-badge",
    `paper-notes-metric-badge--${state.kind}`,
    ...state.toneClasses,
  ];
  if (state.stale) {
    classTokens.push("paper-notes-metric-badge-stale");
  }
  const badge = host.createEl("span", {
    cls: classTokens.join(" "),
    text: state.value,
    attr: {
      "aria-label": `${state.label}: ${state.value}${state.stale ? " (stale)" : ""}`,
    },
  });
  badge.title = state.tooltip;
  return badge;
}
