/**
 * Types for the paper-fetch CLI integration (Fetch PDF).
 *
 * These shapes mirror the JSON output of the sibling `paper_fetch` tool
 * (`paper-fetch fetch '<id>' --json` and `paper-fetch doctor --json`). The
 * plugin is a caller only: it never writes paper-fetch's config file and
 * never receives or stores ableSci credentials.
 */

/** Resolved identity returned by `paper-fetch fetch` (models.PaperIdentity). */
export interface FetchIdentityJson {
  original_input?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  title?: string;
  authors?: string[];
  journal?: string;
  year?: string;
  zotero_item_key?: string;
}

/** One source attempt recorded in the fetch result. */
export interface FetchAttemptJson {
  source: string;
  status: string;
  detail: string;
  elapsed_ms?: number;
}

/** Structured outcome of `paper-fetch fetch --json` (models.FetchResult). */
export interface FetchResultJson {
  success: boolean;
  source: string;
  pdf_path?: string | null;
  error?: string;
  identity?: FetchIdentityJson;
  attempts?: FetchAttemptJson[];
}

/**
 * Failure statuses surfaced by the paper-fetch CLI (models.Status minus
 * SUCCESS). Mapped onto notices; the human/agent-only fallbacks are kept
 * explicit so the plugin never silently retries or pretends a paper is
 * missing.
 */
export type FetchFailureStatus =
  | "authentication_required"
  | "challenge_required"
  | "pending"
  | "poll_timeout"
  | "all_sources_failed"
  | "ambiguous_identifier"
  | "not_found"
  | "no_pdf"
  | "invalid_pdf"
  | "suspicious_pdf"
  | "proxy_unavailable"
  | "rate_limited"
  | "timeout"
  | "configuration_error"
  | "network_error"
  | "external_command_missing"
  | "zotero_write_failed"
  | "unknown";

/** One row of the `paper-fetch doctor --json` report. */
export interface DoctorCheckJson {
  name: string;
  status: string;
  detail: string;
  action: string;
}

/** Read-only health report (`paper-fetch doctor --json`). */
export interface DoctorReportJson {
  overall: string;
  config_path?: string;
  checks: DoctorCheckJson[];
}

/**
 * AbleSci (科研通) session state surfaced in Plugin Settings, derived from
 * the `ablesci` row of `paper-fetch doctor`. The plugin never reads cookie
 * values and only ever renders the row's status/detail/action.
 */
export interface AbleSciStatusResult {
  /** ready = usable session; not_ready = needs browser login; unavailable = cannot check. */
  status: "ready" | "not_ready" | "unavailable";
  /** Machine status word from the doctor row (ok/missing/...). */
  rowStatus: string;
  /** Sanitized detail text from the doctor row. */
  detail: string;
  /** Action text from the doctor row. */
  action: string;
}
