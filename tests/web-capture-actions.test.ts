import { describe, expect, it, vi } from "vitest";

import { WebCaptureActions, type TempJsonIo, type PendingWebReview } from "../src/services/web-capture-actions";
import type { CliRunResult } from "../src/services/cli-client";
import type { ProtocolEnvelope } from "../src/types/protocol";
import type { WebCaptureRequest } from "../browser-connector/src/protocol";

function validRequest(): WebCaptureRequest {
  return {
    schema_version: 1,
    capture_id: "7b0c7b5d-1d2e-4a6f-9f2e-8e9c0d1a2b3c",
    page_url: "https://example.org/articles/10.1000/abc",
    records: [
      {
        source: "highwire",
        values: {
          item_type: "article-journal",
          title: "A test paper",
          authors: [{ family: "Doe", given: "Jane" }],
          doi: "10.1000/abc",
          year: 2024,
        },
      },
    ],
  };
}

function envelope(data: Record<string, unknown>, status: ProtocolEnvelope["status"] = "success"): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status,
    data,
    warnings: [],
    errors: status === "error" ? [{ code: "bad", message: "bad thing" }] : [],
  };
}

function makeActions(overrides: {
  run?: ReturnType<typeof vi.fn>;
  tempIo?: TempJsonIo;
  reviewStore?: Map<string, PendingWebReview>;
  idGenerator?: () => string;
} = {}) {
  const run =
    overrides.run ??
    (vi.fn(async () => ({ envelope: envelope({}), exitCode: 0, stderr: "" })) as ReturnType<typeof vi.fn>);
  const tempIo = overrides.tempIo ?? {
    write: vi.fn(async (payload: unknown) => {
      return `/tmp/${JSON.stringify(payload).length}`;
    }),
    remove: vi.fn(async () => undefined),
  };
  const reviewStore = overrides.reviewStore ?? new Map<string, PendingWebReview>();
  const actions = new WebCaptureActions({
    client: { run: run as unknown as (args: string[]) => Promise<CliRunResult> },
    vaultRoot: "/vault",
    tempIo,
    reviewStore,
    idGenerator: overrides.idGenerator ?? (() => "review-1"),
  });
  return { actions, run, tempIo, reviewStore };
}

describe("WebCaptureActions submitCapture", () => {
  it("maps created to the closed result union", async () => {
    const { actions, run, tempIo } = makeActions({
      run: vi.fn(async () => ({
        envelope: envelope({
          action: "created",
          citation_key: "doe2024",
          path: "05 Literature/doe2024/doe2024.md",
        }),
        exitCode: 0,
        stderr: "",
      })),
    });
    const result = await actions.submitCapture(validRequest());
    expect(result).toEqual({
      status: "created",
      citationKey: "doe2024",
      title: "A test paper",
      path: "05 Literature/doe2024/doe2024.md",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("--web-capture");
    expect(tempIo.remove).toHaveBeenCalled();
  });

  it("maps duplicate_exists to existing", async () => {
    const { actions } = makeActions({
      run: vi.fn(async () => ({
        envelope: envelope({ action: "duplicate_exists", citation_key: "doe2024", path: "x" }),
        exitCode: 0,
        stderr: "",
      })),
    });
    const result = await actions.submitCapture(validRequest());
    expect(result.status).toBe("existing");
    if (result.status === "existing") {
      expect(result.action).toBe("open");
    }
  });

  it("stores needs_review plans in memory only", async () => {
    const reviewStore = new Map<string, PendingWebReview>();
    const { actions, run } = makeActions({
      run: vi.fn(async () => ({
        envelope: envelope(
          {
            confirmation_token: "token-123",
            plan: { action: "create_with_confirmation", message: "needs review" },
          },
          "needs_confirmation",
        ),
        exitCode: 0,
        stderr: "",
      })),
      reviewStore,
      idGenerator: () => "review-abc",
    });
    const result = await actions.submitCapture(validRequest());
    expect(result).toEqual({
      status: "needs_review",
      reviewId: "review-abc",
      reason: "needs review",
    });
    expect(reviewStore.has("review-abc")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("maps error envelopes to rejected without raw paths", async () => {
    const { actions } = makeActions({
      run: vi.fn(async () => ({
        envelope: envelope({}, "error"),
        exitCode: 2,
        stderr: "/Users/secret",
      })),
    });
    const result = await actions.submitCapture(validRequest());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("bad");
      expect(result.reason).not.toContain("/Users/secret");
    }
  });
});

describe("WebCaptureActions confirmReview", () => {
  it("confirms a stored review and cleans temp files", async () => {
    const reviewStore = new Map<string, PendingWebReview>([
      [
        "review-1",
        {
          request: validRequest(),
          plan: { action: "create_with_confirmation" },
          token: "token-123",
        },
      ],
    ]);
    const run = vi.fn<(args: string[]) => Promise<CliRunResult>>(async () => ({
      envelope: envelope({
        action: "created",
        citation_key: "doe2024",
        path: "05 Literature/doe2024/doe2024.md",
      }),
      exitCode: 0,
      stderr: "",
    }));
    const tempIo = {
      write: vi.fn(async () => "/tmp/payload"),
      remove: vi.fn(async () => undefined),
    };
    const actions = new WebCaptureActions({
      client: { run: run as unknown as (args: string[]) => Promise<CliRunResult> },
      vaultRoot: "/vault",
      tempIo,
      reviewStore,
      idGenerator: () => "review-2",
    });
    const result = await actions.confirmReview("review-1", {
      title: "A test paper",
      authors: [{ family: "Doe", given: "Jane" }],
      year: 2024,
    });
    expect(result.status).toBe("created");
    expect(run.mock.calls[0][0]).toEqual([
      "item",
      "create",
      "--vault",
      "/vault",
      "--web-capture",
      "/tmp/payload",
      "--confirmed",
      "/tmp/payload",
      "--confirm-token",
      "token-123",
    ]);
    expect(tempIo.remove).toHaveBeenCalledTimes(2);
    expect(reviewStore.has("review-1")).toBe(false);
  });

  it("rejects expired reviews without calling the CLI", async () => {
    const run = vi.fn();
    const { actions } = makeActions({ run, reviewStore: new Map() });
    const result = await actions.confirmReview("missing", {});
    expect(result.status).toBe("rejected");
    expect(run).not.toHaveBeenCalled();
  });
});
