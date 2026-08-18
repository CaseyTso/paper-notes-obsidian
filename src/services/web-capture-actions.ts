/**
 * Web Capture → CLI adapter (Task 7).
 *
 * This service is the plugin-side bridge between the Capture Bridge and
 * the paper-notes core CLI. It:
 * - writes capture/confirmed JSON to private temp files and always cleans
 *   them,
 * - calls the CLI with argv arrays only (never shell strings),
 * - maps protocol envelopes into the closed Browser Capture result union,
 * - keeps `needs_review` plans only in memory by opaque review ID,
 * - never falls back to direct vault writes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CliClient, CliRunResult } from "./cli-client";
import type { ProtocolEnvelope } from "../types/protocol";
import type {
  BrowserCaptureResult,
  WebCaptureRequest,
} from "../../browser-connector/src/protocol";

export interface TempJsonIo {
  write(payload: unknown): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface PendingWebReview {
  request: WebCaptureRequest;
  plan: Record<string, unknown>;
  token: string;
}

export interface WebCaptureActionsConfig {
  client: Pick<CliClient, "run">;
  vaultRoot: string;
  tempIo?: TempJsonIo;
  reviewStore?: Map<string, PendingWebReview>;
  idGenerator?: () => string;
  /** Called after a successful create/existing outcome (refresh + focus). */
  onChanged?: (result: BrowserCaptureResult) => void;
}

function defaultTempIo(): TempJsonIo {
  return {
    async write(payload: unknown): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "paper-notes-web-capture-"));
      const path = join(dir, "payload.json");
      writeFileSync(path, JSON.stringify(payload));
      return path;
    },
    async remove(path: string): Promise<void> {
      rmSync(dirname(path), { recursive: true, force: true });
    },
  };
}

function titleOf(request: WebCaptureRequest): string {
  for (const record of request.records) {
    const title = record.values.title;
    if (typeof title === "string" && title.trim().length > 0) {
      return title;
    }
  }
  return "Paper";
}

function safeMessage(envelope: ProtocolEnvelope, fallback: string): string {
  const issue = envelope.errors[0];
  return issue?.message ?? fallback;
}

function safeCode(envelope: ProtocolEnvelope, fallback: string): string {
  const issue = envelope.errors[0];
  return issue?.code ?? fallback;
}

function mapSuccess(envelope: ProtocolEnvelope, request: WebCaptureRequest): BrowserCaptureResult {
  const action = envelope.data.action;
  const citationKey =
    typeof envelope.data.citation_key === "string" ? envelope.data.citation_key : "";
  const path = typeof envelope.data.path === "string" ? envelope.data.path : "";
  const title = titleOf(request);
  if (action === "created") {
    return { status: "created", citationKey, title, path };
  }
  if (action === "duplicate_exists" || action === "updated_metadata") {
    return { status: "existing", citationKey, title, action: "open" };
  }
  return {
    status: "rejected",
    code: "unexpected_success",
    reason: "CLI returned an unexpected success action",
  };
}

export class WebCaptureActions {
  private readonly tempIo: TempJsonIo;
  private readonly reviewStore: Map<string, PendingWebReview>;
  private readonly idGenerator: () => string;
  private readonly onChanged: ((result: BrowserCaptureResult) => void) | undefined;

  constructor(private readonly config: WebCaptureActionsConfig) {
    this.tempIo = config.tempIo ?? defaultTempIo();
    this.reviewStore = config.reviewStore ?? new Map();
    this.idGenerator = config.idGenerator ?? randomUUID;
    this.onChanged = config.onChanged;
  }

  /** Read a pending review by opaque id (used by the protocol handler). */
  getReview(reviewId: string): PendingWebReview | undefined {
    return this.reviewStore.get(reviewId);
  }

  private async run(args: string[]): Promise<CliRunResult> {
    return this.config.client.run(args);
  }

  private notifyChanged(result: BrowserCaptureResult): BrowserCaptureResult {
    if (result.status === "created" || result.status === "existing") {
      this.onChanged?.(result);
    }
    return result;
  }

  private async withTempFiles(
    payloads: Array<{ path: string; data: unknown }>,
    fn: (paths: string[]) => Promise<BrowserCaptureResult>,
  ): Promise<BrowserCaptureResult> {
    const paths: string[] = [];
    try {
      for (const item of payloads) {
        paths.push(await this.tempIo.write(item.data));
      }
      return await fn(paths);
    } finally {
      for (const path of paths) {
        await this.tempIo.remove(path);
      }
    }
  }

  /** Submit a Web Capture from the bridge. */
  async submitCapture(request: WebCaptureRequest): Promise<BrowserCaptureResult> {
    return this.withTempFiles([{ path: "capture", data: request }], async ([capturePath]) => {
      const { envelope } = await this.run([
        "item",
        "create",
        "--vault",
        this.config.vaultRoot,
        "--web-capture",
        capturePath,
      ]);

      if (envelope.status === "success") {
        return this.notifyChanged(mapSuccess(envelope, request));
      }
      if (envelope.status === "needs_confirmation") {
        const token = envelope.data.confirmation_token;
        const plan = envelope.data.plan;
        if (typeof token !== "string" || token.length === 0 || typeof plan !== "object" || plan === null) {
          return {
            status: "rejected",
            code: "missing_review_plan",
            reason: "CLI returned needs_confirmation without a review plan",
          };
        }
        const reviewId = this.idGenerator();
        this.reviewStore.set(reviewId, {
          request,
          plan: plan as Record<string, unknown>,
          token,
        });
        const reason =
          typeof (plan as Record<string, unknown>).message === "string"
            ? String((plan as Record<string, unknown>).message)
            : "Web capture needs review";
        return { status: "needs_review", reviewId, reason };
      }
      return {
        status: "rejected",
        code: safeCode(envelope, envelope.status),
        reason: safeMessage(envelope, "Web capture was rejected"),
      };
    });
  }

  /** Confirm a previously returned Import Review. One-shot. */
  async confirmReview(
    reviewId: string,
    confirmed: Record<string, unknown>,
  ): Promise<BrowserCaptureResult> {
    const review = this.reviewStore.get(reviewId);
    if (review === undefined) {
      return {
        status: "rejected",
        code: "review_expired",
        reason: "This review is no longer available; capture the page again.",
      };
    }
    this.reviewStore.delete(reviewId);

    return this.withTempFiles(
      [
        { path: "capture", data: review.request },
        { path: "confirmed", data: confirmed },
      ],
      async ([capturePath, confirmedPath]) => {
        const { envelope } = await this.run([
          "item",
          "create",
          "--vault",
          this.config.vaultRoot,
          "--web-capture",
          capturePath,
          "--confirmed",
          confirmedPath,
          "--confirm-token",
          review.token,
        ]);

        if (envelope.status === "success") {
          return this.notifyChanged(mapSuccess(envelope, review.request));
        }
        if (envelope.status === "needs_confirmation") {
          const token = envelope.data.confirmation_token;
          const plan = envelope.data.plan;
          if (typeof token !== "string" || token.length === 0 || typeof plan !== "object" || plan === null) {
            return {
              status: "rejected",
              code: "missing_review_plan",
              reason: "CLI returned needs_confirmation without a review plan",
            };
          }
          const newReviewId = this.idGenerator();
          this.reviewStore.set(newReviewId, {
            request: review.request,
            plan: plan as Record<string, unknown>,
            token,
          });
          const reason =
            typeof (plan as Record<string, unknown>).message === "string"
              ? String((plan as Record<string, unknown>).message)
              : "Web capture still needs review";
          return { status: "needs_review", reviewId: newReviewId, reason };
        }
        return {
          status: "rejected",
          code: safeCode(envelope, envelope.status),
          reason: safeMessage(envelope, "Web capture confirmation failed"),
        };
      },
    );
  }
}
