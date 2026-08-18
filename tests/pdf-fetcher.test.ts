/**
 * PdfFetcher orchestration tests: two-stage fetch + attach, temp cleanup,
 * identity guard, transport/failure mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn((prefix: string) => actual.mkdtempSync(prefix)),
    rmSync: vi.fn((...args: Parameters<typeof actual.rmSync>) =>
      actual.rmSync(...args),
    ),
  };
});

import { FetchClient, FetchClientError } from "../src/services/fetch-client";
import { PdfFetcher } from "../src/services/pdf-fetcher";
import type { PaperRecord } from "../src/types/paper";
import type { ActionOutcome } from "../src/services/item-actions";

const mkdtempMock = vi.mocked(fs.mkdtempSync);
const rmSyncMock = vi.mocked(fs.rmSync);

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
    identifiers: overrides.identifiers ?? { doi: "10.1/a" },
  };
}

const successOutcome: ActionOutcome = {
  status: "success",
  envelope: {} as never,
};

describe("PdfFetcher", () => {
  let attach: ReturnType<typeof vi.fn>;
  let client: {
    fetchPdf: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    attach = vi.fn();
    client = { fetchPdf: vi.fn() };
    mkdtempMock.mockClear();
    rmSyncMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function outcomeFor(
    recordOverrides: Partial<PaperRecord> = {},
  ): Promise<unknown> {
    const fetcher = new PdfFetcher({
      client: client as unknown as FetchClient,
    });
    return fetcher.fetchAndAttach({
      record: makeRecord(recordOverrides),
      attach: attach as unknown as (pdfPath: string, source: string) => Promise<ActionOutcome>,
    });
  }

  it("downloads, verifies, attaches, and cleans the temp dir", async () => {
    client.fetchPdf.mockResolvedValue({
      success: true,
      source: "open_access",
      pdf_path: "/tmp/paper.pdf",
      identity: { doi: "10.1/a" },
    });
    attach.mockResolvedValue(successOutcome);

    const result = await outcomeFor();
    expect(result).toEqual({ status: "attached", source: "open_access" });
    expect(attach).toHaveBeenCalledWith("/tmp/paper.pdf", "open_access");
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("paper-notes-fetch-"),
      { recursive: true, force: true },
    );
  });

  it("does not attach on a structured fetch failure", async () => {
    client.fetchPdf.mockResolvedValue({
      success: false,
      source: "",
      attempts: [
        { source: "ablesci", status: "all_sources_failed", detail: "no" },
      ],
    });
    const result = await outcomeFor();
    expect(result).toMatchObject({
      status: "failed",
      kind: "all_sources_failed",
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it("maps transport errors to transport outcomes but still cleans up", async () => {
    client.fetchPdf.mockRejectedValue(
      new FetchClientError({ code: "timeout", message: "timed out" }),
    );
    const result = await outcomeFor();
    expect(result).toMatchObject({ status: "transport", code: "timeout" });
    expect(attach).not.toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalled();
  });

  it("aborts before attach on identity mismatch", async () => {
    client.fetchPdf.mockResolvedValue({
      success: true,
      source: "scihub",
      pdf_path: "/tmp/paper.pdf",
      identity: { doi: "10.2/b" },
    });
    const result = await outcomeFor();
    expect(result).toMatchObject({ status: "identity_mismatch" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("reports attach failures", async () => {
    client.fetchPdf.mockResolvedValue({
      success: true,
      source: "open_access",
      pdf_path: "/tmp/paper.pdf",
      identity: { doi: "10.1/a" },
    });
    attach.mockResolvedValue({
      status: "error",
      code: "cli_error",
      message: "attach boom",
    });
    const result = await outcomeFor();
    expect(result).toEqual({
      status: "attach_failed",
      message: "attach boom",
    });
  });

  it("reports attach needs_confirmation as an explicit edge", async () => {
    client.fetchPdf.mockResolvedValue({
      success: true,
      source: "open_access",
      pdf_path: "/tmp/paper.pdf",
      identity: { doi: "10.1/a" },
    });
    attach.mockResolvedValue({
      status: "needs_confirmation",
      token: "t",
      envelope: {} as never,
    });
    const result = await outcomeFor();
    expect(result).toEqual({ status: "attach_needs_confirmation" });
  });

  it("fails fast when no paper-fetch-compatible identifier exists", async () => {
    const result = await outcomeFor({ identifiers: { arxiv: "2401.1" } });
    expect(result).toMatchObject({ status: "failed", kind: "unknown" });
    expect(client.fetchPdf).not.toHaveBeenCalled();
    // No temp directory was created, so nothing to clean.
    expect(mkdtempMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });
});