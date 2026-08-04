/**
 * Versioned JSON protocol shared with the paper-notes core CLI.
 *
 * Mirrors `paper_notes/protocol.py` (core, protocol_version = 1): every
 * plugin-facing CLI operation invoked with `--json` emits exactly one
 * `Envelope` on stdout; human diagnostics go to stderr.
 */

export const PROTOCOL_VERSION = 1;

export type ProtocolStatus =
  | "success"
  | "needs_confirmation"
  | "conflict"
  | "error";

export interface ProtocolIssue {
  code: string;
  message: string;
  path?: string | null;
  field?: string | null;
}

export interface ProtocolEnvelope {
  protocol_version: number;
  status: ProtocolStatus;
  data: Record<string, unknown>;
  warnings: ProtocolIssue[];
  errors: ProtocolIssue[];
}

export function isProtocolIssue(value: unknown): value is ProtocolIssue {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const issue = value as Record<string, unknown>;
  return typeof issue.code === "string" && typeof issue.message === "string";
}

/** Shape check only; the protocol-version match is enforced separately. */
export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.protocol_version !== "number") {
    return false;
  }
  const status = envelope.status;
  if (
    status !== "success" &&
    status !== "needs_confirmation" &&
    status !== "conflict" &&
    status !== "error"
  ) {
    return false;
  }
  if (
    typeof envelope.data !== "object" ||
    envelope.data === null ||
    Array.isArray(envelope.data)
  ) {
    return false;
  }
  if (
    !Array.isArray(envelope.warnings) ||
    !envelope.warnings.every(isProtocolIssue)
  ) {
    return false;
  }
  if (!Array.isArray(envelope.errors) || !envelope.errors.every(isProtocolIssue)) {
    return false;
  }
  return true;
}
