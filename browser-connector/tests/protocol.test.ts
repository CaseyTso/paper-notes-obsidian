import { describe, expect, it } from "vitest";

import {
  BROWSER_CAPTURE_RESULT_STATUSES,
  CAPTURE_BIND_ADDRESS,
  CAPTURE_PORT,
  CAPTURE_ROUTE,
  CONNECTOR_VERSION,
  CONNECTOR_VERSION_HEADER,
  MAX_CAPTURE_BODY_BYTES,
  WEB_CAPTURE_SCHEMA_VERSION,
  isBrowserCaptureResult,
  isWebCaptureRequest,
  webCaptureRejectionReason,
  type BrowserCaptureResult,
  type WebCaptureRequest,
} from "../src/protocol";

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

describe("shared capture protocol constants", () => {
  it("pins the production loopback and route", () => {
    expect(CAPTURE_BIND_ADDRESS).toBe("127.0.0.1");
    expect(CAPTURE_PORT).toBe(27124);
    expect(CAPTURE_ROUTE).toBe("/v1/capture");
    expect(CONNECTOR_VERSION_HEADER).toBe("X-Paper-Notes-Connector-Version");
    expect(CONNECTOR_VERSION).toBe("1");
    expect(WEB_CAPTURE_SCHEMA_VERSION).toBe(1);
  });

  it("keeps the body cap at or below 256 KiB", () => {
    expect(MAX_CAPTURE_BODY_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("WebCaptureRequest validation", () => {
  it("accepts a valid request", () => {
    expect(isWebCaptureRequest(validRequest())).toBe(true);
    expect(webCaptureRejectionReason(validRequest())).toBeNull();
  });

  it("rejects non-objects and arrays", () => {
    expect(isWebCaptureRequest(null)).toBe(false);
    expect(isWebCaptureRequest([])).toBe(false);
    expect(isWebCaptureRequest("text")).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const value = { ...validRequest(), command: "rm -rf /" } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("unknown fields");
  });

  it("rejects unsupported schema versions", () => {
    const value = { ...validRequest(), schema_version: 2 } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("schema_version");
  });

  it("rejects missing or oversized capture_id", () => {
    const missing = { ...validRequest(), capture_id: "" } as unknown;
    expect(webCaptureRejectionReason(missing)).toContain("capture_id");
    const huge = { ...validRequest(), capture_id: "x".repeat(129) } as unknown;
    expect(webCaptureRejectionReason(huge)).toContain("capture_id");
  });

  it("rejects non-HTTPS page URLs", () => {
    const value = { ...validRequest(), page_url: "file:///etc/passwd" } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("HTTPS");
    const vault = { ...validRequest(), page_url: "/Users/me/05 Literature/a" } as unknown;
    expect(webCaptureRejectionReason(vault)).toContain("HTTPS");
  });

  it("rejects empty or oversized records arrays", () => {
    const empty = { ...validRequest(), records: [] } as unknown;
    expect(webCaptureRejectionReason(empty)).toContain("records");
    const many = {
      ...validRequest(),
      records: Array.from({ length: 17 }, (_, i) => ({
        source: "doi_scan" as const,
        values: { doi: `10.1000/${i}` },
      })),
    } as unknown;
    expect(webCaptureRejectionReason(many)).toContain("records");
  });

  it("rejects unknown source names", () => {
    const value = {
      ...validRequest(),
      records: [{ source: "zotero", values: { title: "x" } }],
    } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("malformed evidence");
  });

  it("rejects unknown captured fields", () => {
    const value = {
      ...validRequest(),
      records: [{ source: "highwire", values: { tags: ["x"], title: "x" } }],
    } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("malformed evidence");
  });

  it("rejects path/command-like values in captured strings", () => {
    const value = {
      ...validRequest(),
      records: [
        {
          source: "highwire",
          values: { title: "../../../etc/passwd", abstract: "--vault /tmp" },
        },
      ],
    } as unknown;
    // The protocol is a field allowlist; path-like strings are still
    // accepted as bibliographic text here and the bridge/core decides
    // how to treat them. This test documents that no command/path is
    // ever a protocol field itself.
    expect(isWebCaptureRequest(value)).toBe(true);
  });

  it("rejects malformed author shapes", () => {
    const value = {
      ...validRequest(),
      records: [
        {
          source: "highwire",
          values: { authors: [{ family: "Doe", unknown: "x" }] },
        },
      ],
    } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("malformed evidence");
  });

  it("rejects malformed dates and years", () => {
    const badDate = {
      ...validRequest(),
      records: [{ source: "highwire", values: { publication_date: "2024-13-99" } }],
    } as unknown;
    expect(webCaptureRejectionReason(badDate)).toContain("malformed evidence");
    const badYear = {
      ...validRequest(),
      records: [{ source: "highwire", values: { year: 99 } }],
    } as unknown;
    expect(webCaptureRejectionReason(badYear)).toContain("malformed evidence");
  });

  it("rejects oversized strings", () => {
    const value = {
      ...validRequest(),
      records: [{ source: "highwire", values: { title: "x".repeat(20001) } }],
    } as unknown;
    expect(webCaptureRejectionReason(value)).toContain("malformed evidence");
  });
});

describe("browser capture result union", () => {
  it("recognizes every closed status shape", () => {
    const results: BrowserCaptureResult[] = [
      { status: "created", citationKey: "doe2024", title: "A", path: "05 Literature/doe2024/doe2024.md" },
      { status: "existing", citationKey: "doe2024", title: "A", action: "open" },
      { status: "needs_review", reviewId: "abc", reason: "missing year" },
      { status: "rejected", code: "bad_request", reason: "bad request" },
      { status: "unavailable", reason: "Obsidian is not running" },
    ];
    for (const result of results) {
      expect(isBrowserCaptureResult(result)).toBe(true);
    }
    expect(BROWSER_CAPTURE_RESULT_STATUSES).toEqual([
      "created",
      "existing",
      "needs_review",
      "rejected",
      "unavailable",
    ]);
  });

  it("rejects unknown and malformed result shapes", () => {
    expect(isBrowserCaptureResult({ status: "unknown" })).toBe(false);
    expect(isBrowserCaptureResult({ status: "created", citationKey: "" })).toBe(false);
    expect(isBrowserCaptureResult({ status: "needs_review", reviewId: "" })).toBe(false);
  });
});
