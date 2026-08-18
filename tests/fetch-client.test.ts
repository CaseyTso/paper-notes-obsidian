/**
 * FetchClient transport tests: argv safety, JSON parsing, doctor mapping,
 * timeout and abort cancellation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  } as unknown as typeof import("node:child_process");
});

import { FetchClient, FetchClientError } from "../src/services/fetch-client";
import { writeFakeCli } from "./fixtures/fake-paper-notes";

const spawnMock = vi.mocked(spawn);

describe("FetchClient", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-fetch-test-"));
    spawnMock.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("spawns fetch with an argv array and no shell", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify({
          success: true,
          source: "open_access",
          pdf_path: "/tmp/paper.pdf",
        }) + "\n",
    });
    const client = new FetchClient(cliPath);
    await client.fetchPdf("10.1234/abc", { outputDir: "/tmp/out" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell?: unknown } | undefined,
    ];
    expect(call[0]).toBe(cliPath);
    expect(call[1]).toEqual([
      "fetch",
      "10.1234/abc",
      "--json",
      "--no-zotero",
      "--output",
      "/tmp/out",
    ]);
    expect(call[2]?.shell).toBeFalsy();
  });

  it("parses a successful fetch result", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify({
          success: true,
          source: "open_access",
          pdf_path: "/tmp/paper.pdf",
          identity: { doi: "10.1234/abc" },
        }) + "\n",
    });
    const result = await new FetchClient(cliPath).fetchPdf("10.1234/abc", {
      outputDir: "/tmp/out",
    });
    expect(result.success).toBe(true);
    expect(result.source).toBe("open_access");
    expect(result.identity?.doi).toBe("10.1234/abc");
  });

  it("rejects malformed stdout as bad_json", async () => {
    const cliPath = writeFakeCli(tempDir, { stdoutRaw: "not json\n" });
    await expect(
      new FetchClient(cliPath).fetchPdf("10.1234/abc", {
        outputDir: "/tmp/out",
      }),
    ).rejects.toMatchObject({ code: "bad_json" });
  });

  it("doctor maps an ok ablesci row to ready", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify({
          overall: "ok",
          checks: [
            {
              name: "ablesci",
              status: "ok",
              detail: "ableSci session ready",
              action: "",
            },
          ],
        }) + "\n",
    });
    const result = await new FetchClient(cliPath).ableSciStatus();
    expect(result.status).toBe("ready");
    expect(result.rowStatus).toBe("ok");
  });

  it("doctor maps a missing ablesci row to not_ready", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify({
          overall: "needs_configuration",
          checks: [
            {
              name: "ablesci",
              status: "missing",
              detail: "session cookies are incomplete",
              action: "log in again",
            },
          ],
        }) + "\n",
    });
    const result = await new FetchClient(cliPath).ableSciStatus();
    expect(result.status).toBe("not_ready");
    expect(result.rowStatus).toBe("missing");
    expect(result.action).toBe("log in again");
  });

  it("doctor is unavailable when the ablesci row is absent", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw: JSON.stringify({ overall: "ok", checks: [] }) + "\n",
    });
    const result = await new FetchClient(cliPath).ableSciStatus();
    expect(result.status).toBe("unavailable");
  });

  it("times out and rejects with FetchClientError", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw: JSON.stringify({ success: true, source: "s" }) + "\n",
      delayMs: 500,
    });
    const client = new FetchClient(cliPath);
    const error = await client
      .fetchPdf("10.1234/abc", { outputDir: "/tmp/out", timeoutMs: 50 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(FetchClientError);
    expect((error as FetchClientError).code).toBe("timeout");
  });

  it("honors AbortSignal cancellation", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw: JSON.stringify({ success: true, source: "s" }) + "\n",
      delayMs: 500,
    });
    const controller = new AbortController();
    const client = new FetchClient(cliPath);
    const promise = client.fetchPdf("10.1234/abc", {
      outputDir: "/tmp/out",
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 10);
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchClientError);
    expect((error as FetchClientError).code).toBe("aborted");
  });
});