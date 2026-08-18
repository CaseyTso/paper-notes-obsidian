/**
 * Pure decision/validation model for Fetch PDF.
 *
 * Keeps the fetch workflow's non-UI logic free of Obsidian/Node concerns so
 * it can be unit-tested without mocks: identifier precedence, identity
 * verification, failure status normalization, and Notice plan mapping.
 */

import type { PaperRecord } from "../types/paper";
import type {
  FetchAttemptJson,
  FetchFailureStatus,
  FetchIdentityJson,
  FetchResultJson,
} from "../types/fetch";

export type FetchIdentifierField = "doi" | "pmid" | "pmcid";

export interface FetchIdentifier {
  field: FetchIdentifierField;
  value: string;
}

/** Pick the strongest paper-fetch-compatible identifier from a record. */
export function selectFetchIdentifier(
  record: PaperRecord,
): FetchIdentifier | undefined {
  const ids = record.identifiers;
  const doi = typeof ids?.doi === "string" ? ids.doi.trim() : "";
  if (doi.length > 0) {
    return { field: "doi", value: doi };
  }
  const pmid = typeof ids?.pmid === "string" ? ids.pmid.trim() : "";
  if (pmid.length > 0) {
    return { field: "pmid", value: pmid };
  }
  const pmcid = typeof ids?.pmcid === "string" ? ids.pmcid.trim() : "";
  if (pmcid.length > 0) {
    return { field: "pmcid", value: pmcid };
  }
  return undefined;
}

/** Normalize a DOI for exact comparison (doi.org prefixes and case). */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

/** Levenshtein ratio in [0,1]; 1 = identical. */
export function titleSimilarity(left: string, right: string): number {
  const a = left.trim().toLowerCase().replace(/\s+/g, " ");
  const b = right.trim().toLowerCase().replace(/\s+/g, " ");
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j += 1) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  const distance = dp[m][n];
  return distance === 0 ? 1 : 1 - distance / Math.max(m, n);
}

export const TITLE_MATCH_THRESHOLD = 0.85;

export type IdentityVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Guard against attaching the wrong paper. DOI is authoritative when both
 * sides have one; otherwise compare titles when available. If neither DOI
 * nor a comparable identity surface exists, trust the CLI.
 */
export function verifyFetchedIdentity(
  record: PaperRecord,
  identity: FetchIdentityJson | undefined,
): IdentityVerificationResult {
  const recordDoi = record.identifiers?.doi;
  if (
    typeof recordDoi === "string" &&
    recordDoi.trim().length > 0 &&
    typeof identity?.doi === "string" &&
    identity.doi.trim().length > 0
  ) {
    if (normalizeDoi(identity.doi) !== normalizeDoi(recordDoi)) {
      return {
        ok: false,
        reason: `CLI 返回的 DOI（${identity.doi}）与条目不一致，已中止落库。`,
      };
    }
  }
  const identityTitle = identity?.title?.trim() ?? "";
  const recordTitle = record.title?.trim() ?? "";
  if (
    identityTitle.length > 0 &&
    recordTitle.length > 0 &&
    (typeof identity?.doi !== "string" || identity.doi.trim().length === 0)
  ) {
    if (titleSimilarity(identityTitle, recordTitle) < TITLE_MATCH_THRESHOLD) {
      return {
        ok: false,
        reason: "CLI 返回的标题与条目不一致，已中止落库。",
      };
    }
  }
  return { ok: true };
}

/** Structured outcome of a Fetch PDF run. */
export type FetchOutcome =
  | { status: "attached"; source: string }
  | { status: "failed"; kind: FetchFailureStatus; detail: string }
  | { status: "identity_mismatch"; reason: string }
  | { status: "transport"; code: string; message: string }
  | { status: "attach_failed"; message: string }
  | { status: "attach_needs_confirmation" };

const FAILURE_PRIORITY: readonly FetchFailureStatus[] = [
  "authentication_required",
  "challenge_required",
  "all_sources_failed",
  "pending",
  "poll_timeout",
  "ambiguous_identifier",
  "proxy_unavailable",
  "rate_limited",
  "timeout",
  "configuration_error",
  "network_error",
  "not_found",
  "no_pdf",
  "invalid_pdf",
  "suspicious_pdf",
  "external_command_missing",
  "zotero_write_failed",
];

/** Map the CLI's structured failure onto one actionable FetchFailureStatus. */
export function failureStatusOf(result: FetchResultJson): FetchFailureStatus {
  const statuses = new Set((result.attempts ?? []).map((attempt) => attempt.status));
  for (const status of FAILURE_PRIORITY) {
    if (statuses.has(status)) {
      return status;
    }
  }
  const error = result.error?.toLowerCase() ?? "";
  for (const status of FAILURE_PRIORITY) {
    if (error.includes(status.replace(/_/g, " "))) {
      return status;
    }
  }
  return "unknown";
}

/** Extract the first http(s) URL without trusting arbitrary schemes. */
export function extractFirstHttpUrl(text: string | undefined): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  // A URL ends at whitespace, quotes, brackets, or CJK text/punctuation.
  const match =
    /https?:\/\/[^\s"'<>)\]【】》\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/.exec(
      text,
    );
  const raw = match?.[0];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.replace(/[.,;:!?。！？)\]】》]+$/g, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Best-effort ableSci (科研通) request id. Only present when the CLI detail
 * includes it (e.g. the OpenCLI path emits an `/assist/detail?id=` URL); the
 * HTTP poll path's pending detail has no id.
 */
export function extractRequestId(detail: string | undefined): string | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }
  const url = /\/assist\/detail\?id=([A-Za-z0-9_]+)/i.exec(detail);
  if (url !== null) {
    return url[1];
  }
  const keyed = /\bid\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(detail);
  return keyed?.[1];
}

export type FetchNoticeActionKind =
  | "open_url"
  | "open_login"
  | "open_settings"
  | "retry";

export interface FetchNoticeAction {
  label: string;
  kind: FetchNoticeActionKind;
  url?: string;
}

export interface FetchNoticePlan {
  message: string;
  actions: FetchNoticeAction[];
  /** How long the Notice stays visible in ms (default in view). */
  durationMs?: number;
}

/** Derive the Notice text/buttons for a FetchOutcome. */
export function fetchNoticePlan(outcome: FetchOutcome): FetchNoticePlan {
  switch (outcome.status) {
    case "attached":
      return {
        message: `PDF fetched (来源: ${outcome.source}).`,
        actions: [],
      };
    case "failed":
      return failureNoticePlan(outcome.kind, outcome.detail);
    case "identity_mismatch":
      return {
        message: outcome.reason,
        actions: [{ label: "打开设置页", kind: "open_settings" }],
      };
    case "transport":
      return {
        message: `获取失败：${outcome.message}`,
        actions: [
          retryAction(),
          { label: "打开设置页", kind: "open_settings" },
        ],
      };
    case "attach_failed":
      return {
        message: `PDF 已下载但落库失败：${outcome.message}`,
        actions: [],
      };
    case "attach_needs_confirmation":
      return {
        message: "PDF 已下载但 CLI 要求确认；请改用本地 Attach PDF 处理。",
        actions: [],
      };
  }
}

function failureNoticePlan(
  kind: FetchFailureStatus,
  detail: string,
): FetchNoticePlan {
  switch (kind) {
    case "authentication_required":
      return {
        message: "科研通登录已过期：请在 Chrome 登录 ablesci.com 后重试。",
        actions: [
          { label: "打开科研通登录页", kind: "open_login", url: "https://www.ablesci.com" },
          settingsAction(),
          retryAction(),
        ],
      };
    case "challenge_required": {
      const url = extractFirstHttpUrl(detail);
      return {
        message: "Sci-Hub 需要完成浏览器验证。",
        actions: [
          ...(url === undefined
            ? []
            : [{ label: "在浏览器中完成验证", kind: "open_url" as const, url }]),
          settingsAction(),
          retryAction(),
        ],
      };
    }
    case "pending":
    case "poll_timeout": {
      const requestId = extractRequestId(detail);
      return {
        message:
          `科研通请求已提交，正在处理中（非失败）…` +
          (requestId === undefined ? "" : `（请求号：${requestId}）`) +
          `完成后点「重试」即可导入，无需重新提交。`,
        actions: [retryAction(), settingsAction()],
        durationMs: 30_000,
      };
    }
    case "all_sources_failed":
      return {
        message: "所有下载源均失败；请参照 paper-fetch skill 的 fallback 流程。",
        actions: [retryAction(), settingsAction()],
      };
    default:
      return {
        message: `获取失败（${kind}）${detail.length > 0 ? `：${detail}` : ""}`,
        actions: [retryAction(), settingsAction()],
      };
  }
}

function retryAction(): FetchNoticeAction {
  return { label: "重试", kind: "retry" };
}

function settingsAction(): FetchNoticeAction {
  return { label: "打开设置页", kind: "open_settings" };
}

/** Human-readable detail used when the CLI returns no attempts/error. */
export function failureDetailOf(result: FetchResultJson): string {
  if (typeof result.error === "string" && result.error.length > 0) {
    return result.error;
  }
  const details = (result.attempts ?? [])
    .map((attempt: FetchAttemptJson) =>
      attempt.detail.length > 0 ? `${attempt.source}: ${attempt.detail}` : attempt.source,
    );
  return details.join("; ");
}