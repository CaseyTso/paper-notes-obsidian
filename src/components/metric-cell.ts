/**
 * Metric badge cell (Task 26).
 *
 * Renders one volatile EasyScholar metric (CAS/JCR/IF/JCI) as a small
 * badge in the library table, with a stale state and a provenance
 * tooltip. Pure UI: the value comes from the metrics cache entry and is
 * never written back anywhere.
 */

import type { CachedMetricsEntry } from "../services/metrics-cache";
import { isExpired } from "../services/metrics-cache";

/** The four volatile metric columns rendered as badges. */
export type MetricKind = "cas" | "jcr" | "if" | "jci";

/** Ready-to-render badge state (pure; DOM-free for tests). */
export interface MetricBadgeState {
  kind: MetricKind;
  label: string;
  value: string;
  stale: boolean;
  tooltip: string;
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
  return { kind, label: METRIC_LABELS[kind], value, stale, tooltip };
}

/**
 * Render a metric badge into a table cell. Returns the badge element.
 * The value is display-only; no metadata is ever touched.
 */
export function renderMetricBadge(
  host: HTMLElement,
  state: MetricBadgeState,
): HTMLElement {
  const badge = host.createEl("span", {
    cls: `paper-notes-metric-badge paper-notes-metric-badge--${state.kind}`,
    text: state.value,
    attr: {
      "aria-label": `${state.label}: ${state.value}${state.stale ? " (stale)" : ""}`,
    },
  });
  if (state.stale) {
    badge.addClass("paper-notes-metric-badge-stale");
  }
  badge.title = state.tooltip;
  return badge;
}
