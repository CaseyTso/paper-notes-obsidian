/**
 * Fetch PDF Notice plan tests: each structured outcome maps to the correct
 * message/action buttons, and external URLs are only ever http(s).
 */

import { describe, expect, it } from "vitest";
import { fetchNoticePlan, type FetchOutcome } from "../src/services/fetch-model";

describe("fetchNoticePlan", () => {
  it("attached has no actions", () => {
    const plan = fetchNoticePlan({ status: "attached", source: "open_access" });
    expect(plan.message).toContain("open_access");
    expect(plan.actions).toEqual([]);
  });

  it("authentication_required opens the ableSci login page and retry", () => {
    const plan = fetchNoticePlan({
      status: "failed",
      kind: "authentication_required",
      detail: "session expired",
    });
    expect(plan.actions.some((a) => a.kind === "open_login")).toBe(true);
    expect(plan.actions.find((a) => a.kind === "open_login")?.url).toBe(
      "https://www.ablesci.com",
    );
    expect(plan.actions.some((a) => a.kind === "retry")).toBe(true);
    expect(plan.actions.some((a) => a.kind === "open_settings")).toBe(true);
  });

  it("challenge_required includes an open_url when the CLI gave an http(s) URL", () => {
    const plan = fetchNoticePlan({
      status: "failed",
      kind: "challenge_required",
      detail: "open https://sci-hub.jp/verify now",
    });
    const openUrl = plan.actions.find((a) => a.kind === "open_url");
    expect(openUrl?.url).toBe("https://sci-hub.jp/verify");
  });

  it("challenge_required without a URL does not fabricate one", () => {
    const plan = fetchNoticePlan({
      status: "failed",
      kind: "challenge_required",
      detail: "no url in detail",
    });
    expect(plan.actions.some((a) => a.kind === "open_url")).toBe(false);
  });

  it("pending/poll_timeout lead with 'submitted, processing (not a failure)' and stay longer", () => {
    for (const kind of ["pending", "poll_timeout"] as const) {
      const plan = fetchNoticePlan({
        status: "failed",
        kind,
        detail: "no PDF within 1 minute — ableSci request pending",
      });
      expect(plan.message).toContain("请求已提交，正在处理中（非失败）");
      expect(plan.message).toContain("无需重新提交");
      expect(plan.actions.some((a) => a.kind === "retry")).toBe(true);
      expect(plan.durationMs).toBe(30_000);
    }
  });

  it("pending shows the request id when the CLI detail carries one", () => {
    const plan = fetchNoticePlan({
      status: "failed",
      kind: "pending",
      detail: "https://www.ablesci.com/assist/detail?id=Ab12_3x",
    });
    expect(plan.message).toContain("请求号：Ab12_3x");
  });

  it("all_sources_failed points to the skill fallback", () => {
    const plan = fetchNoticePlan({
      status: "failed",
      kind: "all_sources_failed",
      detail: "everything failed",
    });
    expect(plan.message).toContain("fallback");
  });

  it("identity_mismatch offers settings but no retry", () => {
    const plan = fetchNoticePlan({
      status: "identity_mismatch",
      reason: "DOI mismatch",
    });
    expect(plan.actions.some((a) => a.kind === "open_settings")).toBe(true);
    expect(plan.actions.some((a) => a.kind === "retry")).toBe(false);
  });

  it("transport failures offer retry and settings", () => {
    const plan = fetchNoticePlan({
      status: "transport",
      code: "timeout",
      message: "paper-fetch run exceeded 300000ms",
    });
    expect(plan.actions.filter((a) => a.kind === "retry").length).toBe(1);
    expect(plan.actions.some((a) => a.kind === "open_settings")).toBe(true);
  });

  it("attach_failed explains the download already happened", () => {
    const plan = fetchNoticePlan({
      status: "attach_failed",
      message: "item attach-pdf failed",
    });
    expect(plan.message).toContain("已下载但落库失败");
    expect(plan.actions).toEqual([]);
  });
});

// Compile-time/guard check for exhaustiveness: a FetchOutcome union value
// must always produce a plan.
const outcomes: FetchOutcome[] = [
  { status: "attached", source: "s" },
  { status: "failed", kind: "unknown", detail: "" },
  { status: "identity_mismatch", reason: "" },
  { status: "transport", code: "timeout", message: "" },
  { status: "attach_failed", message: "" },
  { status: "attach_needs_confirmation" },
];
for (const outcome of outcomes) {
  expect(fetchNoticePlan(outcome)).toBeDefined();
}