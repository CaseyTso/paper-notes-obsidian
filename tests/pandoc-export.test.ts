/**
 * Focused Pandoc exporter (Task 29) — service, health and confirmation
 * modal tests.
 *
 * Covers `src/services/pandoc-export.ts` (pure export logic + process
 * orchestration), `src/services/export-health.ts` (preflight gates) and
 * `src/modals/export-confirmation-modal.ts` (thin Obsidian wrapper driven
 * through injected callbacks and the fake DOM in the `obsidian` runtime
 * mock).
 *
 * Behavior contract (plan Task 29 / design spec §14):
 * - Pandoc is spawned with an argv array, never a shell string; every
 *   configured path stays a single element even when it contains spaces.
 * - Markdown input keeps Pandoc citations intact.
 * - A generated CSL-JSON `library.json` (ids = current keys only), an
 *   alias Lua filter, `--citeproc` and the selected CSL style are passed.
 * - DOCX uses the configured reference DOCX when set; PDF uses the
 *   configured engine when set.
 * - The fixed global output directory must be configured and writable.
 * - An existing target requires explicit confirmation before overwrite.
 * - Output is written to a temporary file and atomically promoted only on
 *   exit code 0; nonzero exit preserves the previous artifact and surfaces
 *   stderr; cancel terminates the child and cleans the temp output.
 * - Unknown citation keys block the run before any spawn.
 * - Success offers open / show-in-Finder actions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { App } from "obsidian";

import type { PaperRecord } from "../src/types/paper";
import {
  aliasMapOf,
  buildAliasLuaFilter,
  buildExportArgs,
  checkCitationKeys,
  citationKeysInMarkdown,
  exportPandoc,
  exportSuccessActions,
  exportTargetPath,
  generateCslJson,
  isTypstEngine,
  runPandocExport,
  tempOutputFor,
  unknownCitationKeys,
  type ExportArgsConfig,
  type ExportFileSystem,
  type ExportPorts,
  type ExportRunResult,
  type OpenRevealActions,
  type PandocExportJob,
  type PandocProcess,
} from "../src/services/pandoc-export";
import {
  checkExportHealth,
  type ExportHealth,
  type ExportHealthInput,
} from "../src/services/export-health";
import {
  createExportConfirmationModal,
  type ExportConfirmationCallbacks,
  type ExportConfirmationProps,
} from "../src/modals/export-confirmation-modal";

const SMITH: PaperRecord = {
  path: "05 Literature/smith2024current/smith2024current.md",
  key: "smith2024current",
  paperId: "11111111-1111-4111-8111-111111111111",
  title: "A current paper on lung cancer",
  authors: [
    { family: "Smith", given: "John" },
    { family: "王", given: "芳" },
    { literal: "A Consortium" },
  ],
  journal: "Journal of Thoracic Disease",
  year: 2024,
  identifiers: { doi: "10.1000/xyz", pmid: "12345678", pmcid: "PMC9999999" },
  citationKeyAliases: ["oldSmith2020"],
  titleAliases: [],
};

const JONES: PaperRecord = {
  path: "05 Literature/jones2023/jones2023.md",
  key: "jones2023",
  paperId: "22222222-2222-4222-8222-222222222222",
  title: "An earlier paper",
  authors: [{ family: "Jones", given: "Mary" }],
  journal: "Chest",
  year: 2023,
  identifiers: {},
  citationKeyAliases: [],
  titleAliases: [],
};

const DOCX_ARGS_CONFIG: ExportArgsConfig = {
  format: "docx",
  pandocPath: "/opt/bin/pandoc",
  markdownPath: "/vault dir/manuscript file.md",
  tempOutputPath: "/exports/.manuscript file.docx.abc123.tmp",
  outputPath: "/exports/manuscript file.docx",
  bibliographyPath: "/tmp/work/library.json",
  aliasFilterPath: "/tmp/work/alias.lua",
  cslPath: "/vault dir/.paper-notes/csl/ama style.csl",
  referenceDocx: "/path with spaces/reference document.docx",
  pdfEngine: "",
};

const PDF_ARGS_CONFIG: ExportArgsConfig = {
  ...DOCX_ARGS_CONFIG,
  format: "pdf",
  tempOutputPath: "/exports/.manuscript file.pdf.abc123.tmp",
  outputPath: "/exports/manuscript file.pdf",
  referenceDocx: "",
  pdfEngine: "/opt/engines/weasyprint",
};

/** PDF job whose engine is typst — takes the two-step path (Repair R10). */
const TYPST_ARGS_CONFIG: ExportArgsConfig = {
  ...DOCX_ARGS_CONFIG,
  format: "pdf",
  tempOutputPath: "/exports/.manuscript file.pdf.abc123.tmp",
  outputPath: "/exports/manuscript file.pdf",
  referenceDocx: "",
  pdfEngine: "/opt/homebrew/bin/typst",
};

// ---------------------------------------------------------------------------
// Fake process / ports used by the orchestration tests.
// ---------------------------------------------------------------------------

class FakePandocProcess {
  exitCode: number | null = null;
  killed = false;
  private listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  private stdoutListeners: Array<(chunk: Buffer) => void> = [];
  private stderrListeners: Array<(chunk: Buffer) => void> = [];

  stdout = {
    on: (_event: string, cb: (chunk: Buffer) => void): void => {
      this.stdoutListeners.push(cb);
    },
  };
  stderr = {
    on: (_event: string, cb: (chunk: Buffer) => void): void => {
      this.stderrListeners.push(cb);
    },
  };

  on(event: string, cb: (arg?: unknown) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  kill = vi.fn((_signal?: string): boolean => {
    this.killed = true;
    return true;
  });

  emitStdout(text: string): void {
    for (const cb of this.stdoutListeners) cb(Buffer.from(text, "utf8"));
  }

  emitStderr(text: string): void {
    for (const cb of this.stderrListeners) cb(Buffer.from(text, "utf8"));
  }

  emitError(error: Error): void {
    for (const cb of this.listeners["error"] ?? []) cb(error);
  }

  emitClose(code: number | null): void {
    this.exitCode = code;
    for (const cb of this.listeners["close"] ?? []) cb(code);
  }
}

interface FakeFsState {
  files: Map<string, string>;
  ops: string[];
}

function makeFakeFs(seed: Array<[string, string]> = []): {
  fs: ExportFileSystem;
  state: FakeFsState;
} {
  const files = new Map<string, string>(seed);
  const ops: string[] = [];
  let mkdtempCount = 0;
  const fs: ExportFileSystem = {
    async mkdtemp(prefix: string): Promise<string> {
      mkdtempCount += 1;
      const path = `/tmp/${prefix}${mkdtempCount}`;
      ops.push(`mkdtemp:${path}`);
      return path;
    },
    async writeText(path: string, content: string): Promise<void> {
      ops.push(`write:${path}`);
      files.set(path, content);
    },
    async rename(from: string, to: string): Promise<void> {
      ops.push(`rename:${from}->${to}`);
      const content = files.get(from);
      if (content !== undefined) {
        files.set(to, content);
        files.delete(from);
      }
    },
    async unlink(path: string): Promise<void> {
      ops.push(`unlink:${path}`);
      files.delete(path);
    },
    async rmRecursive(path: string): Promise<void> {
      ops.push(`rm:${path}`);
      files.delete(path);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
  };
  return { fs, state: { files, ops } };
}

function makeFakePorts(seed: Array<[string, string]> = []): {
  ports: ExportPorts;
  runner: ReturnType<typeof vi.fn>;
  state: FakeFsState;
  process: FakePandocProcess;
} {
  const { fs, state } = makeFakeFs(seed);
  const process = new FakePandocProcess();
  const runner = vi.fn(
    (_command: string, _args: string[], _options: { cwd: string }) => {
      return process as unknown as PandocProcess;
    },
  );
  return { ports: { runner, fs }, runner, state, process };
}

function lastRenameTo(finalTarget: string, ops: string[]): string | undefined {
  return ops
    .filter((op) => op.startsWith(`rename:`) && op.endsWith(`->${finalTarget}`))
    .pop();
}

function baseJob(overrides: Partial<PandocExportJob> = {}): PandocExportJob {
  return {
    format: "docx",
    baseName: "manuscript file",
    markdown: "Text citing [@oldSmith2020] here.\n",
    markdownPath: "/vault dir/manuscript file.md",
    exportDirectory: "/exports",
    pandocPath: "/opt/bin/pandoc",
    pdfEngine: "",
    cslPath: "/vault dir/.paper-notes/csl/ama style.csl",
    referenceDocx: "/path with spaces/reference document.docx",
    records: [SMITH, JONES],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateCslJson
// ---------------------------------------------------------------------------

describe("generateCslJson", () => {
  it("emits current keys as ids and never emits aliases as ids", () => {
    const items = JSON.parse(generateCslJson([SMITH])) as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["smith2024current"]);
    expect(items.some((item) => item.id === "oldSmith2020")).toBe(false);
  });

  it("maps title, authors (incl. literal), journal, year and identifiers", () => {
    const item = (
      JSON.parse(generateCslJson([SMITH])) as Array<Record<string, unknown>>
    )[0];
    expect(item["title"]).toBe("A current paper on lung cancer");
    expect(item["container-title"]).toBe("Journal of Thoracic Disease");
    expect(item["issued"]).toEqual({ "date-parts": [[2024]] });
    expect(item["DOI"]).toBe("10.1000/xyz");
    expect(item["PMID"]).toBe("12345678");
    expect(item["PMCID"]).toBe("PMC9999999");
    expect(item["author"]).toContainEqual({ family: "Smith", given: "John" });
    expect(item["author"]).toContainEqual({ literal: "A Consortium" });
  });

  it("skips absent optional fields", () => {
    const item = (
      JSON.parse(generateCslJson([JONES])) as Array<Record<string, unknown>>
    )[0];
    expect(item["container-title"]).toBe("Chest");
    expect(item["DOI"]).toBeUndefined();
    expect(item["PMID"]).toBeUndefined();
    expect(item["issued"]).toEqual({ "date-parts": [[2023]] });
  });

  it("maps the full canonical bibliography like the core CSL layer", () => {
    const full: PaperRecord = {
      path: "05 Literature/full2024/full2024.md",
      key: "full2024",
      paperId: "550e8400-e29b-41d4-a716-446655440000",
      title: "Full paper",
      authors: [
        { family: "Smith", given: "J." },
        { literal: "Study Group" },
      ],
      itemType: "preprint",
      journal: "Journal of Tests",
      journalAbbreviation: "J Tests",
      publicationDate: "2024-05-01",
      year: 2024,
      volume: "12",
      issue: "3",
      pages: "100-110",
      url: "https://doi.org/10.1000/full",
      issn: ["1234-5678", "8765-4321"],
      language: "en",
      identifiers: { doi: "10.1000/full", arxiv: "2401.00001" },
      citationKeyAliases: [],
      titleAliases: [],
      abstract: "An abstract",
    };
    const item = (JSON.parse(generateCslJson([full])) as Array<Record<string, unknown>>)[0];
    expect(item["type"]).toBe("preprint");
    expect(item["container-title"]).toBe("Journal of Tests");
    expect(item["container-title-short"]).toBe("J Tests");
    expect(item["issued"]).toEqual({ "date-parts": [[2024, 5, 1]] });
    expect(item["volume"]).toBe("12");
    expect(item["issue"]).toBe("3");
    expect(item["page"]).toBe("100-110");
    expect(item["URL"]).toBe("https://doi.org/10.1000/full");
    expect(item["ISSN"]).toEqual(["1234-5678", "8765-4321"]);
    expect(item["language"]).toBe("en");
    expect(item["arXiv"]).toBe("2401.00001");
    expect(item["abstract"]).toBe("An abstract");
  });

  it("sorts records by key and keeps ids unique", () => {
    const items = JSON.parse(generateCslJson([JONES, SMITH])) as Array<{
      id: string;
    }>;
    expect(items.map((item) => item.id)).toEqual(["jones2023", "smith2024current"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
});

// ---------------------------------------------------------------------------
// buildAliasLuaFilter / aliasMapOf
// ---------------------------------------------------------------------------

describe("aliasMapOf", () => {
  it("maps each alias to its record's current key", () => {
    expect(aliasMapOf([SMITH, JONES])).toEqual({ oldSmith2020: "smith2024current" });
  });

  it("ignores aliases equal to the current key", () => {
    const record = { ...SMITH, citationKeyAliases: ["smith2024current", "dup"] };
    expect(aliasMapOf([record])).toEqual({ dup: "smith2024current" });
  });
});

describe("buildAliasLuaFilter", () => {
  it("generates a Lua table mapping aliases to current keys", () => {
    const lua = buildAliasLuaFilter({ oldSmith2020: "smith2024current" });
    expect(lua).toContain('["oldSmith2020"] = "smith2024current"');
    expect(lua).toContain("function Cite(cite)");
    expect(lua).toContain("c.id = current");
  });

  it("escapes quotes and backslashes in keys and values", () => {
    const lua = buildAliasLuaFilter({ 'we"ird\\key': 'cur"rent\\key' });
    expect(lua).toContain('["we\\"ird\\\\key"] = "cur\\"rent\\\\key"');
  });

  it("skips alias === current entries and still emits valid Lua for empty maps", () => {
    const lua = buildAliasLuaFilter({ same: "same" });
    expect(lua).toContain("local aliases = {");
    expect(lua).not.toContain('["same"]');
    expect(buildAliasLuaFilter({})).toContain("local aliases = {");
  });
});

// ---------------------------------------------------------------------------
// Citation scanning / gating
// ---------------------------------------------------------------------------

describe("citationKeysInMarkdown", () => {
  it("extracts a plain [@key] citation", () => {
    expect(citationKeysInMarkdown("Text [@smith2024current] here.")).toEqual([
      "smith2024current",
    ]);
  });

  it("extracts every key of a multi-citation group", () => {
    expect(citationKeysInMarkdown("Both [@a; @b] cited.")).toEqual(["a", "b"]);
  });

  it("extracts keys with prefixes and suffixes", () => {
    expect(citationKeysInMarkdown("See [@smith2024current, p. 3]")).toEqual([
      "smith2024current",
    ]);
  });

  it("deduplicates repeated keys", () => {
    expect(
      citationKeysInMarkdown("[@k] and again [@k] and [@k2]"),
    ).toEqual(["k", "k2"]);
  });

  it("ignores citations inside fenced code and inline code", () => {
    const md = [
      "Real text [@realKey].",
      "",
      "```",
      "[@unknownInFence]",
      "```",
      "",
      "Inline `[@unknownInline]` stays.",
    ].join("\n");
    expect(citationKeysInMarkdown(md)).toEqual(["realKey"]);
  });
});

describe("unknownCitationKeys / checkCitationKeys", () => {
  it("accepts current keys and aliases; flags everything else", () => {
    const md = "Cite [@smith2024current], alias [@oldSmith2020], bad [@nope].";
    expect(unknownCitationKeys(md, [SMITH], aliasMapOf([SMITH]))).toEqual([
      "nope",
    ]);
    expect(checkCitationKeys(md, [SMITH], aliasMapOf([SMITH]))).toEqual({
      ok: false,
      unknownKeys: ["nope"],
    });
  });

  it("returns ok when every key is known", () => {
    const md = "Cite [@smith2024current] and alias [@oldSmith2020].";
    expect(
      checkCitationKeys(md, [SMITH], aliasMapOf([SMITH])),
    ).toEqual({ ok: true });
  });

  it("sorts unknown keys deterministically", () => {
    const md = "Bad [@zebra] and [@alpha].";
    expect(unknownCitationKeys(md, [SMITH], {})).toEqual(["alpha", "zebra"]);
  });
});

// ---------------------------------------------------------------------------
// exportTargetPath / tempOutputFor
// ---------------------------------------------------------------------------

describe("exportTargetPath", () => {
  it("joins the export directory, base name and extension", () => {
    expect(exportTargetPath("/exports", "manuscript file", "docx")).toBe(
      "/exports/manuscript file.docx",
    );
    expect(exportTargetPath("/exports", "manuscript", "pdf")).toBe(
      "/exports/manuscript.pdf",
    );
  });

  it("sanitizes path-hostile characters in the base name", () => {
    const target = exportTargetPath("/exports", "../evil:name?", "docx");
    // No `..` path segment may survive sanitization (no directory escape),
    // and the base-name portion may not introduce a separator.
    expect(target.split("/")).not.toContain("..");
    expect(target).not.toMatch(/^\/exports\/\.\./);
    expect(target.endsWith(".docx")).toBe(true);
  });

  it("falls back to 'export' for an empty base name", () => {
    expect(exportTargetPath("/exports", "   ", "pdf")).toBe("/exports/export.pdf");
  });
});

describe("tempOutputFor", () => {
  it("places the temp file in the same directory as the final target", () => {
    const temp = tempOutputFor({
      exportDirectory: "/exports",
      baseName: "manuscript",
      format: "docx",
      nonce: "abc123",
    });
    expect(temp.startsWith("/exports/.")).toBe(true);
    expect(temp.endsWith(".tmp")).toBe(true);
    expect(temp.endsWith(".abc123.tmp")).toBe(true);
    expect(temp).not.toContain("manuscript.docx");
  });

  it("generates a unique nonce when none is provided", () => {
    const a = tempOutputFor({
      exportDirectory: "/exports",
      baseName: "manuscript",
      format: "docx",
    });
    const b = tempOutputFor({
      exportDirectory: "/exports",
      baseName: "manuscript",
      format: "docx",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith("/exports/.")).toBe(true);
    expect(b.startsWith("/exports/.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTypstEngine (two-step PDF detection, Repair R10)
// ---------------------------------------------------------------------------

describe("isTypstEngine", () => {
  it("detects the typst engine by basename (absolute path)", () => {
    expect(isTypstEngine("/opt/homebrew/bin/typst")).toBe(true);
  });

  it("detects a bare name and case variants", () => {
    expect(isTypstEngine("typst")).toBe(true);
    expect(isTypstEngine("Typst")).toBe(true);
  });

  it("rejects non-typst engines and empty values", () => {
    expect(isTypstEngine("/opt/engines/weasyprint")).toBe(false);
    expect(isTypstEngine("xelatex")).toBe(false);
    expect(isTypstEngine("")).toBe(false);
  });

  it("keys on the basename only, never the directory", () => {
    expect(isTypstEngine("/opt/typst-bundles/weasyprint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildExportArgs
// ---------------------------------------------------------------------------

describe("buildExportArgs", () => {
  it("builds the full DOCX argv with paths intact (never space-split)", () => {
    const args = buildExportArgs(DOCX_ARGS_CONFIG);
    expect(args).toEqual([
      "--from",
      "markdown",
      "--to",
      "docx",
      "-o",
      "/exports/.manuscript file.docx.abc123.tmp",
      "--lua-filter",
      "/tmp/work/alias.lua",
      "--citeproc",
      "--bibliography",
      "/tmp/work/library.json",
      "--csl",
      "/vault dir/.paper-notes/csl/ama style.csl",
      "--reference-doc",
      "/path with spaces/reference document.docx",
      "/vault dir/manuscript file.md",
    ]);
  });

  it("places the Lua filter before --citeproc so aliases resolve first", () => {
    const args = buildExportArgs(DOCX_ARGS_CONFIG);
    const luaIndex = args.indexOf("--lua-filter");
    const citeprocIndex = args.indexOf("--citeproc");
    expect(luaIndex).toBeGreaterThanOrEqual(0);
    expect(citeprocIndex).toBeGreaterThan(luaIndex);
  });

  it("omits --reference-doc when no reference DOCX is configured", () => {
    const args = buildExportArgs({ ...DOCX_ARGS_CONFIG, referenceDocx: "" });
    expect(args).not.toContain("--reference-doc");
    expect(args).toContain("/vault dir/manuscript file.md");
  });

  it("uses the configured PDF engine for PDF output", () => {
    const args = buildExportArgs(PDF_ARGS_CONFIG);
    expect(args).toContain("--pdf-engine");
    expect(args).toContain("/opt/engines/weasyprint");
    expect(args).not.toContain("--reference-doc");
    expect(args[args.indexOf("--to") + 1]).toBe("pdf");
  });

  it("typst: targets typst source, drops --pdf-engine (two-step R10)", () => {
    const args = buildExportArgs(TYPST_ARGS_CONFIG);
    expect(args[args.indexOf("--to") + 1]).toBe("typst");
    expect(args[args.indexOf("-o") + 1]).toBe(
      `${TYPST_ARGS_CONFIG.tempOutputPath}.typ`,
    );
    expect(args).not.toContain("--pdf-engine");
    expect(args).not.toContain("/opt/homebrew/bin/typst");
  });

  it("typst: keeps lua filter/citeproc/csl/bibliography arguments", () => {
    const args = buildExportArgs(TYPST_ARGS_CONFIG);
    expect(args.indexOf("--citeproc")).toBeGreaterThan(
      args.indexOf("--lua-filter"),
    );
    expect(args[args.indexOf("--csl") + 1]).toBe(
      "/vault dir/.paper-notes/csl/ama style.csl",
    );
    expect(args[args.indexOf("--bibliography") + 1]).toBe(
      "/tmp/work/library.json",
    );
    expect(args[args.length - 1]).toBe("/vault dir/manuscript file.md");
  });

  it("omits --pdf-engine when none is configured", () => {
    const args = buildExportArgs({ ...PDF_ARGS_CONFIG, pdfEngine: "" });
    expect(args).not.toContain("--pdf-engine");
  });
});

// ---------------------------------------------------------------------------
// runPandocExport
// ---------------------------------------------------------------------------

describe("runPandocExport", () => {
  const runOptions = () => ({
    config: DOCX_ARGS_CONFIG,
    workDir: "/tmp/work",
    libraryJson: JSON.stringify([{ id: "smith2024current" }]),
    aliasFilterLua: buildAliasLuaFilter({ oldSmith2020: "smith2024current" }),
  });

  it("writes library.json and the alias filter into the work directory", async () => {
    const { ports, state, process } = makeFakePorts();
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await promise;

    expect(state.ops).toContain("write:/tmp/work/library.json");
    expect(state.ops).toContain("write:/tmp/work/alias.lua");
    expect(state.files.get("/tmp/work/library.json")).toContain(
      "smith2024current",
    );
  });

  it("spawns pandoc with the argv array and the markdown directory as cwd", async () => {
    const { ports, runner, process } = makeFakePorts();
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await promise;

    const [command, args, options] = runner.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(command).toBe("/opt/bin/pandoc");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(buildExportArgs(DOCX_ARGS_CONFIG));
    expect(options.cwd).toBe("/vault dir");
  });

  it("promotes the temp target only on exit code 0", async () => {
    const { ports, state, process } = makeFakePorts();
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    const result = await promise;

    expect(result.status).toBe("success");
    expect(result.targetPath).toBe(DOCX_ARGS_CONFIG.outputPath);
    const rename = lastRenameTo(DOCX_ARGS_CONFIG.outputPath, state.ops);
    expect(rename).toBeDefined();
    expect(rename).toContain(DOCX_ARGS_CONFIG.tempOutputPath);
    expect(state.ops.some((op) => op.startsWith("unlink:"))).toBe(false);
  });

  it("keeps the previous artifact and shows stderr on nonzero exit", async () => {
    const { ports, state, process } = makeFakePorts([
      [DOCX_ARGS_CONFIG.outputPath, "previous artifact"],
    ]);
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitStderr("pandoc: unknown option --bogus\n");
    process.emitClose(1);
    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option");
    expect(state.files.get(DOCX_ARGS_CONFIG.outputPath)).toBe("previous artifact");
    expect(lastRenameTo(DOCX_ARGS_CONFIG.outputPath, state.ops)).toBeUndefined();
    expect(state.ops).toContain(`unlink:${DOCX_ARGS_CONFIG.tempOutputPath}`);
  });

  it("treats exit 0 with stderr noise as success", async () => {
    const { ports, process } = makeFakePorts();
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitStderr("warning: nothing to worry about\n");
    process.emitClose(0);
    const result = await promise;
    expect(result.status).toBe("success");
    expect(result.stderr).toContain("nothing to worry about");
  });

  it("cancel kills the child and cleans the temp output", async () => {
    const { ports, state, process } = makeFakePorts();
    const controller = new AbortController();
    const promise = runPandocExport(
      { ...runOptions(), signal: controller.signal },
      ports,
    );
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state.ops).toContain(`unlink:${DOCX_ARGS_CONFIG.tempOutputPath}`);
    expect(lastRenameTo(DOCX_ARGS_CONFIG.outputPath, state.ops)).toBeUndefined();
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const { ports, state, process } = makeFakePorts();
    const controller = new AbortController();
    controller.abort();
    const result = await runPandocExport(
      { ...runOptions(), signal: controller.signal },
      ports,
    );
    expect(result.status).toBe("cancelled");
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state.ops).toContain(`unlink:${DOCX_ARGS_CONFIG.tempOutputPath}`);
  });

  it("reports a spawn error as a failure with a message", async () => {
    const { ports, process } = makeFakePorts();
    const promise = runPandocExport(runOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitError(new Error("ENOENT: no such file"));
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("ENOENT");
  });

  // -------------------------------------------------------------------------
  // Two-step typst PDF path (Repair R10): pandoc emits typst source, then the
  // configured typst binary compiles it. Both steps must exit 0 before the
  // PDF is atomically promoted.
  // -------------------------------------------------------------------------

  const typstRunOptions = () => ({
    config: TYPST_ARGS_CONFIG,
    workDir: "/tmp/work",
    libraryJson: JSON.stringify([{ id: "smith2024current" }]),
    aliasFilterLua: buildAliasLuaFilter({ oldSmith2020: "smith2024current" }),
  });

  it("typst: runs pandoc then typst, promoting the PDF only when both exit 0", async () => {
    const { ports, runner, state, process } = makeFakePorts();
    const promise = runPandocExport(typstRunOptions(), ports);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

    const [pandocCommand, pandocArgs] = runner.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(pandocCommand).toBe("/opt/bin/pandoc");
    expect(pandocArgs[pandocArgs.indexOf("--to") + 1]).toBe("typst");
    expect(pandocArgs).not.toContain("--pdf-engine");
    process.emitClose(0);

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    const [typstCommand, typstArgs, typstOptions] = runner.mock.calls[1] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(typstCommand).toBe("/opt/homebrew/bin/typst");
    // typst 0.15 CLI contract: explicit `compile` subcommand, positional
    // output (semantic update from the card's `typst <input> -o <output>`
    // sketch — neither subcommand-less nor `-o` forms are accepted on 0.15).
    expect(typstArgs).toEqual([
      "compile",
      `${TYPST_ARGS_CONFIG.tempOutputPath}.typ`,
      `${TYPST_ARGS_CONFIG.tempOutputPath}.pdf`,
    ]);
    expect(typstOptions.cwd).toBe("/vault dir");
    process.emitClose(0);

    const result = await promise;
    expect(result.status).toBe("success");
    expect(result.targetPath).toBe(TYPST_ARGS_CONFIG.outputPath);
    const rename = lastRenameTo(TYPST_ARGS_CONFIG.outputPath, state.ops);
    expect(rename).toBeDefined();
    expect(rename).toContain(`${TYPST_ARGS_CONFIG.tempOutputPath}.pdf`);
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.typ`);
  });

  it("typst: a failing pandoc step preserves the artifact and never spawns typst", async () => {
    const { ports, runner, state, process } = makeFakePorts([
      [TYPST_ARGS_CONFIG.outputPath, "previous artifact"],
    ]);
    const promise = runPandocExport(typstRunOptions(), ports);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    process.emitStderr("pandoc: cannot write typst source\n");
    process.emitClose(1);
    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot write typst source");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(state.files.get(TYPST_ARGS_CONFIG.outputPath)).toBe("previous artifact");
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.typ`);
    expect(lastRenameTo(TYPST_ARGS_CONFIG.outputPath, state.ops)).toBeUndefined();
  });

  it("typst: a failing typst step surfaces stderr and cleans both temps", async () => {
    const { ports, state, process } = makeFakePorts([
      [TYPST_ARGS_CONFIG.outputPath, "previous artifact"],
    ]);
    const promise = runPandocExport(typstRunOptions(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(2));
    process.emitStderr("error: font fallback list must not be empty\n");
    process.emitClose(2);
    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("font fallback list must not be empty");
    expect(state.files.get(TYPST_ARGS_CONFIG.outputPath)).toBe("previous artifact");
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.typ`);
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.pdf`);
    expect(lastRenameTo(TYPST_ARGS_CONFIG.outputPath, state.ops)).toBeUndefined();
  });

  it("typst: cancel during the typst step kills the child and cleans both temps", async () => {
    const { ports, state, process } = makeFakePorts();
    const controller = new AbortController();
    const promise = runPandocExport(
      { ...typstRunOptions(), signal: controller.signal },
      ports,
    );
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(2));
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.typ`);
    expect(state.ops).toContain(`unlink:${TYPST_ARGS_CONFIG.tempOutputPath}.pdf`);
    expect(lastRenameTo(TYPST_ARGS_CONFIG.outputPath, state.ops)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exportPandoc (high-level orchestrator)
// ---------------------------------------------------------------------------

describe("exportPandoc", () => {
  it("blocks unknown citation keys before any spawn", async () => {
    const { ports, runner } = makeFakePorts();
    const result = await exportPandoc(
      baseJob({ markdown: "Bad [@nope] and [@zebra]." }),
      ports,
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.unknownKeys).toEqual(["nope", "zebra"]);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs the export and publishes on exit 0", async () => {
    const { ports, state, process } = makeFakePorts();
    const promise = exportPandoc(baseJob(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    const result = await promise;

    expect(result.status).toBe("success");
    expect(result.targetPath).toBe("/exports/manuscript file.docx");
    const rename = lastRenameTo("/exports/manuscript file.docx", state.ops);
    expect(rename).toBeDefined();
    // Rename source is the hidden temp in the same directory: `.<base>.<nonce>.tmp`.
    expect(rename?.includes("/exports/.manuscript file.")).toBe(true);
    // Temp working directory is cleaned up.
    expect(state.ops.some((op) => op.startsWith("rm:/tmp/paper-notes-export-"))).toBe(true);
  });

  it("writes the generated CSL-JSON and alias filter into the temp work dir", async () => {
    const { ports, state, process } = makeFakePorts();
    const promise = exportPandoc(baseJob(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await promise;

    const libraryWrite = state.ops.find(
      (op) => op.startsWith("write:") && op.endsWith("/library.json"),
    );
    expect(libraryWrite).toBeDefined();
    const libraryPath = libraryWrite?.slice("write:".length) as string;
    expect(state.files.get(libraryPath)).toContain('"id": "smith2024current"');
    expect(state.files.get(libraryPath)).not.toContain("oldSmith2020");

    const filterWrite = state.ops.find(
      (op) => op.startsWith("write:") && op.endsWith("/alias.lua"),
    );
    expect(filterWrite).toBeDefined();
    const filterPath = filterWrite?.slice("write:".length) as string;
    expect(state.files.get(filterPath)).toContain(
      '["oldSmith2020"] = "smith2024current"',
    );
  });

  it("preserves the prior artifact and cleans up on nonzero exit", async () => {
    const { ports, state, process } = makeFakePorts([
      ["/exports/manuscript file.docx", "old version"],
    ]);
    const promise = exportPandoc(baseJob(), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitStderr("pandoc: boom\n");
    process.emitClose(3);
    const result = await promise;

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(state.files.get("/exports/manuscript file.docx")).toBe("old version");
    expect(
      state.ops.some(
        (op) => op.startsWith("rename:") && op.includes("/exports/manuscript file.docx"),
      ),
    ).toBe(false);
    expect(state.ops.some((op) => op.startsWith("rm:/tmp/paper-notes-export-"))).toBe(true);
  });

  it("cancel terminates the child, cleans the temp output and work dir", async () => {
    const { ports, state, process } = makeFakePorts();
    const controller = new AbortController();
    const promise = exportPandoc(baseJob({ signal: controller.signal }), ports);
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(
      state.ops.some((op) => op.startsWith("unlink:/exports/.manuscript file.")),
    ).toBe(true);
    expect(state.ops.some((op) => op.startsWith("rm:/tmp/paper-notes-export-"))).toBe(true);
  });

  it("supports PDF jobs with the configured engine", async () => {
    const { ports, runner, process } = makeFakePorts();
    const promise = exportPandoc(
      baseJob({
        format: "pdf",
        pdfEngine: "/opt/engines/weasyprint",
        referenceDocx: "",
      }),
      ports,
    );
    await vi.waitFor(() => expect(ports.runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    const result = await promise;

    expect(result.status).toBe("success");
    expect(result.targetPath).toBe("/exports/manuscript file.pdf");
    const args = runner.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--pdf-engine") + 1]).toBe("/opt/engines/weasyprint");
    expect(args).not.toContain("--reference-doc");
  });

  it("supports the two-step typst PDF path end to end (R10)", async () => {
    const { ports, runner, state, process } = makeFakePorts();
    const promise = exportPandoc(
      baseJob({
        format: "pdf",
        pdfEngine: "/opt/homebrew/bin/typst",
        referenceDocx: "",
      }),
      ports,
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    process.emitClose(0);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    process.emitClose(0);
    const result = await promise;

    expect(result.status).toBe("success");
    expect(result.targetPath).toBe("/exports/manuscript file.pdf");
    const pandocArgs = runner.mock.calls[0][1] as string[];
    expect(pandocArgs[pandocArgs.indexOf("--to") + 1]).toBe("typst");
    expect(pandocArgs).not.toContain("--pdf-engine");
    expect(runner.mock.calls[1][0]).toBe("/opt/homebrew/bin/typst");
    // Temp working directory is cleaned up on the two-step path too.
    expect(state.ops.some((op) => op.startsWith("rm:/tmp/paper-notes-export-"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// exportSuccessActions
// ---------------------------------------------------------------------------

describe("exportSuccessActions", () => {
  it("offers open and show-in-Finder actions for the exported file", async () => {
    const actions: OpenRevealActions = {
      open: vi.fn(async () => {}),
      reveal: vi.fn(async () => {}),
    };
    const choices = exportSuccessActions("/exports/paper.docx", actions);

    expect(choices.map((choice) => choice.label)).toEqual([
      "Open file",
      "Show in Finder",
    ]);
    await choices[0].run();
    await choices[1].run();
    expect(actions.open).toHaveBeenCalledWith("/exports/paper.docx");
    expect(actions.reveal).toHaveBeenCalledWith("/exports/paper.docx");
  });
});

// ---------------------------------------------------------------------------
// checkExportHealth
// ---------------------------------------------------------------------------

function makeHealthPort(
  overrides: Partial<{
    isDirectory: (path: string) => boolean;
    isWritable: (path: string) => boolean;
    isFile: (path: string) => boolean;
    exists: (path: string) => boolean;
    resolveBinary: (binary: string) => string | null;
  }> = {},
): {
  port: {
    isDirectory: (p: string) => Promise<boolean>;
    isWritable: (p: string) => Promise<boolean>;
    isFile: (p: string) => Promise<boolean>;
    exists: (p: string) => Promise<boolean>;
    resolveBinary: (b: string) => Promise<string | null>;
  };
} {
  const defaults = {
    isDirectory: () => true,
    isWritable: () => true,
    isFile: () => true,
    exists: () => true,
    resolveBinary: (binary: string) => (binary.length > 0 ? `/resolved/${binary}` : null),
  };
  const merged = { ...defaults, ...overrides };
  const port = {
    isDirectory: async (p: string) => merged.isDirectory(p),
    isWritable: async (p: string) => merged.isWritable(p),
    isFile: async (p: string) => merged.isFile(p),
    exists: async (p: string) => merged.exists(p),
    resolveBinary: async (b: string) => merged.resolveBinary(b),
  };
  return { port };
}

const OK_CSL = {
  ok: true,
  file: "ama.csl",
  path: ".paper-notes/csl/ama.csl",
  title: "American Medical Association",
} as const;

function healthInput(overrides: Partial<ExportHealthInput> = {}): ExportHealthInput {
  return {
    format: "docx",
    exportDirectory: "/exports",
    pandocPath: "pandoc",
    pdfEngine: "xelatex",
    referenceDocx: "/ref/reference.docx",
    csl: OK_CSL,
    ...overrides,
  };
}

describe("checkExportHealth", () => {
  it("resolves everything and reports ok with absolute paths", async () => {
    const { port } = makeHealthPort();
    const health = (await checkExportHealth(port, healthInput())) as Extract<
      ExportHealth,
      { ok: true }
    >;
    expect(health.ok).toBe(true);
    expect(health.pandocPath).toBe("/resolved/pandoc");
    expect(health.cslPath).toBe(".paper-notes/csl/ama.csl");
    expect(health.cslTitle).toBe("American Medical Association");
    expect(health.referenceDocx).toBe("/ref/reference.docx");
    expect(health.exportDirectory).toBe("/exports");
  });

  it("requires a configured export directory", async () => {
    const { port } = makeHealthPort();
    const health = await checkExportHealth(port, healthInput({ exportDirectory: "  " }));
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems[0]).toContain("Export directory is not configured");
    }
  });

  it("blocks a missing export directory", async () => {
    const { port } = makeHealthPort({ isDirectory: () => false });
    const health = await checkExportHealth(port, healthInput());
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems[0]).toContain("does not exist");
    }
  });

  it("blocks an unwritable export directory", async () => {
    const { port } = makeHealthPort({ isWritable: () => false });
    const health = await checkExportHealth(port, healthInput());
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems[0]).toContain("not writable");
    }
  });

  it("blocks an unresolvable pandoc binary", async () => {
    const { port } = makeHealthPort({ resolveBinary: () => null });
    const health = await checkExportHealth(port, healthInput());
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems.join(" ")).toContain("Pandoc binary not found");
    }
  });

  it("surfaces the CSL selection error when no style is available", async () => {
    const { port } = makeHealthPort();
    const health = await checkExportHealth(
      port,
      healthInput({ csl: { ok: false, error: "No CSL style selected." } }),
    );
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems).toContain("No CSL style selected.");
    }
  });

  it("blocks a PDF export without a configured engine", async () => {
    const { port } = makeHealthPort();
    const health = await checkExportHealth(
      port,
      healthInput({ format: "pdf", pdfEngine: "  " }),
    );
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems[0]).toContain("No PDF engine configured");
    }
  });

  it("blocks a PDF export whose engine cannot be resolved", async () => {
    const { port } = makeHealthPort({
      resolveBinary: (binary) => (binary === "pandoc" ? "/bin/pandoc" : null),
    });
    const health = await checkExportHealth(
      port,
      healthInput({ format: "pdf", pdfEngine: "xelatex" }),
    );
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems.join(" ")).toContain("PDF engine not found");
    }
  });

  it("resolves the configured engine for PDF and clears the reference DOCX", async () => {
    const { port } = makeHealthPort();
    const health = (await checkExportHealth(
      port,
      healthInput({ format: "pdf", referenceDocx: "/ref/reference.docx" }),
    )) as Extract<ExportHealth, { ok: true }>;
    expect(health.ok).toBe(true);
    expect(health.pdfEngine).toBe("/resolved/xelatex");
    expect(health.referenceDocx).toBe("");
  });

  it("blocks a missing reference DOCX for DOCX output", async () => {
    const { port } = makeHealthPort({ isFile: () => false });
    const health = await checkExportHealth(port, healthInput());
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems.join(" ")).toContain("Reference DOCX not found");
    }
  });

  it("treats an unset reference DOCX as optional", async () => {
    const { port } = makeHealthPort({ isFile: () => false });
    const health = (await checkExportHealth(
      port,
      healthInput({ referenceDocx: "  " }),
    )) as Extract<ExportHealth, { ok: true }>;
    expect(health.ok).toBe(true);
    expect(health.referenceDocx).toBe("");
  });

  it("accumulates multiple problems", async () => {
    const { port } = makeHealthPort({
      isDirectory: () => false,
      resolveBinary: () => null,
      isFile: () => false,
    });
    const health = await checkExportHealth(port, healthInput());
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.problems.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// export-confirmation-modal (fake DOM)
// ---------------------------------------------------------------------------

interface FakeElOptions {
  cls?: string;
  text?: string;
}

interface FakeEl {
  textContent: string;
  cls: string;
  children: FakeEl[];
  listeners: Record<string, Array<(event?: unknown) => void>>;
  setText(text: string): void;
  empty(): void;
  createDiv(options?: FakeElOptions): FakeEl;
  createEl(tag: string, options?: FakeElOptions): FakeEl;
  addEventListener(name: string, handler: (event?: unknown) => void): void;
}

function makeFakeEl(): FakeEl {
  const children: FakeEl[] = [];
  const listeners: Record<string, Array<(event?: unknown) => void>> = {};
  let ownText = "";
  const el: FakeEl = {
    cls: "",
    children,
    listeners,
    // `textContent` aggregates own text plus all descendant text, matching
    // real DOM semantics (Obsidian renders summary/status content through
    // child nodes, so the aggregate is what a user would read).
    get textContent(): string {
      return ownText + children.map((child) => child.textContent).join("");
    },
    set textContent(value: string) {
      ownText = value;
    },
    setText(text: string): void {
      ownText = text;
    },
    empty(): void {
      children.length = 0;
      ownText = "";
    },
    createDiv(options?: FakeElOptions): FakeEl {
      return makeChild(options);
    },
    createEl(_tag: string, options?: FakeElOptions): FakeEl {
      return makeChild(options);
    },
    addEventListener(name: string, handler: (event?: unknown) => void): void {
      (listeners[name] ??= []).push(handler);
    },
  };
  function makeChild(options?: FakeElOptions): FakeEl {
    const child = makeFakeEl();
    if (options?.cls !== undefined) {
      child.cls = options.cls;
    }
    if (options?.text !== undefined) {
      child.textContent = options.text;
    }
    children.push(child);
    return child;
  }
  return el;
}

/**
 * The mock factory is evaluated as soon as the static `import { Modal }`
 * in the modal source runs — before the top-level `class` declarations
 * below. `FakeModal` must therefore be created via `vi.hoisted`
 * (Repair: Gate D R8 static-import follow-up).
 */
const FakeModal = vi.hoisted(() => {
  class FakeModal {
    titleEl: FakeEl;
    contentEl: FakeEl;
    app: unknown;

    constructor(app: unknown) {
      this.app = app;
      this.titleEl = makeFakeEl();
      this.contentEl = makeFakeEl();
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }

    close(): void {}
  }
  return FakeModal;
});

vi.mock("obsidian", () => ({ Modal: FakeModal }));

const SUCCESS_RESULT: ExportRunResult = {
  status: "success",
  targetPath: "/exports/manuscript file.docx",
  outputPath: "/exports/manuscript file.docx",
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const FAILED_RESULT: ExportRunResult = {
  status: "failed",
  outputPath: "/exports/manuscript file.docx",
  exitCode: 2,
  stdout: "",
  stderr: "pandoc: some failure detail",
};

function makeModalProps(
  overrides: Partial<ExportConfirmationProps> = {},
): ExportConfirmationProps {
  return {
    format: "docx",
    targetPath: "/exports/manuscript file.docx",
    targetExists: false,
    cslTitle: "American Medical Association",
    engineLabel: "Reference DOCX: /ref/reference.docx",
    actions: {
      open: vi.fn(async () => {}),
      reveal: vi.fn(async () => {}),
    },
    onCancel: vi.fn(),
    ...overrides,
  };
}

function makeModalCallbacks(overrides: Partial<ExportConfirmationCallbacks> = {}): {
  callbacks: ExportConfirmationCallbacks;
  start: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(() => ({
    abort: vi.fn(),
    result: Promise.resolve(SUCCESS_RESULT),
  }));
  return { callbacks: { start, ...overrides }, start };
}

function summaryOf(handle: { contentEl: HTMLElement }): FakeEl | undefined {
  const content = handle.contentEl as unknown as FakeEl;
  return content.children.find((child) => child.cls === "paper-notes-export-summary");
}

function statusOf(handle: { contentEl: HTMLElement }): FakeEl | undefined {
  const content = handle.contentEl as unknown as FakeEl;
  return content.children.find((child) => child.cls === "paper-notes-export-status");
}

function actionsOf(handle: { contentEl: HTMLElement }): FakeEl | undefined {
  const content = handle.contentEl as unknown as FakeEl;
  return content.children.find((child) => child.cls === "paper-notes-modal-actions");
}

function buttonOf(parent: FakeEl | undefined, label: string): FakeEl | undefined {
  return parent?.children.find((child) => child.textContent === label);
}

function click(button: FakeEl | undefined): void {
  button?.listeners?.click?.[0]?.(undefined);
}

describe("export confirmation modal wiring (fake DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the target path, CSL title, engine line and an overwrite warning", async () => {
    const props = makeModalProps({ targetExists: true });
    const handle = createExportConfirmationModal({} as App, props, {
      start: vi.fn(),
    });

    handle.open();

    const summary = summaryOf(handle);
    const target = summary?.children.find(
      (child) => child.cls === "paper-notes-export-target",
    );
    expect(target?.textContent).toBe("/exports/manuscript file.docx");
    const warning = summary?.children.find(
      (child) => child.cls === "paper-notes-export-warning",
    );
    expect(warning?.textContent).toContain("overwrite");
    expect(summary?.textContent).toContain("American Medical Association");
    expect(summary?.textContent).toContain("/ref/reference.docx");
  });

  it("hides the overwrite warning when the target does not exist", async () => {
    const handle = createExportConfirmationModal(
      {} as App,
      makeModalProps({ targetExists: false }),
      { start: vi.fn() },
    );
    handle.open();

    const summary = summaryOf(handle);
    expect(
      summary?.children.some((child) => child.cls === "paper-notes-export-warning"),
    ).toBe(false);
  });

  it("runs the export on confirm and offers open / show-in-Finder actions", async () => {
    const props = makeModalProps();
    const actions = props.actions as {
      open: ReturnType<typeof vi.fn>;
      reveal: ReturnType<typeof vi.fn>;
    };
    const { callbacks, start } = makeModalCallbacks();
    const handle = createExportConfirmationModal({} as App, props, callbacks);

    handle.open();
    click(buttonOf(actionsOf(handle), "Export"));

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
      const status = statusOf(handle);
      expect(status?.textContent).toContain("Exported to");
    });

    const successButtons = actionsOf(handle);
    click(buttonOf(successButtons, "Open file"));
    click(buttonOf(successButtons, "Show in Finder"));
    await vi.waitFor(() => {
      expect(actions.open).toHaveBeenCalledWith("/exports/manuscript file.docx");
      expect(actions.reveal).toHaveBeenCalledWith("/exports/manuscript file.docx");
    });
  });

  it("shows stderr when the export fails", async () => {
    const { callbacks } = makeModalCallbacks({
      start: vi.fn(() => ({
        abort: vi.fn(),
        result: Promise.resolve(FAILED_RESULT),
      })),
    });
    const handle = createExportConfirmationModal(
      {} as App,
      makeModalProps(),
      callbacks,
    );

    handle.open();
    click(buttonOf(actionsOf(handle), "Export"));

    await vi.waitFor(() => {
      const status = statusOf(handle);
      expect(status?.textContent).toContain("failed");
      expect(status?.textContent).toContain("some failure detail");
    });
  });

  it("reports blocked runs with the unknown citation keys", async () => {
    const { callbacks } = makeModalCallbacks({
      start: vi.fn(() => ({
        abort: vi.fn(),
        result: Promise.resolve({
          status: "blocked",
          outputPath: "/exports/manuscript file.docx",
          exitCode: null,
          stdout: "",
          stderr: "",
          unknownKeys: ["nope"],
        } satisfies ExportRunResult),
      })),
    });
    const handle = createExportConfirmationModal(
      {} as App,
      makeModalProps(),
      callbacks,
    );

    handle.open();
    click(buttonOf(actionsOf(handle), "Export"));

    await vi.waitFor(() => {
      expect(statusOf(handle)?.textContent).toContain("nope");
    });
  });

  it("pre-run Cancel closes without starting the export", async () => {
    const props = makeModalProps();
    const { callbacks, start } = makeModalCallbacks();
    const handle = createExportConfirmationModal({} as App, props, callbacks);

    handle.open();
    click(buttonOf(actionsOf(handle), "Cancel"));

    expect(start).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Stop during the run aborts the child and reports cancellation", async () => {
    const abort = vi.fn();
    let resolveResult!: (result: ExportRunResult) => void;
    const result = new Promise<ExportRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const { callbacks } = makeModalCallbacks({
      start: vi.fn(() => ({ abort, result })),
    });
    const handle = createExportConfirmationModal(
      {} as App,
      makeModalProps(),
      callbacks,
    );

    handle.open();
    click(buttonOf(actionsOf(handle), "Export"));

    await vi.waitFor(() => {
      expect(buttonOf(actionsOf(handle), "Stop")).toBeDefined();
    });
    click(buttonOf(actionsOf(handle), "Stop"));
    expect(abort).toHaveBeenCalledTimes(1);

    resolveResult({
      status: "cancelled",
      outputPath: "/exports/manuscript file.docx",
      exitCode: null,
      stdout: "",
      stderr: "",
    } satisfies ExportRunResult);
    await vi.waitFor(() => {
      expect(statusOf(handle)?.textContent).toContain("cancelled");
    });
  });
});
