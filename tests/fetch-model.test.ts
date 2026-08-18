/**
 * Pure Fetch PDF model tests: identifier precedence, identity verification,
 * failure status normalization, URL extraction.
 */

import { describe, expect, it } from "vitest";
import type { PaperRecord } from "../src/types/paper";
import type { FetchResultJson } from "../src/types/fetch";
import {
  extractFirstHttpUrl,
  extractRequestId,
  failureDetailOf,
  failureStatusOf,
  normalizeDoi,
  selectFetchIdentifier,
  titleSimilarity,
  verifyFetchedIdentity,
} from "../src/services/fetch-model";

function makeRecord(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    path: "05 Literature/key/key.md",
    key: "key",
    paperId: "uuid",
    title: "A paper title",
    authors: [],
    citationKeyAliases: [],
    titleAliases: [],
    ...overrides,
    identifiers: {
      doi: undefined,
      pmid: undefined,
      pmcid: undefined,
      arxiv: undefined,
      ...(overrides.identifiers ?? {}),
    },
  };
}

describe("selectFetchIdentifier", () => {
  it("prefers DOI over PMID/PMCID", () => {
    expect(
      selectFetchIdentifier(
        makeRecord({
          identifiers: {
            doi: "10.1234/abc",
            pmid: "12345678",
            pmcid: "PMC12345",
          },
        }),
      ),
    ).toEqual({ field: "doi", value: "10.1234/abc" });
  });

  it("falls back to PMID then PMCID", () => {
    expect(
      selectFetchIdentifier(
        makeRecord({ identifiers: { pmid: "12345678" } }),
      ),
    ).toEqual({ field: "pmid", value: "12345678" });
    expect(
      selectFetchIdentifier(
        makeRecord({ identifiers: { pmcid: "PMC12345" } }),
      ),
    ).toEqual({ field: "pmcid", value: "PMC12345" });
  });

  it("ignores arXiv and empty values", () => {
    expect(
      selectFetchIdentifier(
        makeRecord({ identifiers: { arxiv: "2401.00001" } }),
      ),
    ).toBeUndefined();
    expect(selectFetchIdentifier(makeRecord({}))).toBeUndefined();
  });
});

describe("normalizeDoi", () => {
  it("strips doi.org prefixes, doi: prefix, and lowercases", () => {
    expect(normalizeDoi("https://doi.org/10.1234/ABC")).toBe("10.1234/abc");
    expect(normalizeDoi("http://dx.doi.org/10.1234/ABC")).toBe("10.1234/abc");
    expect(normalizeDoi("DOI: 10.1234/ABC")).toBe("10.1234/abc");
  });
});

describe("titleSimilarity", () => {
  it("returns 1 for identical titles and low for unrelated text", () => {
    expect(titleSimilarity("Same Title", "same title")).toBe(1);
    expect(titleSimilarity("Alpha", "Beta")).toBeLessThan(0.5);
  });
});

describe("verifyFetchedIdentity", () => {
  it("rejects when the fetched DOI differs from the record", () => {
    const result = verifyFetchedIdentity(
      makeRecord({ identifiers: { doi: "10.1/a" } }),
      { doi: "10.2/b" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("DOI");
    }
  });

  it("accepts an exact DOI", () => {
    expect(
      verifyFetchedIdentity(
        makeRecord({ identifiers: { doi: "10.1/A" } }),
        { doi: "https://doi.org/10.1/a" },
      ),
    ).toEqual({ ok: true });
  });

  it("rejects on title mismatch when no record DOI exists", () => {
    const result = verifyFetchedIdentity(
      makeRecord({ title: "Expected title" }),
      { title: "Completely different" },
    );
    expect(result.ok).toBe(false);
  });

  it("accepts when identity has a DOI even if record title differs", () => {
    expect(
      verifyFetchedIdentity(
        makeRecord({ title: "Expected title" }),
        { doi: "10.1/x", title: "Completely different" },
      ),
    ).toEqual({ ok: true });
  });

  it("accepts when neither DOI nor title can be compared", () => {
    expect(verifyFetchedIdentity(makeRecord({}), {})).toEqual({ ok: true });
  });
});

describe("failureStatusOf", () => {
  it("uses the highest-priority structured status from attempts", () => {
    const result: FetchResultJson = {
      success: false,
      source: "ablesci",
      attempts: [
        { source: "open_access", status: "no_pdf", detail: "" },
        { source: "ablesci", status: "authentication_required", detail: "" },
      ],
    };
    expect(failureStatusOf(result)).toBe("authentication_required");
  });

  it("falls back to unknown", () => {
    expect(failureStatusOf({ success: false, source: "" })).toBe("unknown");
  });
});

describe("extractFirstHttpUrl", () => {
  it("extracts only http(s) URLs", () => {
    expect(extractFirstHttpUrl("open https://sci-hub.jp/x link")).toBe(
      "https://sci-hub.jp/x",
    );
    expect(extractFirstHttpUrl("ftp://example.com/x")).toBeUndefined();
    expect(extractFirstHttpUrl(undefined)).toBeUndefined();
  });

  it("strips trailing punctuation from a URL", () => {
    expect(extractFirstHttpUrl("见 https://sci-hub.jp/x/verify。详情")).toBe(
      "https://sci-hub.jp/x/verify",
    );
  });
});

describe("extractRequestId", () => {
  it("reads an id from an ableSci detail URL", () => {
    expect(
      extractRequestId("pending at https://www.ablesci.com/assist/detail?id=Ab12_3x"),
    ).toBe("Ab12_3x");
  });

  it("reads an id= form", () => {
    expect(extractRequestId("request id=xyz789")).toBe("xyz789");
  });

  it("returns undefined without a usable id", () => {
    expect(extractRequestId("no PDF within 1 minute — ableSci request pending")).toBeUndefined();
    expect(extractRequestId(undefined)).toBeUndefined();
  });
});

describe("failureDetailOf", () => {
  it("prefers error text then joins attempt details", () => {
    expect(
      failureDetailOf({
        success: false,
        source: "",
        error: "boom",
        attempts: [],
      }),
    ).toBe("boom");
    expect(
      failureDetailOf({
        success: false,
        source: "",
        attempts: [
          { source: "scihub", status: "timeout", detail: "slow" },
          { source: "ablesci", status: "timeout", detail: "" },
        ],
      }),
    ).toBe("scihub: slow; ablesci");
  });
});