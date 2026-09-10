/**
 * Item actions and confirmation modals (Task 25).
 *
 * Covers the CLI-backed mutation service (`src/services/item-actions.ts`)
 * and the three modal classes with stubbed Obsidian elements:
 *
 * - Open main/PDF/MinerU/Figure/cards asset resolution (spec §9.5).
 * - Create modal accepts identifier/URL/PDF inputs.
 * - `needs_confirmation` values are displayed and resubmitted with the
 *   confirmation token (attach/rename/delete) or the deterministic
 *   `--confirmed` carrier file (create).
 * - Reading status mutations go through `item update`.
 * - PDF attachment goes through `item attach-pdf`.
 * - Rename always previews (`--dry-run`) before confirming.
 * - Delete preview shows file count/size/backlinks and requires the
 *   exact citation key.
 * - A CLI error never leads to any direct vault/YAML fallback write.
 *
 * The Obsidian module is mocked with minimal element stubs (the npm
 * package is types-only; happy-dom would break the hoisted mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProtocolEnvelope } from "../src/types/protocol";
import type { App } from "obsidian";
import {
  ItemActions,
  buildCreateInput,
  buildDeletePreview,
  confirmedValuesOf,
  confirmKeyMatches,
  formatBytes,
  nextReadingStatus,
  openCard,
  parseCreateInput,
  paperDirectoryOf,
  renderCandidateLines,
  renderPlanLines,
  resolveOpenTarget,
  assetPathOf,
  isPreviewUnsupportedError,
  parseCreatePreview,
  type ActionOutcome,
  type CreateItemInput,
  type CreatePreviewData,
} from "../src/services/item-actions";
import { CreateItemModal, type CreateItemCallbacks } from "../src/modals/create-item-modal";
import { ConfirmationModal, TextPromptModal } from "../src/modals/confirmation-modal";
import { DeleteItemModal } from "../src/modals/delete-item-modal";
import { CliClient } from "../src/services/cli-client";
import { buildEnvelope, writeFakeCli } from "./fixtures/fake-paper-notes";

const mockState = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", () => {
  class ElStub {
    value = "";
    textContent = "";
    disabled = false;
    children: ElStub[] = [];
    listeners: Record<string, (event?: unknown) => void> = {};
    attrs: Record<string, string> = {};
    addEventListener(type: string, fn: () => void): void {
      this.listeners[type] = fn;
    }
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }
    addClass(_cls: string): void {}
    removeClass(_cls: string): void {}
    setText(text: string): void {
      this.textContent = text;
    }
    empty(): void {
      this.children = [];
    }
    createEl(_tag: string, opts: { cls?: string; text?: string } = {}): ElStub {
      const el = new ElStub();
      el.textContent = opts.text ?? "";
      this.children.push(el);
      return el;
    }
    createDiv(opts: { cls?: string; text?: string } = {}): ElStub {
      return this.createEl("div", opts);
    }
  }
  class ModalStub {
    app: unknown;
    contentEl: ElStub;
    titleEl: ElStub;
    modalEl: ElStub;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = new ElStub();
      this.titleEl = new ElStub();
      this.modalEl = new ElStub();
    }
    open(): void {
      this.onOpen?.();
    }
    close(): void {}
    onOpen?(): void {}
  }
  class NoticeStub {
    constructor(message: string) {
      mockState.notices.push(message);
    }
  }
  return { Modal: ModalStub, Notice: NoticeStub };
});

const NOTE_PATH = "05 Literature/alpha2024/alpha2024.md";

function successOutcome(overrides: Partial<ProtocolEnvelope> = {}): ActionOutcome {
  return { status: "success", envelope: buildEnvelope(overrides) };
}

function needsConfirmationOutcome(data: Record<string, unknown>, token = "tok"): ActionOutcome {
  return { status: "needs_confirmation", token, envelope: buildEnvelope({ status: "needs_confirmation", data }) };
}

interface IoSpy {
  write: (payload: unknown) => Promise<string>;
  remove: (path: string) => Promise<void>;
  payloads: unknown[];
  removed: string[];
}

function recordingIo(): IoSpy {
  const payloads: unknown[] = [];
  const removed: string[] = [];
  return {
    payloads,
    removed,
    write: vi.fn(async (payload: unknown) => {
      payloads.push(payload);
      return "/tmp/paper-notes-actions/payload.json";
    }),
    remove: vi.fn(async (path: string) => {
      removed.push(path);
    }),
  };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${rel}/`);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

type StubNode = { textContent: string; children: StubNode[] };

/** Depth-first text of a stubbed element tree (rendered lines may nest). */
function collectText(root: { children: StubNode[] }): string[] {
  const out: string[] = [];
  for (const child of root.children) {
    if (child.textContent.length > 0) {
      out.push(child.textContent);
    }
    out.push(...collectText(child));
  }
  return out;
}

describe("parseCreateInput", () => {
  it("accepts a bare DOI", () => {
    expect(parseCreateInput("10.1038/s41586-024-00000-0")).toEqual({
      kind: "identifier",
      field: "doi",
      value: "10.1038/s41586-024-00000-0",
    });
  });

  it("accepts a prefixed DOI", () => {
    expect(parseCreateInput("DOI: 10.1000/abc.123")).toEqual({
      kind: "identifier",
      field: "doi",
      value: "10.1000/abc.123",
    });
  });

  it("accepts a bare PMID and a prefixed one", () => {
    expect(parseCreateInput("12345678")).toEqual({
      kind: "identifier",
      field: "pmid",
      value: "12345678",
    });
    expect(parseCreateInput("PMID: 87654321")).toEqual({
      kind: "identifier",
      field: "pmid",
      value: "87654321",
    });
  });

  it("accepts a PMCID", () => {
    expect(parseCreateInput("PMC1234567")).toEqual({
      kind: "identifier",
      field: "pmcid",
      value: "PMC1234567",
    });
  });

  it("accepts an arXiv identifier", () => {
    expect(parseCreateInput("arXiv:2401.12345v2")).toEqual({
      kind: "identifier",
      field: "arxiv",
      value: "2401.12345v2",
    });
    expect(parseCreateInput("2401.12345")).toEqual({
      kind: "identifier",
      field: "arxiv",
      value: "2401.12345",
    });
  });

  it("accepts an https URL (checked before path classification)", () => {
    expect(parseCreateInput("https://doi.org/10.1000/abc")).toEqual({
      kind: "url",
      value: "https://doi.org/10.1000/abc",
    });
  });

  it("accepts a local PDF path with or without separators", () => {
    expect(parseCreateInput("/Users/me/Downloads/paper.pdf")).toEqual({
      kind: "pdf",
      path: "/Users/me/Downloads/paper.pdf",
    });
    expect(parseCreateInput("paper.pdf")).toEqual({
      kind: "pdf",
      path: "paper.pdf",
    });
  });

  it("rejects empty and unrecognized input", () => {
    expect(parseCreateInput("")).toEqual({ kind: "empty" });
    expect(parseCreateInput("   ")).toEqual({ kind: "empty" });
    expect(parseCreateInput("hello world")).toEqual({ kind: "unrecognized" });
  });
});

describe("buildCreateInput", () => {
  it("maps parsed kinds to CLI input flags", () => {
    expect(buildCreateInput({ kind: "identifier", field: "pmid", value: "123" })).toEqual({ pmid: "123" });
    expect(buildCreateInput({ kind: "url", value: "https://example.com/x" })).toEqual({
      url: "https://example.com/x",
    });
    expect(buildCreateInput({ kind: "pdf", path: "/tmp/a.pdf" })).toEqual({ pdf: "/tmp/a.pdf" });
  });

  it("returns undefined for empty and unrecognized input", () => {
    expect(buildCreateInput({ kind: "empty" })).toBeUndefined();
    expect(buildCreateInput({ kind: "unrecognized" })).toBeUndefined();
  });
});

describe("ItemActions.create / confirmCreate", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    vaultDir = mkdtempSync(join(tempDir, "vault-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs item create with identifier flags and the vault root", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({ doi: "10.1000/abc" });
    expect(outcome.status).toBe("success");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/abc",
    ]);
  });

  it("combines url and pdf flags in a stable order", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({ url: "https://doi.org/10.1000/x", pdf: "/tmp/a.pdf" });
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--url", "https://doi.org/10.1000/x",
      "--pdf", "/tmp/a.pdf",
    ]);
  });

  it("rejects a create call without any source", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({});
    expect(outcome).toMatchObject({ status: "error", code: "no_input" });
  });

  it("surfaces needs_confirmation with the token", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              confirmation_token: "tok-123",
              plan: { action: "create_with_confirmation", values: { title: "T" } },
              candidates: [],
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({ doi: "10.1000/abc" });
    expect(outcome.status).toBe("needs_confirmation");
    if (outcome.status === "needs_confirmation") {
      expect(outcome.token).toBe("tok-123");
    }
  });

  it("treats needs_confirmation without a token as an error outcome", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({ status: "needs_confirmation", data: { plan: {} } }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({ doi: "10.1000/abc" });
    expect(outcome).toMatchObject({ status: "error", code: "missing_token" });
  });

  it("resubmits create with the confirmed values file (deterministic token carrier)", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const io = recordingIo();
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir }, io);
    const outcome = await actions.confirmCreate({ doi: "10.1000/abc" }, { title: "Confirmed title" });
    expect(outcome.status).toBe("success");
    expect(io.payloads).toEqual([{ title: "Confirmed title" }]);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/abc",
      "--confirmed", "/tmp/paper-notes-actions/payload.json",
    ]);
    expect(io.removed).toEqual(["/tmp/paper-notes-actions/payload.json"]);
  });

  it("maps an error envelope to an error outcome without any fallback write", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "error",
            errors: [{ code: "user_error", message: "unrecognized DOI: 'nope'" }],
          }),
        ) + "\n",
      exitCode: 2,
    });
    const notePath = join(vaultDir, "05 Literature", "alpha2024", "alpha2024.md");
    mkdirSync(join(vaultDir, "05 Literature", "alpha2024"), { recursive: true });
    writeFileSync(notePath, "---\ntitle: keep\n---\n");
    const before = listFiles(vaultDir);
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.create({ doi: "10.1000/abc" });
    expect(outcome).toMatchObject({ status: "error", code: "user_error" });
    expect(listFiles(vaultDir)).toEqual(before);
    expect(readFileSync(notePath, "utf8")).toBe("---\ntitle: keep\n---\n");
  });
});

describe("ItemActions.previewCreate / confirmCreate (Phase P6 / C1 / C2 contract)", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-preview-test-"));
    vaultDir = mkdtempSync(join(tempDir, "vault-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates CLI arguments containing --dry-run and no --confirm-token", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const client = new CliClient(cliPath);
    const runSpy = vi.spyOn(client, "run");
    const actions = new ItemActions({ client, vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1000/test-preview" });
    expect(outcome.status).toBe("success");
    expect(runSpy).toHaveBeenCalledTimes(1);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/test-preview", "--dry-run",
    ]);
    expect(argv).toContain("--dry-run");
    expect(argv).not.toContain("--confirm-token");
  });

  it("combines identifier, url, and pdf flags with --dry-run", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const client = new CliClient(cliPath);
    const actions = new ItemActions({ client, vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({
      url: "https://doi.org/10.1000/test",
      pdf: "/tmp/article.pdf",
    });
    expect(outcome.status).toBe("success");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--url", "https://doi.org/10.1000/test",
      "--pdf", "/tmp/article.pdf", "--dry-run",
    ]);
    expect(argv).not.toContain("--confirm-token");
  });

  it("rejects previewCreate call without any source", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const client = new CliClient(cliPath);
    const runSpy = vi.spyOn(client, "run");
    const actions = new ItemActions({ client, vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({});
    expect(outcome).toMatchObject({ status: "error", code: "no_input" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("generates --confirmed payload and --dry-run when previewing with confirmed values", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const io = recordingIo();
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir }, io);
    const outcome = await actions.previewCreate(
      { doi: "10.1000/preview-confirmed" },
      { title: "Confirmed for preview" },
    );
    expect(outcome.status).toBe("success");
    expect(io.payloads).toEqual([{ title: "Confirmed for preview" }]);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/preview-confirmed",
      "--confirmed", "/tmp/paper-notes-actions/payload.json", "--dry-run",
    ]);
    expect(io.removed).toEqual(["/tmp/paper-notes-actions/payload.json"]);
  });

  it("parses needs_confirmation results preserving token, action, citation_key, plan, and candidates", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              confirmation_token: "preview-token-xyz-123",
              action: "create_with_confirmation",
              citation_key: "shiau2024",
              paper_id: "550e8400-e29b-41d4-a716-446655440000",
              path: "05 Literature/shiau2024/shiau2024.md",
              pdf_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              plan: {
                action: "create_with_confirmation",
                values: { title: "Spatially resolved analysis of lung adenocarcinoma" },
              },
              candidates: [
                { citation_key: "cand2023", title: "Earlier study" },
              ],
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1038/s41591" });
    expect(outcome.status).toBe("needs_confirmation");
    if (outcome.status === "needs_confirmation") {
      expect(outcome.token).toBe("preview-token-xyz-123");
      expect(outcome.envelope.data.action).toBe("create_with_confirmation");
      expect(outcome.envelope.data.citation_key).toBe("shiau2024");
      expect(outcome.envelope.data.paper_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(outcome.envelope.data.path).toBe("05 Literature/shiau2024/shiau2024.md");
      expect(outcome.envelope.data.pdf_sha256).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );

      const parsed: CreatePreviewData | undefined = parseCreatePreview(outcome);
      expect(parsed).toEqual({
        confirmation_token: "preview-token-xyz-123",
        action: "create_with_confirmation",
        citation_key: "shiau2024",
        paper_id: "550e8400-e29b-41d4-a716-446655440000",
        path: "05 Literature/shiau2024/shiau2024.md",
        pdf_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        plan: {
          action: "create_with_confirmation",
          values: { title: "Spatially resolved analysis of lung adenocarcinoma" },
        },
        candidates: [{ citation_key: "cand2023", title: "Earlier study" }],
      });
    }
  });

  it("parses duplicate_exists preview result allowing caller to identify existing paper", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              confirmation_token: "dup-tok-999",
              action: "duplicate_exists",
              citation_key: "existingPaper2024",
              paper_id: "uuid-dup",
              path: "05 Literature/existingPaper2024/existingPaper2024.md",
              pdf_sha256: "hash-dup",
              plan: { message: "Item already exists in library" },
              candidates: [],
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1000/existing" });
    expect(outcome.status).toBe("needs_confirmation");
    if (outcome.status === "needs_confirmation") {
      expect(outcome.token).toBe("dup-tok-999");
      const parsed = parseCreatePreview(outcome);
      expect(parsed?.action).toBe("duplicate_exists");
      expect(parsed?.citation_key).toBe("existingPaper2024");
      expect(parsed?.path).toBe("05 Literature/existingPaper2024/existingPaper2024.md");
    }
  });

  it("generates confirmCreate args with --confirmed and --confirm-token, and cleans up temp file in finally", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const io = recordingIo();
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir }, io);
    const outcome = await actions.confirmCreate(
      { doi: "10.1000/abc" },
      { title: "Confirmed Title", year: 2024 },
      "confirm-token-valid-456",
    );
    expect(outcome.status).toBe("success");
    expect(io.payloads).toEqual([{ title: "Confirmed Title", year: 2024 }]);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/abc",
      "--confirmed", "/tmp/paper-notes-actions/payload.json",
      "--confirm-token", "confirm-token-valid-456",
    ]);
    expect(io.removed).toEqual(["/tmp/paper-notes-actions/payload.json"]);
  });

  it("cleans up confirmCreate temp file even when CLI reports conflict error", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "conflict",
            errors: [
              {
                code: "confirmation_token_mismatch",
                message: "confirmation token does not match decision inputs",
              },
            ],
          }),
        ) + "\n",
      exitCode: 3,
    });
    const io = recordingIo();
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir }, io);
    const outcome = await actions.confirmCreate(
      { doi: "10.1000/abc" },
      { title: "Stale confirm" },
      "stale-token-123",
    );
    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({ status: "error", code: "confirmation_token_mismatch" });
    expect(io.removed).toEqual(["/tmp/paper-notes-actions/payload.json"]);
  });

  it("supports legacy confirmCreate call without confirmToken", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const io = recordingIo();
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir }, io);
    const outcome = await actions.confirmCreate(
      { doi: "10.1000/legacy" },
      { title: "Legacy Confirm" },
    );
    expect(outcome.status).toBe("success");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "create", "--vault", vaultDir, "--doi", "10.1000/legacy",
      "--confirmed", "/tmp/paper-notes-actions/payload.json",
    ]);
    expect(argv).not.toContain("--confirm-token");
    expect(io.removed).toEqual(["/tmp/paper-notes-actions/payload.json"]);
  });

  it("detects unsupported preview via JSON usage_error and never falls back to direct create", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "error",
            errors: [{ code: "usage_error", message: "unrecognized arguments: --dry-run" }],
          }),
        ) + "\n",
      exitCode: 2,
    });
    const client = new CliClient(cliPath);
    const runSpy = vi.spyOn(client, "run");
    const actions = new ItemActions({ client, vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1000/abc" });
    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({
      status: "error",
      code: "preview_unsupported",
    });
    expect((outcome as { message: string }).message).toContain("does not support preview");
    // CRITICAL: CLI was called exactly once with --dry-run; NEVER fell back to mutating create!
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain("--dry-run");
  });

  it("detects unsupported preview via stderr unrecognized arguments and never falls back to direct create", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stderr: "paper-notes: error: unrecognized arguments: --dry-run\n",
      stdoutRaw: "",
      exitCode: 2,
    });
    const client = new CliClient(cliPath);
    const runSpy = vi.spyOn(client, "run");
    const actions = new ItemActions({ client, vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1000/abc" });
    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({
      status: "error",
      code: "preview_unsupported",
    });
    // Never fell back to calling create without --dry-run
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain("--dry-run");
  });

  it("does not map normal domain errors (e.g. user_error) to preview_unsupported", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "error",
            errors: [{ code: "user_error", message: "unrecognized DOI: 'bad-doi'" }],
          }),
        ) + "\n",
      exitCode: 2,
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "bad-doi" });
    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({
      status: "error",
      code: "user_error",
      message: "unrecognized DOI: 'bad-doi'",
    });
    if (outcome.status === "error") {
      expect(outcome.code).not.toBe("preview_unsupported");
    }
  });

  it("treats needs_confirmation without a token as missing_token error in preview", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({ status: "needs_confirmation", data: { plan: {} } }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.previewCreate({ doi: "10.1000/abc" });
    expect(outcome).toMatchObject({ status: "error", code: "missing_token" });
  });

  it("isPreviewUnsupportedError returns true for usage_error and unrecognized arguments", () => {
    expect(
      isPreviewUnsupportedError({
        status: "error",
        code: "usage_error",
        message: "unrecognized arguments: --dry-run",
      }),
    ).toBe(true);
    expect(
      isPreviewUnsupportedError({
        status: "error",
        code: "preview_unsupported",
        message: "unsupported",
      }),
    ).toBe(true);
    expect(
      isPreviewUnsupportedError({
        status: "error",
        code: "cli_error",
        message: "CLI error: unrecognized option '--dry-run'",
      }),
    ).toBe(true);
    expect(
      isPreviewUnsupportedError({
        status: "error",
        code: "user_error",
        message: "unrecognized DOI: '10.1000/abc'",
      }),
    ).toBe(false);
    expect(
      isPreviewUnsupportedError({
        status: "success",
        envelope: buildEnvelope(),
      }),
    ).toBe(false);
  });

  it("parseCreatePreview returns undefined for non-needs_confirmation outcomes", () => {
    expect(
      parseCreatePreview({ status: "success", envelope: buildEnvelope() }),
    ).toBeUndefined();
    expect(
      parseCreatePreview({ status: "error", code: "no_input", message: "no input" }),
    ).toBeUndefined();
  });
});

describe("ItemActions.updateReadingStatus", () => {
  it("runs item update with a reading_status patch file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    try {
      const cliPath = writeFakeCli(tempDir, {});
      const io = recordingIo();
      const actions = new ItemActions(
        { client: new CliClient(cliPath), vaultRoot: "/tmp/vault" },
        io,
      );
      const outcome = await actions.updateReadingStatus("alpha2024", "reading");
      expect(outcome.status).toBe("success");
      expect(io.payloads).toEqual([{ reading_status: "reading" }]);
      const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
      expect(argv).toEqual([
        "--json", "item", "update", "--vault", "/tmp/vault", "--key", "alpha2024",
        "--patch", "/tmp/paper-notes-actions/payload.json",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never falls back to direct YAML edits when the CLI fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    try {
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
      const io = recordingIo();
      const actions = new ItemActions(
        { client: new CliClient(cliPath), vaultRoot: "/tmp/vault" },
        io,
      );
      const outcome = await actions.updateReadingStatus("alpha2024", "read");
      expect(outcome).toMatchObject({ status: "error", code: "duplicate_key" });
      expect(io.payloads).toEqual([{ reading_status: "read" }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("cycles reading status missing/unread → reading → read → unread", () => {
    // Missing frontmatter displays as unread; first click advances to reading.
    expect(nextReadingStatus(undefined)).toBe("reading");
    expect(nextReadingStatus("unread")).toBe("reading");
    expect(nextReadingStatus("reading")).toBe("read");
    expect(nextReadingStatus("read")).toBe("unread");
  });
});

describe("ItemActions.attachPdf", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    vaultDir = mkdtempSync(join(tempDir, "vault-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs item attach-pdf with key and file", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.attachPdf("alpha2024", "/tmp/paper.pdf");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "attach-pdf", "--vault", vaultDir, "--key", "alpha2024",
      "--file", "/tmp/paper.pdf",
    ]);
  });

  it("adds --supplementary when requested", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.attachPdf("alpha2024", "/tmp/supp.txt", true);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv[argv.length - 1]).toBe("--supplementary");
  });

  it("resubmits attach with --confirm-token when a replacement needs confirmation", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              action: "replace_pdf",
              confirmation_token: "attach-tok",
              plan: { message: "existing primary PDF differs" },
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const preview = await actions.attachPdf("alpha2024", "/tmp/paper.pdf");
    expect(preview.status).toBe("needs_confirmation");
    const token = preview.status === "needs_confirmation" ? preview.token : "";
    expect(token).toBe("attach-tok");

    const confirmCli = writeFakeCli(tempDir, {});
    const confirmActions = new ItemActions({ client: new CliClient(confirmCli), vaultRoot: vaultDir });
    const outcome = await confirmActions.confirmAttach("alpha2024", "/tmp/paper.pdf", token);
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "attach-pdf", "--vault", vaultDir, "--key", "alpha2024",
      "--file", "/tmp/paper.pdf", "--confirm-token", "attach-tok",
    ]);
  });
});

describe("ItemActions rename-key preview-first", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    vaultDir = mkdtempSync(join(tempDir, "vault-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("previews with --dry-run and returns the plan token", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              action: "rename_key",
              confirmation_token: "rename-tok",
              plan: { moves: ["05 Literature/alpha2024 → 05 Literature/beta2024"] },
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const preview = await actions.previewRenameKey("alpha2024", "beta2024");
    expect(preview.status).toBe("needs_confirmation");
    if (preview.status === "needs_confirmation") {
      expect(preview.token).toBe("rename-tok");
    }
  });

  it("confirms only with the token from the preview, never with --dry-run", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.confirmRenameKey("alpha2024", "beta2024", "rename-tok");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "rename-key", "--vault", vaultDir, "--key", "alpha2024",
      "--new-key", "beta2024", "--confirm-token", "rename-tok",
    ]);
    expect(argv).not.toContain("--dry-run");
  });
});

describe("ItemActions delete preview/confirm", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    vaultDir = mkdtempSync(join(tempDir, "vault-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("previews deletion with --dry-run", async () => {
    const cliPath = writeFakeCli(tempDir, {
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "needs_confirmation",
            data: {
              action: "delete",
              citation_key: "alpha2024",
              file_count: 3,
              total_bytes: 2048,
              occurrences: [],
              confirmation_token: "del-tok",
            },
          }),
        ) + "\n",
    });
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const preview = await actions.previewDelete("alpha2024");
    expect(preview.status).toBe("needs_confirmation");
    if (preview.status === "needs_confirmation") {
      expect(preview.token).toBe("del-tok");
    }
  });

  it("confirms deletion with --confirm-key and --confirm-token", async () => {
    const cliPath = writeFakeCli(tempDir, {});
    const actions = new ItemActions({ client: new CliClient(cliPath), vaultRoot: vaultDir });
    const outcome = await actions.confirmDelete("alpha2024", "alpha2024", "del-tok");
    const argv = (outcome as { envelope: ProtocolEnvelope }).envelope.data.argv as string[];
    expect(argv).toEqual([
      "--json", "item", "delete", "--vault", vaultDir, "--key", "alpha2024",
      "--confirm-key", "alpha2024", "--confirm-token", "del-tok",
    ]);
  });

  it("builds a deletion preview with count, size, and backlinks", () => {
    const preview = buildDeletePreview({
      citation_key: "alpha2024",
      file_count: 3,
      total_bytes: 2048,
      occurrences: [
        { path: "manuscript.md", kind: "citation", line: 12 },
        { path: "notes.md", kind: "wikilink" },
      ],
    });
    expect(preview).toEqual({
      key: "alpha2024",
      fileCount: 3,
      totalBytes: 2048,
      backlinkCount: 2,
      backlinkLines: ["citation: manuscript.md:12", "wikilink: notes.md"],
    });
  });

  it("formats byte sizes deterministically", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });

  it("requires the exact citation key (no trim, no case folding)", () => {
    expect(confirmKeyMatches("alpha2024", "alpha2024")).toBe(true);
    expect(confirmKeyMatches(" alpha2024", "alpha2024")).toBe(false);
    expect(confirmKeyMatches("alpha2024 ", "alpha2024")).toBe(false);
    expect(confirmKeyMatches("Alpha2024", "alpha2024")).toBe(false);
    expect(confirmKeyMatches("beta2024", "alpha2024")).toBe(false);
  });
});

describe("asset open targets (main/PDF/MinerU/Figure/cards)", () => {
  it("resolves the Canonical Paper Directory from a main-note path", () => {
    expect(paperDirectoryOf(NOTE_PATH)).toBe("05 Literature/alpha2024");
    expect(paperDirectoryOf("orphan.md")).toBe("");
  });

  it("resolves main, PDF, MinerU and Figure paths from the note path", () => {
    expect(resolveOpenTarget("main", NOTE_PATH)).toEqual({ kind: "main", path: NOTE_PATH });
    expect(resolveOpenTarget("pdf", NOTE_PATH)).toEqual({
      kind: "pdf",
      path: "05 Literature/alpha2024/alpha2024.pdf",
    });
    expect(resolveOpenTarget("minerU", NOTE_PATH)).toEqual({
      kind: "minerU",
      path: "05 Literature/alpha2024/minerUmd_alpha2024.md",
    });
    expect(resolveOpenTarget("figure", NOTE_PATH)).toEqual({
      kind: "figure",
      path: "05 Literature/alpha2024/Figure解读_alpha2024.md",
    });
    expect(assetPathOf("cards", NOTE_PATH)).toBe("05 Literature/alpha2024/cards");
  });

  it("opens cards by picking the first sorted card note", () => {
    expect(resolveOpenTarget("cards", NOTE_PATH, ["b.md", "a.md", "notes.txt"])).toEqual({
      kind: "cards",
      path: "05 Literature/alpha2024/cards/a.md",
    });
  });

  it("returns undefined for cards without any card note", () => {
    expect(resolveOpenTarget("cards", NOTE_PATH, [])).toBeUndefined();
    expect(resolveOpenTarget("cards", NOTE_PATH, ["notes.txt"])).toBeUndefined();
  });
});

describe("openCard (specific card note, Gate D R3 interface reservation)", () => {
  it("resolves one named card note under the paper cards directory", () => {
    expect(openCard(NOTE_PATH, "card-b.md")).toEqual({
      kind: "cards",
      path: "05 Literature/alpha2024/cards/card-b.md",
    });
  });

  it("rejects non-card names (no .md suffix)", () => {
    expect(openCard(NOTE_PATH, "notes.txt")).toBeUndefined();
    expect(openCard(NOTE_PATH, "card-b")).toBeUndefined();
  });

  it("rejects path-traversal card names (interface reservation guard)", () => {
    expect(openCard(NOTE_PATH, "../main.md")).toBeUndefined();
    expect(openCard(NOTE_PATH, "sub/card.md")).toBeUndefined();
  });

  it("keeps resolveOpenTarget(cards) on the same first-sorted-card path", () => {
    // The single-card quick-open path must stay compatible: it opens the
    // first sorted card note through the shared openCard() entry.
    expect(resolveOpenTarget("cards", NOTE_PATH, ["b.md", "a.md"])).toEqual(
      openCard(NOTE_PATH, "a.md"),
    );
  });
});

describe("confirmation plan rendering", () => {
  it("renders plan values as deterministic lines", () => {
    expect(renderPlanLines({ action: "create_with_confirmation", values: { title: "T" }, message: "check me" })).toEqual([
      "action: create_with_confirmation",
      "values.title: T",
      "message: check me",
    ]);
  });

  it("returns the plain string for string plans and nothing for empty plans", () => {
    expect(renderPlanLines("no-op")).toEqual(["no-op"]);
    expect(renderPlanLines(undefined)).toEqual([]);
  });

  it("renders fuzzy candidates with title/year/author/key", () => {
    expect(
      renderCandidateLines([
        { citation_key: "old2024", title: "Alpha cells", year: 2024, first_author: "Shiau", similarity: 0.9 },
        "junk",
      ]),
    ).toEqual(["Alpha cells (2024) — Shiau [old2024]", "\"junk\""]);
  });

  it("extracts confirmable values from a plan", () => {
    expect(confirmedValuesOf({ values: { title: "T" } })).toEqual({ title: "T" });
    expect(confirmedValuesOf({ message: "no values" })).toBeUndefined();
    expect(confirmedValuesOf(undefined)).toBeUndefined();
  });
});

describe("CreateItemModal wiring", () => {
  let app: App;
  let callbacks: CreateItemCallbacks;
  let previewCreateMock: ReturnType<typeof vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>>;
  let confirmCreateMock: ReturnType<
    typeof vi.fn<(input: CreateItemInput, confirmed: Record<string, unknown>, confirmToken?: string) => Promise<ActionOutcome>>
  >;
  let createMock: ReturnType<typeof vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>>;
  let confirmMock: ReturnType<
    typeof vi.fn<(input: CreateItemInput, confirmed: Record<string, unknown>, confirmToken?: string) => Promise<ActionOutcome>>
  >;
  let openExistingMock: ReturnType<typeof vi.fn<(pathOrKey: string) => void>>;
  let notifyMock: ReturnType<typeof vi.fn<(message: string) => void>>;
  let fileExistsMock: ReturnType<typeof vi.fn<(path: string) => boolean>>;

  beforeEach(() => {
    app = {} as App;
    previewCreateMock = vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>(async () =>
      needsConfirmationOutcome({
        confirmation_token: "preview-tok-default",
        action: "create",
        plan: {
          action: "create",
          values: { title: "Default Preview Title" },
        },
      }),
    );
    confirmCreateMock = vi.fn<
      (input: CreateItemInput, confirmed: Record<string, unknown>, confirmToken?: string) => Promise<ActionOutcome>
    >(async () => successOutcome({ data: { citation_key: "alpha2024" } }));
    createMock = vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>(async (_input) =>
      successOutcome({ data: { citation_key: "alpha2024" } }),
    );
    confirmMock = vi.fn<
      (input: CreateItemInput, confirmed: Record<string, unknown>, confirmToken?: string) => Promise<ActionOutcome>
    >(async () => successOutcome({ data: { citation_key: "alpha2024" } }));
    openExistingMock = vi.fn<(pathOrKey: string) => void>();
    notifyMock = vi.fn<(message: string) => void>();
    fileExistsMock = vi.fn<(path: string) => boolean>(() => true);
    callbacks = {
      previewCreate: previewCreateMock,
      confirmCreate: confirmCreateMock,
      create: createMock,
      confirm: confirmMock,
      openExisting: openExistingMock,
      notify: notifyMock,
      fileExists: fileExistsMock,
    };
    mockState.notices.length = 0;
  });

  function openModal(initialText = ""): CreateItemModal {
    const modal = new CreateItemModal(app, callbacks, initialText);
    modal.open();
    return modal;
  }

  function clickButton(btn: HTMLButtonElement | undefined): void {
    (btn as unknown as { listeners: Record<string, (event?: unknown) => void> })?.listeners["click"]?.(undefined);
  }

  it("submits an identifier input to previewCreate rather than mutating create", async () => {
    const modal = openModal("10.1000/abc");
    await modal.submit();
    expect(previewCreateMock).toHaveBeenCalledWith({ doi: "10.1000/abc" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("submits a URL and a local PDF path to previewCreate rather than create", async () => {
    const modal = openModal("https://doi.org/10.1000/x");
    await modal.submit();
    expect(previewCreateMock).toHaveBeenCalledWith({ url: "https://doi.org/10.1000/x" });
    expect(createMock).not.toHaveBeenCalled();

    const pdfModal = openModal("/Users/me/Downloads/paper.pdf");
    await pdfModal.submit();
    expect(previewCreateMock).toHaveBeenCalledWith({ pdf: "/Users/me/Downloads/paper.pdf" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a missing PDF file without calling previewCreate or create", async () => {
    fileExistsMock.mockReturnValue(false);
    const modal = openModal("/tmp/missing.pdf");
    await modal.submit();
    expect(previewCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("shows inline validation error for empty input without calling previewCreate or create", async () => {
    const modal = openModal("   ");
    await modal.submit();
    const error = (modal as unknown as { errorEl: { textContent: string } }).errorEl;
    expect(error.textContent).toContain("Enter an identifier");
    expect(previewCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("notifies instead of submitting empty or unrecognized input", async () => {
    const modal = openModal("   ");
    await modal.submit();
    expect(previewCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalled();

    const badModal = openModal("hello world");
    await badModal.submit();
    expect(previewCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("renders full metadata preview correctly: title/authors/journal/year/identifiers/abstract", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "tok-preview-1",
        action: "create",
        plan: {
          action: "create",
          message: "Ready to create item.",
          values: {
            title: "Spatially resolved transcriptomics",
            authors: [
              { family: "Stahl", given: "Patrik" },
              { family: "Salmen", given: "Fredrik" },
            ],
            journal: "Science",
            year: 2016,
            doi: "10.1126/science.aaf2403",
            pmid: "27365449",
            abstract: "Spatial transcriptomics provides quantitative gene expression data.",
          },
        },
      }),
    );
    const modal = openModal("10.1126/science.aaf2403");
    await modal.submit();

    expect(modal.mode).toBe("preview");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("可创建");
    expect(texts).toContain("Ready to create item.");
    expect(texts).toContain("Spatially resolved transcriptomics");
    expect(texts).toContain("Stahl Patrik; Salmen Fredrik");
    expect(texts).toContain("Science");
    expect(texts).toContain("2016");
    expect(texts.some((t) => t.includes("10.1126/science.aaf2403"))).toBe(true);
    expect(texts.some((t) => t.includes("27365449"))).toBe(true);
    expect(texts).toContain("Spatial transcriptomics provides quantitative gene expression data.");
    expect(modal.confirmButton).toBeDefined();
    expect(modal.confirmButton?.textContent).toBe("确认创建");
  });

  it("renders '缺失' label for missing metadata fields", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "tok-preview-2",
        action: "create_with_confirmation",
        plan: {
          action: "create_with_confirmation",
          values: {
            title: "Incomplete Metadata Paper",
          },
        },
      }),
    );
    const modal = openModal("10.1000/incomplete");
    await modal.submit();

    expect(modal.mode).toBe("preview");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("需确认");
    expect(texts).toContain("Incomplete Metadata Paper");
    expect(texts).toContain("缺失");
  });

  it("confirm button calls confirmCreate with matching token and confirmed payload", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome(
        {
          confirmation_token: "tok-preview-confirmed",
          plan: {
            action: "create_with_confirmation",
            values: { title: "Confirmed Title", year: 2024 },
          },
          candidates: [],
        },
        "tok-preview-confirmed",
      ),
    );
    const modal = openModal("10.1000/abc");
    await modal.submit();
    expect(modal.confirmButton).toBeDefined();

    clickButton(modal.confirmButton);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirmCreateMock).toHaveBeenCalledWith(
      { doi: "10.1000/abc" },
      { title: "Confirmed Title", year: 2024 },
      "tok-preview-confirmed",
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("alpha2024"));
  });

  it("cancel button closes modal with zero writes (never calls confirmCreate or create)", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "tok-cancel",
        plan: { action: "create", values: { title: "Cancelable Paper" } },
      }),
    );
    const modal = openModal("10.1000/abc");
    await modal.submit();
    expect(modal.cancelButton).toBeDefined();

    clickButton(modal.cancelButton);

    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("back button returns to input view with zero writes and preserves entered value", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "tok-back",
        plan: { action: "create", values: { title: "Back Paper" } },
      }),
    );
    const modal = openModal("10.1000/back-test");
    await modal.submit();
    expect(modal.mode).toBe("preview");
    expect(modal.backButton).toBeDefined();

    clickButton(modal.backButton);
    expect(modal.mode).toBe("input");
    expect(modal.inputEl.value).toBe("10.1000/back-test");
    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("duplicate_exists state displays '库中已有', suppresses confirm, and triggers openExisting", async () => {
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        action: "duplicate_exists",
        confirmation_token: "dup-tok-123",
        path: "05 Literature/existing2024/existing2024.md",
        citation_key: "existing2024",
        plan: {
          action: "duplicate_exists",
          path: "05 Literature/existing2024/existing2024.md",
          citation_key: "existing2024",
          message: "Item already exists in library with citation key 'existing2024'",
        },
      }),
    );
    const modal = openModal("10.1000/dup");
    await modal.submit();

    expect(modal.mode).toBe("preview");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("库中已有");
    expect(texts.some((t) => t.includes("Item already exists"))).toBe(true);

    // confirmButton is suppressed for duplicate_exists
    expect(modal.confirmButton).toBeUndefined();

    // openExistingButton is present and triggers openExisting callback
    expect(modal.openExistingButton).toBeDefined();
    expect(modal.openExistingButton?.textContent).toBe("打开已有文献");
    clickButton(modal.openExistingButton);

    expect(openExistingMock).toHaveBeenCalledWith("05 Literature/existing2024/existing2024.md");
    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("preview_unsupported displays upgrade notice and never falls back to create", async () => {
    previewCreateMock.mockResolvedValue({
      status: "error",
      code: "preview_unsupported",
      message: "paper-notes CLI does not support preview (--dry-run). Please upgrade the core CLI.",
    });
    const modal = openModal("10.1000/upgrade-test");
    await modal.submit();

    expect(modal.mode).toBe("error");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("预览不支持");
    expect(texts.some((t) => t.includes("升级") || t.includes("upgrade"))).toBe(true);
    expect(modal.retryButton).toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();
  });

  it("when callbacks only provide create without previewCreate, submit refuses to call create and enters preview_unsupported error state", async () => {
    callbacks = {
      create: createMock,
      confirmCreate: confirmCreateMock,
      notify: notifyMock,
      fileExists: fileExistsMock,
    };
    const modal = openModal("10.1000/fallback-test");
    await modal.submit();

    // Safety contract: direct create must NEVER be called even if previewCreate is omitted
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(modal.mode).toBe("error");

    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("预览不支持");
    expect(texts.some((t) => t.includes("升级") || t.includes("upgrade"))).toBe(true);
    expect(modal.retryButton).toBeUndefined();
  });

  it("metadata fetch failure displays error, allows retry, and never calls create or confirmCreate", async () => {
    previewCreateMock.mockResolvedValueOnce({
      status: "error",
      code: "network_error",
      message: "DOI resolution timed out",
    });
    const modal = openModal("10.1000/retry-test");
    await modal.submit();

    expect(modal.mode).toBe("error");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("元数据获取失败");
    expect(texts).toContain("DOI resolution timed out");
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();

    // Retry button is available
    expect(modal.retryButton).toBeDefined();
    expect(modal.retryButton?.textContent).toBe("重试");

    previewCreateMock.mockResolvedValueOnce(
      needsConfirmationOutcome({
        confirmation_token: "tok-retried",
        plan: { action: "create", values: { title: "Success After Retry" } },
      }),
    );
    clickButton(modal.retryButton);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(previewCreateMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(modal.mode).toBe("preview");
  });

  it("when preview rejects with an exception (preview failure), neither create nor confirmCreate is called", async () => {
    previewCreateMock.mockRejectedValue(new Error("CLI process spawn error"));
    const modal = openModal("10.1000/throw-err");
    await modal.submit();

    expect(modal.mode).toBe("error");
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("元数据获取失败");
    expect(texts.some((t) => t.includes("CLI process spawn error"))).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();
  });

  it("when user cancels from input mode, preview mode, or error mode, neither create nor confirmCreate is called", async () => {
    // 1. Cancel from initial input view
    const inputModal = openModal("10.1000/cancel-input");
    expect(inputModal.cancelButton).toBeDefined();
    clickButton(inputModal.cancelButton);
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();

    // 2. Cancel from preview view
    previewCreateMock.mockResolvedValueOnce(
      needsConfirmationOutcome({
        confirmation_token: "tok-cancel-test",
        plan: { action: "create", values: { title: "Cancel Test Paper" } },
      }),
    );
    const previewModal = openModal("10.1000/cancel-preview");
    await previewModal.submit();
    expect(previewModal.mode).toBe("preview");
    expect(previewModal.cancelButton).toBeDefined();
    clickButton(previewModal.cancelButton);
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();

    // 3. Cancel from error view
    previewCreateMock.mockResolvedValueOnce({
      status: "error",
      code: "network_error",
      message: "Gateway timeout",
    });
    const errorModal = openModal("10.1000/cancel-error");
    await errorModal.submit();
    expect(errorModal.mode).toBe("error");
    expect(errorModal.cancelButton).toBeDefined();
    clickButton(errorModal.cancelButton);
    expect(createMock).not.toHaveBeenCalled();
    expect(confirmCreateMock).not.toHaveBeenCalled();
  });

  it("prevents multiple confirm calls when confirm button is clicked repeatedly", async () => {
    let resolveConfirm!: (outcome: ActionOutcome) => void;
    confirmCreateMock.mockReturnValue(
      new Promise<ActionOutcome>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    previewCreateMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "tok-anti-double",
        plan: { action: "create", values: { title: "Single Submit" } },
      }),
    );
    const modal = openModal("10.1000/single");
    await modal.submit();
    expect(modal.confirmButton).toBeDefined();

    // Click confirm twice
    clickButton(modal.confirmButton);
    clickButton(modal.confirmButton);

    expect(confirmCreateMock).toHaveBeenCalledTimes(1);

    // Resolve confirm
    resolveConfirm(successOutcome({ data: { citation_key: "single2024" } }));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("suppresses late preview responses after modal is closed", async () => {
    let resolvePreview!: (outcome: ActionOutcome) => void;
    previewCreateMock.mockReturnValue(
      new Promise<ActionOutcome>((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const modal = openModal("10.1000/late");
    void modal.submit();

    // Modal closed while preview in flight
    modal.close();

    resolvePreview(
      needsConfirmationOutcome({
        confirmation_token: "tok-late",
        plan: { action: "create", values: { title: "Late Paper" } },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Remained in input mode, preview view was never rendered
    expect(modal.mode).toBe("input");
    expect(confirmCreateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("DeleteItemModal wiring", () => {
  let app: App;
  let confirm: (token: string) => void | Promise<void>;
  let notify: (message: string) => void;
  let preview: ReturnType<typeof vi.fn<() => Promise<ActionOutcome>>>;

  beforeEach(() => {
    app = {} as App;
    confirm = vi.fn<(token: string) => Promise<void>>(async () => {});
    notify = vi.fn<(message: string) => void>();
    preview = vi.fn<() => Promise<ActionOutcome>>();
  });

  function needsPreview(): ActionOutcome {
    return needsConfirmationOutcome({
      action: "delete",
      citation_key: "alpha2024",
      file_count: 3,
      total_bytes: 2048,
      occurrences: [{ path: "manuscript.md", kind: "citation", line: 12 }],
      confirmation_token: "del-tok",
    });
  }

  function modalTexts(modal: DeleteItemModal): string[] {
    return collectText(
      modal.contentEl as unknown as { children: StubNode[] },
    );
  }

  it("opens immediately in the scanning state with Delete disabled", async () => {
    preview.mockReturnValue(new Promise<ActionOutcome>(() => {}));
    const modal = new DeleteItemModal(app, { preview, confirm, notify });
    modal.open();
    expect(modal.deleteButton.disabled).toBe(true);
    expect(modal.deleteButton.textContent).toBe("Delete");
    const texts = modalTexts(modal);
    expect(texts.some((t) => /scanning files and references/i.test(t))).toBe(
      true,
    );
  });

  it("populates count/size/backlinks and enables Delete on a valid preview", async () => {
    preview.mockResolvedValue(needsPreview());
    const modal = new DeleteItemModal(app, { preview, confirm, notify });
    modal.open();
    await Promise.resolve();
    await Promise.resolve();
    const texts = modalTexts(modal);
    expect(texts).toContain("Files: 3");
    expect(texts).toContain("Size: 2.0 KB");
    expect(texts).toContain("References: 1");
    expect(texts.some((t) => /cannot be undone/i.test(t))).toBe(true);
    expect(texts.some((t) => /scanning/i.test(t))).toBe(false);
    expect(modal.deleteButton.disabled).toBe(false);
  });

  it("keeps Delete disabled and shows a readable error when the scan fails", async () => {
    preview.mockResolvedValue({
      status: "error",
      code: "cli_error",
      message: "vault locked",
    });
    const modal = new DeleteItemModal(app, { preview, confirm, notify });
    modal.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.deleteButton.disabled).toBe(true);
    const texts = modalTexts(modal);
    expect(texts.some((t) => /vault locked/i.test(t))).toBe(true);
    expect(texts.some((t) => t === "Cancel")).toBe(true);
  });

  it("never enables Delete without a needs_confirmation preview token", async () => {
    preview.mockResolvedValue(
      successOutcome({ data: { citation_key: "alpha2024" } }),
    );
    const modal = new DeleteItemModal(app, { preview, confirm, notify });
    modal.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.deleteButton.disabled).toBe(true);
    expect(
      modalTexts(modal).some((t) => /no deletion preview/i.test(t)),
    ).toBe(true);
  });

  it("final Delete runs exactly once with the preview token and disables controls", async () => {
    let resolveConfirm!: () => void;
    confirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    preview.mockResolvedValue(needsPreview());
    const modal = new DeleteItemModal(app, { preview, confirm, notify });
    modal.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.deleteButton.disabled).toBe(false);
    const deleteButton = modal.deleteButton as unknown as {
      listeners: Record<string, (event?: unknown) => void>;
    };
    deleteButton.listeners["click"]?.(undefined);
    // The CLI token flows back to the plugin's confirm path unchanged.
    expect(confirm).toHaveBeenCalledWith("tok");
    expect(modal.deleteButton.disabled).toBe(true);
    expect(modal.deleteButton.textContent).toBe("Deleting…");
    // Double-submit is impossible while deleting.
    deleteButton.listeners["click"]?.(undefined);
    expect(confirm).toHaveBeenCalledTimes(1);
    resolveConfirm();
    await Promise.resolve();
  });
});

describe("ConfirmationModal and TextPromptModal", () => {
  it("renders lines and invokes onConfirm exactly once", async () => {
    const app = {} as App;
    const onConfirm = vi.fn();
    const modal = new ConfirmationModal(
      app,
      { title: "Confirm", lines: ["move: a → b"], confirmLabel: "Proceed" },
      onConfirm,
    );
    modal.open();
    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("move: a → b");
    modal.confirm();
    modal.confirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("prompts for a text value and forwards it", () => {
    const app = {} as App;
    const onConfirm = vi.fn();
    const modal = new TextPromptModal(
      app,
      { title: "Rename key", placeholder: "new-key" },
      { confirm: onConfirm },
    );
    modal.open();
    modal.inputEl.value = "beta2024";
    modal.submit();
    expect(onConfirm).toHaveBeenCalledWith("beta2024");
  });
});

describe("CLI errors never cause direct YAML fallback writes", () => {
  it("leaves the vault byte-identical when the CLI is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paper-notes-actions-test-"));
    try {
      const vaultDir = mkdtempSync(join(tempDir, "vault-"));
      const notePath = join(vaultDir, "05 Literature", "alpha2024", "alpha2024.md");
      mkdirSync(join(vaultDir, "05 Literature", "alpha2024"), { recursive: true });
      writeFileSync(notePath, "---\ntitle: keep\n---\n");
      const before = listFiles(vaultDir);

      const actions = new ItemActions({
        client: new CliClient(join(tempDir, "does-not-exist.mjs")),
        vaultRoot: vaultDir,
      });
      const outcome = await actions.updateReadingStatus("alpha2024", "read");
      expect(outcome).toMatchObject({ status: "error", code: "not_found" });
      expect(listFiles(vaultDir)).toEqual(before);
      expect(readFileSync(notePath, "utf8")).toBe("---\ntitle: keep\n---\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
