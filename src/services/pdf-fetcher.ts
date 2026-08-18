/**
 * Fetch PDF orchestration (two-stage CLI reuse, ADR 0004).
 *
 * Stage 1: `paper-fetch fetch --json --no-zotero` downloads a PDF into a
 * plugin-owned temporary directory. Stage 2: the caller's `attach` callback
 * routes the file through the paper-notes CLI (`item attach-pdf`) so the
 * vault write stays on the single managed writer. The temporary directory
 * is always removed when the run settles.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchClient,
  FetchClientError,
} from "./fetch-client";
import {
  failureDetailOf,
  failureStatusOf,
  selectFetchIdentifier,
  verifyFetchedIdentity,
  type FetchOutcome,
} from "./fetch-model";
import type { PaperRecord } from "../types/paper";
import type { ActionOutcome } from "./item-actions";

export interface PdfFetcherConfig {
  client: FetchClient;
}

export interface FetchAndAttachOptions {
  record: PaperRecord;
  /**
   * Attach the downloaded PDF to the vault (paper-notes CLI). Resolves with
   * the final ActionOutcome; `source` is the paper-fetch source label for
   * caller success notices.
   */
  attach: (pdfPath: string, source: string) => Promise<ActionOutcome>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class PdfFetcher {
  constructor(private readonly config: PdfFetcherConfig) {}

  async fetchAndAttach(options: FetchAndAttachOptions): Promise<FetchOutcome> {
    const identifier = selectFetchIdentifier(options.record);
    if (identifier === undefined) {
      return {
        status: "failed",
        kind: "unknown",
        detail: "该条目没有 DOI/PMID/PMCID，无法获取。",
      };
    }
    const outputDir = mkdtempSync(join(tmpdir(), "paper-notes-fetch-"));
    try {
      let result;
      try {
        result = await this.config.client.fetchPdf(identifier.value, {
          outputDir,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof FetchClientError) {
          return {
            status: "transport",
            code: error.code,
            message: error.message,
          };
        }
        return {
          status: "transport",
          code: "cli_error",
          message: String(error),
        };
      }

      if (!result.success) {
        return {
          status: "failed",
          kind: failureStatusOf(result),
          detail: failureDetailOf(result),
        };
      }

      const verification = verifyFetchedIdentity(options.record, result.identity);
      if (!verification.ok) {
        return { status: "identity_mismatch", reason: verification.reason };
      }

      const pdfPath = typeof result.pdf_path === "string" ? result.pdf_path : "";
      if (pdfPath.length === 0) {
        return {
          status: "failed",
          kind: "no_pdf",
          detail: "CLI 未返回 PDF 路径。",
        };
      }

      let outcome: ActionOutcome;
      try {
        outcome = await options.attach(pdfPath, result.source);
      } catch (error) {
        return {
          status: "attach_failed",
          message: String(error),
        };
      }
      if (outcome.status === "success") {
        return { status: "attached", source: result.source };
      }
      if (outcome.status === "needs_confirmation") {
        return { status: "attach_needs_confirmation" };
      }
      return { status: "attach_failed", message: outcome.message };
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

export type { FetchOutcome };
