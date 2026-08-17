/**
 * Streaming CLI bridge (`runStream` / `runWithInput`) — Task: MinerU.
 *
 * Covers the NDJSON progress contract of `mineru convert` plus the stdin
 * delivery path of `config mineru set-key --stdin`, using the real
 * `CliClient` spawn against the executable fake CLI. The one-shot `run`
 * method is untouched and remains covered by its own suite.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliClient } from "../src/services/cli-client";
import { buildEnvelope, writeFakeCli } from "./fixtures/fake-paper-notes";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "paper-notes-stream-"));
}

describe("CliClient.runStream", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  function makeClient(behavior: Parameters<typeof writeFakeCli>[1]): {
    client: CliClient;
  } {
    const dir = tempDir();
    dirs.push(dir);
    const cliPath = writeFakeCli(dir, behavior);
    return { client: new CliClient(cliPath) };
  }

  it("parses NDJSON progress lines and resolves the final envelope", async () => {
    const { client } = makeClient({
      stdoutRaw:
        JSON.stringify({
          type: "progress",
          stage: "uploading",
          extracted_pages: 0,
          total_pages: 12,
        }) +
        "\n" +
        JSON.stringify({
          type: "progress",
          stage: "processing",
          state: "running",
          extracted_pages: 5,
          total_pages: 12,
        }) +
        "\n" +
        JSON.stringify(
          buildEnvelope({
            data: { action: "converted", citation_key: "smith2026" },
          }),
        ) +
        "\n",
    });
    const events: Record<string, unknown>[] = [];
    const result = await client.runStream(
      ["mineru", "convert", "--vault", "/v", "--key", "smith2026"],
      { onProgress: (event) => events.push(event) },
    );
    expect(events).toHaveLength(2);
    expect(events[0].stage).toBe("uploading");
    expect(events[1].extracted_pages).toBe(5);
    expect(result.envelope.status).toBe("success");
    expect(result.envelope.data.citation_key).toBe("smith2026");
  });

  it("handles a plain single-envelope (non-streaming) core", async () => {
    const { client } = makeClient({
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({ data: { configured: false } }),
        ) + "\n",
    });
    const events: Record<string, unknown>[] = [];
    const result = await client.runStream(
      ["config", "mineru", "status"],
      { onProgress: (event) => events.push(event) },
    );
    expect(events).toHaveLength(0);
    expect(result.envelope.data.configured).toBe(false);
  });

  it("splits progress lines arriving in one chunk", async () => {
    const { client } = makeClient({
      stdoutRaw:
        JSON.stringify({ type: "progress", stage: "a", x: 1 }) +
        "\n" +
        JSON.stringify({ type: "progress", stage: "b", x: 2 }) +
        "\n" +
        JSON.stringify(buildEnvelope()) +
        "\n",
    });
    const events: Record<string, unknown>[] = [];
    await client.runStream(["mineru", "convert"], {
      onProgress: (event) => events.push(event),
    });
    expect(events.map((event) => event.stage)).toEqual(["a", "b"]);
  });

  it("delivers input on stdin without argv exposure", async () => {
    const { client } = makeClient({ readStdin: true });
    const result = await client.runWithInput(
      ["config", "mineru", "set-key", "--stdin"],
      "sk-mineru-supersecret-1234567890\n",
    );
    expect(result.envelope.status).toBe("success");
    expect(result.envelope.data.stdin).toBe("sk-mineru-supersecret-1234567890\n");
    // the secret never appears in the argv echo
    const argv = result.envelope.data.argv as string[];
    expect(argv.join(" ")).not.toContain("supersecret");
  });

  it("redacts exact secrets from surfaced stderr and error text", async () => {
    const { client } = makeClient({
      stderr: "token sk-mineru-abc123 leaked here",
      exitCode: 3,
      stdoutRaw:
        JSON.stringify(buildEnvelope({ status: "conflict" })) + "\n",
    });
    const result = await client.runStream(["mineru", "convert"], {
      redact: ["sk-mineru-abc123"],
    });
    expect(result.envelope.status).toBe("conflict");
    expect(result.stderr).not.toContain("sk-mineru-abc123");
    expect(result.stderr).toContain("***");
  });

  it("aborts a long-running conversion via the abort signal", async () => {
    const { client } = makeClient({
      delayMs: 60000,
      ignoreSigterm: true,
    });
    const controller = new AbortController();
    const pending = client.runStream(
      ["mineru", "convert", "--vault", "/v", "--key", "x"],
      { signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "aborted",
    });
    controller.abort();
    await assertion;
  });

  it("rejects with bad_json when no envelope appears on stdout", async () => {
    const { client } = makeClient({
      stdoutRaw: JSON.stringify({ type: "progress", stage: "uploading" }) + "\n",
    });
    await expect(
      client.runStream(["mineru", "convert"]),
    ).rejects.toMatchObject({ code: "bad_json" });
  });

  it("rejects protocol mismatch for a non-v1 envelope", async () => {
    const { client } = makeClient({
      stdoutRaw: JSON.stringify({ protocol_version: 99, status: "success", data: {}, warnings: [], errors: [] }) + "\n",
    });
    await expect(
      client.runStream(["version"]),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
  });
});
