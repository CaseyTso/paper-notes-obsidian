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

import {
  CliClient,
  CliError,
  sanitizeDiagnostics,
} from "../src/services/cli-client";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";
import { PROTOCOL_VERSION, isProtocolEnvelope } from "../src/types/protocol";
import { buildEnvelope, writeFakeCli } from "./fixtures/fake-paper-notes";

const spawnMock = vi.mocked(spawn);

describe("CliClient transport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-cli-test-"));
    spawnMock.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("spawns with an argument array and never a shell", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const client = new CliClient(cliPath);
    await client.run(["version"]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { shell?: unknown } | undefined,
    ];
    expect(call[0]).toBe(cliPath);
    expect(Array.isArray(call[1])).toBe(true);
    expect(call[1]).toEqual(["--json", "version"]);
    expect(call[2]?.shell).toBeFalsy();
  });

  it("round-trips Unicode and space-containing vault paths through real spawn", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const client = new CliClient(cliPath);
    const vault = "/tmp/我的 知识库/05 Literature";
    const { envelope } = await client.run([
      "--vault",
      vault,
      "--key",
      "cell-pheno-x-2024",
    ]);
    expect(envelope.data).toEqual({
      argv: ["--json", "--vault", vault, "--key", "cell-pheno-x-2024"],
    });
  });

  it("parses exactly one JSON envelope from stdout", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw: JSON.stringify(buildEnvelope({ data: { ok: true } })) + "\n",
    });
    const { envelope } = await new CliClient(cliPath).run(["version"]);
    expect(envelope.status).toBe("success");
    expect(envelope.data).toEqual({ ok: true });
  });

  it("rejects stdout that contains more than one JSON object", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(buildEnvelope({ data: { extra: true } })) +
        "\n" +
        JSON.stringify(buildEnvelope()) +
        "\n",
    });
    await expect(new CliClient(cliPath).run(["version"])).rejects.toMatchObject(
      { code: "bad_json" },
    );
  });

  it("rejects stdout that is not a JSON object", async () => {
    const cliPath = writeFakeCli(tempDir, { stdoutRaw: "[1, 2, 3]\n" });
    await expect(new CliClient(cliPath).run(["version"])).rejects.toMatchObject(
      { code: "bad_json" },
    );
  });

  it("preserves envelope status and exit code for conflict responses", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "conflict",
            errors: [{ code: "duplicate_key", message: "key already exists" }],
          }),
        ) + "\n",
      exitCode: 3,
    });
    const { envelope, exitCode } = await new CliClient(cliPath).run([
      "item",
      "create",
      "--vault",
      "/tmp/vault",
    ]);
    expect(exitCode).toBe(3);
    expect(envelope.status).toBe("conflict");
    expect(envelope.errors[0].code).toBe("duplicate_key");
  });

  it("accepts protocol v1 and reports a compatible probe", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(buildEnvelope({ data: { version: "0.1.0" } })) + "\n",
    });
    const probe = await new CliClient(cliPath).probe();
    expect(PROTOCOL_VERSION).toBe(1);
    expect(probe).toEqual({
      compatible: true,
      protocolVersion: 1,
      readOnlyMode: false,
      cliVersion: "0.1.0",
    });
  });

  it("forces read-only mode on protocol version mismatch", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({ protocol_version: 2, data: { version: "9.9.9" } }),
        ) + "\n",
    });
    const client = new CliClient(cliPath);
    const probe = await client.probe();
    expect(probe.compatible).toBe(false);
    expect(probe.readOnlyMode).toBe(true);
    expect(probe.protocolVersion).toBe(2);
    await expect(client.run(["version"])).rejects.toMatchObject({
      code: "protocol_mismatch",
    });
  });

  it("forces read-only mode when the CLI cannot be started", async () => {
    const client = new CliClient(join(tempDir, "does-not-exist"));
    const probe = await client.probe();
    expect(probe).toMatchObject({
      compatible: false,
      readOnlyMode: true,
      error: "not_found",
    });
  });

  it("times out and terminates a hanging CLI", async () => {
    const cliPath = writeFakeCli(tempDir, {
      delayMs: 5000,
      ignoreSigterm: true,
    });
    const client = new CliClient(cliPath);
    const started = Date.now();
    await expect(
      client.run(["version"], { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("cancels a running CLI via AbortSignal", async () => {
    const cliPath = writeFakeCli(tempDir, { delayMs: 5000 });
    const controller = new AbortController();
    const pending = new CliClient(cliPath).run(["version"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cliPath = writeFakeCli(tempDir, {});
    await expect(
      new CliClient(cliPath).run(["version"], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects immediately for a non-positive timeout", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    await expect(
      new CliClient(cliPath).run(["version"], { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("surfaces sanitized stderr on success without leaking secrets", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stderr: "WARNING: key sk-test1234567890abcdef expired\n",
    });
    const { stderr } = await new CliClient(cliPath).run(["version"]);
    expect(stderr).toBe("WARNING: key sk-*** expired\n");
    expect(stderr).not.toContain("sk-test1234567890abcdef");
  });

  it("sanitizes secrets from surfaced diagnostics on failure", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw: "not json at all\n",
      stderr: "config apiKey=sk-abc123def456ghi7890 broken\n",
      exitCode: 2,
    });
    const error = await new CliClient(cliPath)
      .run(["version"])
      .then(
        () => undefined as CliError | undefined,
        (caught: unknown) => caught as CliError,
      );
    expect(error).toBeInstanceOf(CliError);
    expect(error?.code).toBe("bad_json");
    expect(error?.stderr).toContain("apiKey=***");
    expect(error?.stderr).not.toContain("sk-abc123def456ghi7890");
    expect(error?.message).not.toContain("sk-abc123def456ghi7890");
  });

  it("redacts secret-like tokens in sanitizeDiagnostics", () => {
    expect(
      sanitizeDiagnostics(
        "token=sk-1234567890abcdef and secret: hunter2hunter2",
      ),
    ).toBe("token=*** and secret: ***");
    expect(
      sanitizeDiagnostics(
        "normal diagnostics keep words like secretive and tokenizer",
      ),
    ).toBe("normal diagnostics keep words like secretive and tokenizer");
  });
});

describe("protocol envelope validation", () => {
  it("accepts a minimal v1 envelope", () => {
    expect(isProtocolEnvelope(buildEnvelope())).toBe(true);
  });

  it("rejects non-object payloads and malformed shapes", () => {
    expect(isProtocolEnvelope(null)).toBe(false);
    expect(isProtocolEnvelope([1])).toBe(false);
    expect(
      isProtocolEnvelope({
        protocol_version: 1,
        status: "bogus",
        data: {},
        warnings: [],
        errors: [],
      }),
    ).toBe(false);
    expect(
      isProtocolEnvelope({
        protocol_version: "1",
        status: "success",
        data: {},
        warnings: [],
        errors: [],
      }),
    ).toBe(false);
  });
});

describe("plugin settings", () => {
  it("exposes defaults for every bridge setting", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      cliPath: "paper-notes",
      paperFetchPath: "paper-fetch",
      literatureRoot: "05 Literature",
      exportDirectory: "",
      pandocPath: "pandoc",
      pdfEngine: "xelatex",
      referenceDocx: "",
      selectedCsl: "",
      metricTtlDays: 30,
    });
  });

  it("keeps defaults when nothing was loaded", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("merges partial loaded settings over defaults", () => {
    const settings = normalizeSettings({
      cliPath: "/opt/paper-notes/bin/paper-notes",
      paperFetchPath: "/opt/paper-fetch/bin/paper-fetch",
      metricTtlDays: 7,
    });
    expect(settings.cliPath).toBe("/opt/paper-notes/bin/paper-notes");
    expect(settings.paperFetchPath).toBe("/opt/paper-fetch/bin/paper-fetch");
    expect(settings.literatureRoot).toBe("05 Literature");
    expect(settings.metricTtlDays).toBe(7);
  });

  it("drops unknown keys and coerces wrong types back to defaults", () => {
    const settings = normalizeSettings({
      cliPath: 42,
      metricTtlDays: "30",
      unknownSetting: "x",
      exportDirectory: "/tmp/导出",
    });
    expect(settings.cliPath).toBe("paper-notes");
    expect(settings.metricTtlDays).toBe(30);
    expect(settings.exportDirectory).toBe("/tmp/导出");
    expect("unknownSetting" in settings).toBe(false);
  });

  it("is stable under round-trip normalization", () => {
    const loaded = {
      pandocPath: "/opt/homebrew/bin/pandoc",
      pdfEngine: "weasyprint",
      referenceDocx: "/tmp/ref.docx",
      selectedCsl: "nature.csl",
    };
    const once = normalizeSettings(loaded);
    expect(normalizeSettings(once)).toEqual(once);
  });
});
