import { describe, expect, it, vi } from "vitest";

import type { ProtocolEnvelope } from "../src/types/protocol";
import {
  ItemActions,
  mocCreateArgs,
  mocCreateNoticeText,
  type ActionOutcome,
} from "../src/services/item-actions";
import { CliClient, type CliRunResult } from "../src/services/cli-client";

const VAULT_ROOT = "/tmp/fake-vault";

function makeEnvelope(
  status: ProtocolEnvelope["status"],
  data: Record<string, unknown> = {},
  errors: ProtocolEnvelope["errors"] = [],
): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status,
    data,
    warnings: [],
    errors,
  } as ProtocolEnvelope;
}

function mockClient(
  result: CliRunResult | ((args: string[]) => CliRunResult),
): CliClient {
  const run = vi.fn(
    typeof result === "function"
      ? (args: string[]) => Promise.resolve(result(args))
      : () => Promise.resolve(result),
  ) as unknown as CliClient;
  // Preserve the run method on the mock
  (run as unknown as { run: unknown }).run = run;
  return run;
}

describe("mocCreateArgs", () => {
  it("returns an argv array with --title as its own element", () => {
    const args = mocCreateArgs(VAULT_ROOT, "拟时序分析");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual([
      "moc", "create", "--vault", VAULT_ROOT, "--title", "拟时序分析",
    ]);
    // CJK title must not be split — it is a single element
    const titleIdx = args.indexOf("--title");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(args[titleIdx + 1]).toBe("拟时序分析");
  });
});

describe("mocCreateNoticeText", () => {
  const success: ActionOutcome = {
    status: "success",
    envelope: makeEnvelope("success", { path: "05 Literature/MOCs/x.md" }),
  };
  const conflict: ActionOutcome = {
    status: "error",
    code: "conflict",
    message: "conflict",
    envelope: makeEnvelope("conflict", {}, [{ code: "conflict", message: "exists" }]),
  };
  const cliError: ActionOutcome = {
    status: "error",
    code: "not_found",
    message: "CLI not found",
  };

  it("returns success notice", () => {
    expect(mocCreateNoticeText(success, "主题")).toBe(
      'Topic MOC \u201c主题\u201d created.',
    );
  });

  it("returns conflict notice", () => {
    expect(mocCreateNoticeText(conflict, "主题")).toBe(
      'A Topic MOC named \u201c主题\u201d already exists.',
    );
  });

  it("returns CLI unavailable notice for other errors", () => {
    expect(mocCreateNoticeText(cliError, "主题")).toBe(
      "paper-notes CLI unavailable; cannot create a Topic MOC.",
    );
  });
});

describe("ItemActions.createMoc", () => {
  it("calls CliClient.run with argv array including CJK title", async () => {
    const client = mockClient({
      envelope: makeEnvelope("success", {
        title: "拟时序分析",
        path: "05 Literature/MOCs/拟时序分析.md",
        kind: "topic-moc",
      }),
      exitCode: 0,
      stderr: "",
    });
    const actions = new ItemActions({ client, vaultRoot: VAULT_ROOT });
    const result = await actions.createMoc("拟时序分析");
    expect(result.outcome.status).toBe("success");
    expect(result.path).toBe("05 Literature/MOCs/拟时序分析.md");
    expect(result.title).toBe("拟时序分析");
    // Verify run was called with an array, not a shell string
    const calls = (client as unknown as { run: ReturnType<typeof vi.fn> }).run.mock.calls;
    expect(calls).toHaveLength(1);
    const args = calls[0][0];
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("--title");
    expect(args[args.indexOf("--title") + 1]).toBe("拟时序分析");
  });

  it("returns error outcome for empty title without calling CLI", async () => {
    const client = mockClient({
      envelope: makeEnvelope("success"),
      exitCode: 0,
      stderr: "",
    });
    const actions = new ItemActions({ client, vaultRoot: VAULT_ROOT });
    const result = await actions.createMoc("   ");
    expect(result.outcome.status).toBe("error");
    expect((result.outcome as { code: string }).code).toBe("empty_title");
    expect(result.path).toBeUndefined();
    // CLI must not have been called
    const calls = (client as unknown as { run: ReturnType<typeof vi.fn> }).run.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("maps conflict envelope to error outcome", async () => {
    const client = mockClient({
      envelope: makeEnvelope(
        "conflict",
        {},
        [{ code: "conflict", message: "topic moc already exists" }],
      ),
      exitCode: 3,
      stderr: "",
    });
    const actions = new ItemActions({ client, vaultRoot: VAULT_ROOT });
    const result = await actions.createMoc("重复主题");
    expect(result.outcome.status).toBe("error");
    if (result.outcome.status === "error") {
      expect(result.outcome.code).toBe("conflict");
    }
    expect(result.path).toBeUndefined();
  });

  it("maps CLI transport error to error outcome", async () => {
    const runFn = vi.fn(() =>
      Promise.reject(new Error("CLI not found")),
    );
    const client = { run: runFn } as unknown as CliClient;
    const actions = new ItemActions({ client, vaultRoot: VAULT_ROOT });
    const result = await actions.createMoc("主题");
    expect(result.outcome.status).toBe("error");
    if (result.outcome.status === "error") {
      expect(result.outcome.code).toBe("internal_error");
    }
    expect(result.path).toBeUndefined();
  });
});
