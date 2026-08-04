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
  parseCreateInput,
  renderCandidateLines,
  renderPlanLines,
  resolveOpenTarget,
  assetPathOf,
  type ActionOutcome,
  type CreateItemInput,
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
    addEventListener(type: string, fn: () => void): void {
      this.listeners[type] = fn;
    }
    addClass(_cls: string): void {}
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

function needsConfirmationOutcome(data: Record<string, unknown>): ActionOutcome {
  return { status: "needs_confirmation", token: "tok", envelope: buildEnvelope({ status: "needs_confirmation", data }) };
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

  it("cycles reading status unset → unread → reading → read → unread", () => {
    expect(nextReadingStatus(undefined)).toBe("unread");
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
  let createMock: ReturnType<typeof vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>>;
  let confirmMock: ReturnType<typeof vi.fn<(input: CreateItemInput, confirmed: Record<string, unknown>) => Promise<ActionOutcome>>>;
  let notifyMock: ReturnType<typeof vi.fn<(message: string) => void>>;
  let fileExistsMock: ReturnType<typeof vi.fn<(path: string) => boolean>>;

  beforeEach(() => {
    app = {} as App;
    createMock = vi.fn<(input: CreateItemInput) => Promise<ActionOutcome>>(async (_input) =>
      successOutcome({ data: { citation_key: "alpha2024" } }),
    );
    confirmMock = vi.fn<(input: CreateItemInput, confirmed: Record<string, unknown>) => Promise<ActionOutcome>>(
      async () => successOutcome({ data: { citation_key: "alpha2024" } }),
    );
    notifyMock = vi.fn<(message: string) => void>();
    fileExistsMock = vi.fn<(path: string) => boolean>(() => true);
    callbacks = {
      create: createMock,
      confirm: confirmMock,
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

  it("submits an identifier input as item create input", async () => {
    const modal = openModal("10.1000/abc");
    await modal.submit();
    expect(createMock).toHaveBeenCalledWith({ doi: "10.1000/abc" });
  });

  it("submits a URL and a local PDF path", async () => {
    const modal = openModal("https://doi.org/10.1000/x");
    await modal.submit();
    expect(createMock).toHaveBeenCalledWith({ url: "https://doi.org/10.1000/x" });

    const pdfModal = openModal("/Users/me/Downloads/paper.pdf");
    await pdfModal.submit();
    expect(createMock).toHaveBeenCalledWith({ pdf: "/Users/me/Downloads/paper.pdf" });
  });

  it("rejects a missing PDF file without calling create", async () => {
    fileExistsMock.mockReturnValue(false);
    const modal = openModal("/tmp/missing.pdf");
    await modal.submit();
    expect(createMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("notifies instead of submitting empty or unrecognized input", async () => {
    const modal = openModal("   ");
    await modal.submit();
    expect(createMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalled();

    const badModal = openModal("hello world");
    await badModal.submit();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("shows needs_confirmation values and resubmits with the confirmed payload", async () => {
    createMock.mockResolvedValue(
      needsConfirmationOutcome({
        confirmation_token: "create-tok",
        plan: { action: "create_with_confirmation", values: { title: "Alpha" } },
        candidates: [],
      }),
    );
    const modal = openModal("10.1000/abc");
    await modal.submit();
    expect(modal.confirmationModal).toBeDefined();
    const confirmation = modal.confirmationModal as unknown as {
      contentEl: { children: StubNode[] };
    };
    const texts = collectText(confirmation.contentEl);
    expect(texts).toContain("values.title: Alpha");

    (modal.confirmationModal as unknown as { confirm: () => void }).confirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmMock).toHaveBeenCalledWith({ doi: "10.1000/abc" }, { title: "Alpha" });
  });
});

describe("DeleteItemModal wiring", () => {
  let app: App;
  let confirm: () => void | Promise<void>;
  let notify: (message: string) => void;

  beforeEach(() => {
    app = {} as App;
    confirm = vi.fn<() => Promise<void>>(async () => {});
    notify = vi.fn<(message: string) => void>();
  });

  it("shows count/size/backlinks and gates deletion on the exact key", async () => {
    const preview = buildDeletePreview({
      citation_key: "alpha2024",
      file_count: 3,
      total_bytes: 2048,
      occurrences: [{ path: "manuscript.md", kind: "citation", line: 12 }],
    });
    const modal = new DeleteItemModal(app, preview, { confirm, notify });
    modal.open();

    const texts = collectText(modal.contentEl as unknown as { children: StubNode[] });
    expect(texts).toContain("Files: 3");
    expect(texts).toContain("Size: 2.0 KB");
    expect(texts).toContain("References: 1");

    expect(modal.deleteButton.disabled).toBe(true);
    modal.keyInput.value = "Alpha2024";
    modal.updateDeleteEnabled();
    expect(modal.deleteButton.disabled).toBe(true);
    modal.keyInput.value = "alpha2024 ";
    modal.updateDeleteEnabled();
    expect(modal.deleteButton.disabled).toBe(true);

    modal.keyInput.value = "alpha2024";
    modal.updateDeleteEnabled();
    expect(modal.deleteButton.disabled).toBe(false);
    modal.confirmDelete();
    expect(confirm).toHaveBeenCalledTimes(1);
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
