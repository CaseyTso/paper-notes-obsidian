/**
 * Focused academic Pandoc exporter (Task 29).
 *
 * Academic DOCX/PDF export for the paper-notes literature system. The flow
 * is inspired by the MIT-licensed `OliverBalfour/obsidian-pandoc` project
 * (see THIRD_PARTY_NOTICES.md) but ports only the DOCX/PDF slice and fixes
 * two upstream weaknesses:
 *
 * 1. Upstream splits free-form argument strings on spaces
 *    (`extraParams.flatMap(x => x.split(' '))`), which breaks quoted
 *    paths. Here every CLI argument is a separate array element passed to
 *    `spawn()` verbatim — configured paths containing spaces stay intact
 *    and no shell string is ever built.
 * 2. Upstream auto-picks the PDF engine with `lookpath('xelatex')`
 *    instead of the user's configured engine and resolves success by
 *    file-existence rather than the process exit code. Here the configured
 *    engine is used, the exit code decides success, output is written to a
 *    temporary file and atomically promoted only on exit 0, and a nonzero
 *    exit preserves the previous artifact while surfacing stderr.
 *
 * Design spec §14 contract:
 * - Markdown input keeps Pandoc citations intact.
 * - A generated CSL-JSON `library.json` (ids = current keys only), an
 *   alias Lua filter, `--citeproc` and the selected CSL style are passed.
 *   The Lua filter runs before citeproc so legacy citation keys resolve to
 *   the current items (empirically verified against pandoc 3.8: the
 *   `citation.id` field is rewritten by a `Cite` filter, and citeproc
 *   runs last regardless of flag order, so the filter must precede it).
 * - DOCX uses the configured reference DOCX when set; PDF uses the
 *   configured engine when set.
 * - A fixed, validated global output directory owns the output.
 * - Unknown citation keys block the run before any spawn.
 * - Cancel terminates the child process and cleans the temp output.
 *
 * Vault/process I/O goes through injected ports so unit tests exercise the
 * full logic against fake processes and an in-memory filesystem.
 */

import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  rename as fsRename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { PaperRecord } from "../types/paper";

/** Supported output formats (design spec §14.1: DOCX and PDF only). */
export type ExportFormat = "docx" | "pdf";

export type ExportStatus = "success" | "failed" | "cancelled" | "blocked";

export interface ExportRunResult {
  status: ExportStatus;
  /** Absolute path of the published target (success only). */
  targetPath?: string;
  /** Absolute path of the final target (unchanged on failure/cancel). */
  outputPath: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Unknown citation keys that blocked the run (blocked only). */
  unknownKeys?: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers: CSL-JSON index, alias Lua filter, citation gating, args.
// ---------------------------------------------------------------------------

/**
 * Generate the whole-library CSL-JSON index. Item ids are the *current*
 * citation keys; legacy keys (aliases) are never emitted as ids so citing
 * both old and new keys cannot produce duplicate bibliography entries.
 */
export function generateCslJson(records: PaperRecord[]): string {
  const items = [...records]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(recordToCslItem);
  return JSON.stringify(items, null, 2) + "\n";
}

function recordToCslItem(record: PaperRecord): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: record.key,
    type: "article-journal",
    title: record.title,
  };
  const authors = record.authors
    .map(authorToCsl)
    .filter((author): author is Record<string, string> => author !== null);
  if (authors.length > 0) {
    item.author = authors;
  }
  if (typeof record.journal === "string" && record.journal.length > 0) {
    item["container-title"] = record.journal;
  }
  if (typeof record.year === "number") {
    item.issued = { "date-parts": [[record.year]] };
  }
  if (record.identifiers.doi !== undefined) {
    item.DOI = record.identifiers.doi;
  }
  if (record.identifiers.pmid !== undefined) {
    item.PMID = record.identifiers.pmid;
  }
  if (record.identifiers.pmcid !== undefined) {
    item.PMCID = record.identifiers.pmcid;
  }
  if (typeof record.abstract === "string" && record.abstract.length > 0) {
    item.abstract = record.abstract;
  }
  return item;
}

function authorToCsl(
  author: PaperRecord["authors"][number],
): Record<string, string> | null {
  if (typeof author.literal === "string" && author.literal.length > 0) {
    return { literal: author.literal };
  }
  if (typeof author.family === "string" && author.family.length > 0) {
    const csl: Record<string, string> = { family: author.family };
    if (typeof author.given === "string" && author.given.length > 0) {
      csl.given = author.given;
    }
    return csl;
  }
  return null;
}

/** Build the alias → current-key map from the records' reserved aliases. */
export function aliasMapOf(records: PaperRecord[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const record of records) {
    for (const alias of record.citationKeyAliases) {
      if (alias === record.key) {
        continue;
      }
      map[alias] = record.key;
    }
  }
  return map;
}

/**
 * Generate the Lua filter that rewrites legacy citation keys to the current
 * keys in the Pandoc AST before citeproc runs. Keys and values are escaped
 * so quotes/backslashes cannot break out of the generated Lua literals.
 */
export function buildAliasLuaFilter(aliases: Record<string, string>): string {
  const entries = Object.entries(aliases)
    .filter(([alias, current]) => alias !== current)
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = entries.map(
    ([alias, current]) =>
      `  [${luaString(alias)}] = ${luaString(current)},`,
  );
  return [
    "-- Generated by paper-notes-obsidian (Task 29).",
    "-- Rewrites legacy citation keys to current keys before citeproc runs.",
    "local aliases = {",
    ...lines,
    "}",
    "",
    "function Cite(cite)",
    "  for i, c in ipairs(cite.citations) do",
    "    local current = aliases[c.id]",
    "    if current ~= nil then",
    "      c.id = current",
    "    end",
    "  end",
    "  return cite",
    "end",
  ].join("\n");
}

function luaString(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r") +
    '"'
  );
}

const BRACKET_SPAN_RE = /\[[^\]]*\]/g;
const AT_KEY_RE = /@([A-Za-z_][A-Za-z0-9_@.:-]*)/g;

/**
 * Extract Pandoc-style citation keys (`[@key]`, `[see @key, p. 3]`,
 * `[@a; @b]`) from Markdown. Fenced code blocks and inline code spans are
 * stripped first so literal examples are not mistaken for citations.
 * Double-bracket Obsidian wikilinks are ignored.
 */
export function citationKeysInMarkdown(markdown: string): string[] {
  const keys = new Set<string>();
  for (const line of stripCodeLines(markdown)) {
    BRACKET_SPAN_RE.lastIndex = 0;
    let span: RegExpExecArray | null;
    while ((span = BRACKET_SPAN_RE.exec(line)) !== null) {
      if (span[0].startsWith("[[")) {
        continue;
      }
      AT_KEY_RE.lastIndex = 0;
      let at: RegExpExecArray | null;
      while ((at = AT_KEY_RE.exec(span[0])) !== null) {
        keys.add(at[1]);
      }
    }
  }
  return [...keys];
}

/** Split Markdown into lines with fenced blocks and inline code removed. */
function stripCodeLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  let fence: "```" | "~~~" | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence !== null) {
      if (trimmed.startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (trimmed.startsWith("```")) {
      fence = "```";
      continue;
    }
    if (trimmed.startsWith("~~~")) {
      fence = "~~~";
      continue;
    }
    result.push(stripInlineCode(line));
  }
  return result;
}

/** Remove backtick code spans (matching-length runs toggle the span). */
function stripInlineCode(line: string): string {
  let out = "";
  let inCode = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 1;
      while (i + run < line.length && line[i + run] === "`") {
        run += 1;
      }
      inCode = !inCode;
      i += run;
    } else {
      if (!inCode) {
        out += line[i];
      }
      i += 1;
    }
  }
  return out;
}

/**
 * Keys cited in `markdown` that are neither a current key nor a reserved
 * alias. Deterministically sorted. Used to block export before spawn.
 */
export function unknownCitationKeys(
  markdown: string,
  records: PaperRecord[],
  aliases: Record<string, string>,
): string[] {
  const known = new Set<string>();
  for (const record of records) {
    known.add(record.key);
  }
  for (const alias of Object.keys(aliases)) {
    known.add(alias);
  }
  const unknown = new Set<string>();
  for (const key of citationKeysInMarkdown(markdown)) {
    if (!known.has(key)) {
      unknown.add(key);
    }
  }
  return [...unknown].sort();
}

export type CitationGate =
  | { ok: true }
  | { ok: false; unknownKeys: string[] };

/** Citation gate consumed by the exporter and the command wiring. */
export function checkCitationKeys(
  markdown: string,
  records: PaperRecord[],
  aliases: Record<string, string>,
): CitationGate {
  const unknown = unknownCitationKeys(markdown, records, aliases);
  return unknown.length === 0 ? { ok: true } : { ok: false, unknownKeys: unknown };
}

/**
 * Deterministic final target path inside the fixed global output directory.
 * The base name is sanitized so path-hostile characters cannot escape the
 * directory; empty names fall back to `export`.
 */
export function exportTargetPath(
  exportDirectory: string,
  baseName: string,
  format: ExportFormat,
): string {
  const sanitized = baseName
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "");
  const safeBase = sanitized.length > 0 ? sanitized : "export";
  return join(exportDirectory, `${safeBase}.${format}`);
}

/**
 * Temporary output path placed in the *same directory* as the final target
 * so the success rename is atomic (same filesystem). Hidden dot-prefix and
 * a nonce keep it distinct from the published artifact. The name carries
 * the sanitized base name and the nonce only — no output extension — so the
 * temp can never be mistaken for the final artifact, and the format stays
 * unambiguous because the argv always passes `--to` explicitly.
 */
export function tempOutputFor(job: {
  exportDirectory: string;
  baseName: string;
  format: ExportFormat;
  nonce?: string;
}): string {
  const target = exportTargetPath(job.exportDirectory, job.baseName, job.format);
  const safeBase = basename(target, `.${job.format}`);
  const nonce =
    job.nonce ??
    `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(dirname(target), `.${safeBase}.${nonce}.tmp`);
}

export interface ExportArgsConfig {
  format: ExportFormat;
  /** Resolved absolute path to the pandoc binary (argv element 0). */
  pandocPath: string;
  /** Absolute path to the input Markdown file (last element). */
  markdownPath: string;
  /** Absolute path of the temp output; promoted on exit 0. */
  tempOutputPath: string;
  /** Absolute path of the final target. */
  outputPath: string;
  /** Absolute path of the generated CSL-JSON index. */
  bibliographyPath: string;
  /** Absolute path of the generated alias Lua filter. */
  aliasFilterPath: string;
  /** Absolute path of the selected CSL style. */
  cslPath: string;
  /** Absolute path of the reference DOCX (docx only; empty when unset). */
  referenceDocx: string;
  /** Absolute path of the PDF engine (pdf only; empty when unset). */
  pdfEngine: string;
}

/**
 * True when the configured PDF engine is typst. Detected from the basename
 * (Repair R10) so absolute paths stay out of the source; the basename of
 * `/opt/homebrew/bin/typst` is `typst`, while a directory containing the
 * word never matches (`/opt/typst-bundles/weasyprint` is not typst).
 */
export function isTypstEngine(pdfEngine: string): boolean {
  return basename(pdfEngine).toLowerCase().includes("typst");
}

/**
 * Build the `spawn()` argument array for Pandoc. Every value is its own
 * array element — never split on spaces, never concatenated into a shell
 * string. The binary itself is *not* included: it is passed separately as
 * `spawn()`'s `command` argument (embedding it here would duplicate the
 * path and make Pandoc treat its own binary as the first input file). The
 * Lua filter precedes `--citeproc` so alias rewriting happens first.
 *
 * PDF + typst engine (Repair R10): pandoc 3.8's `--pdf-engine=typst`
 * template path is broken ("font fallback list must not be empty"), so the
 * engine flag is dropped and pandoc emits typst *source* (`--to typst`,
 * output `<temp>.typ`) instead; the typst binary compiles it afterwards
 * (see `runTypstTwoStepExport`). Non-typst engines keep the original
 * single-step path with `--pdf-engine`.
 */
export function buildExportArgs(config: ExportArgsConfig): string[] {
  const typstTwoStep = config.format === "pdf" && isTypstEngine(config.pdfEngine);
  const args = [
    "--from",
    "markdown",
    "--to",
    typstTwoStep ? "typst" : config.format,
    "-o",
    typstTwoStep ? `${config.tempOutputPath}.typ` : config.tempOutputPath,
    "--lua-filter",
    config.aliasFilterPath,
    "--citeproc",
    "--bibliography",
    config.bibliographyPath,
    "--csl",
    config.cslPath,
  ];
  if (config.format === "docx" && config.referenceDocx.length > 0) {
    args.push("--reference-doc", config.referenceDocx);
  }
  if (config.format === "pdf" && config.pdfEngine.length > 0 && !typstTwoStep) {
    args.push("--pdf-engine", config.pdfEngine);
  }
  args.push(config.markdownPath);
  return args;
}

// ---------------------------------------------------------------------------
// Process/filesystem ports (injectable for tests).
// ---------------------------------------------------------------------------

export interface PandocProcess {
  readonly exitCode: number | null;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: string): boolean;
}

export type PandocRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => PandocProcess;

export interface ExportFileSystem {
  /** Create a unique temp directory and return its absolute path. */
  mkdtemp(prefix: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Atomically move `from` to `to` (same filesystem). */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file; resolves when already absent. */
  unlink(path: string): Promise<void>;
  /** Recursively remove a directory tree; resolves when already absent. */
  rmRecursive(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface ExportPorts {
  runner: PandocRunner;
  fs: ExportFileSystem;
}

function realExportFileSystem(): ExportFileSystem {
  return {
    async mkdtemp(prefix: string): Promise<string> {
      return mkdtemp(join(tmpdir(), prefix));
    },
    async writeText(path: string, content: string): Promise<void> {
      await writeFile(path, content, "utf8");
    },
    async rename(from: string, to: string): Promise<void> {
      await fsRename(from, to);
    },
    async unlink(path: string): Promise<void> {
      await rm(path, { force: true });
    },
    async rmRecursive(path: string): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
    async exists(path: string): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Default production ports: real `spawn` and the real filesystem. */
export function defaultExportPorts(): ExportPorts {
  return {
    runner: (command, args, options) =>
      spawn(command, args, { cwd: options.cwd }) as unknown as PandocProcess,
    fs: realExportFileSystem(),
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface RunPandocOptions {
  config: ExportArgsConfig;
  /** Temp working directory holding the generated index/filter files. */
  workDir: string;
  libraryJson: string;
  aliasFilterLua: string;
  signal?: AbortSignal;
}

/**
 * Write the generated assets and run the export. PDF with the typst engine
 * takes the two-step path (pandoc → typst source, typst → PDF); every other
 * format/engine keeps the original single-step pandoc spawn. Capture
 * exit/stdout/stderr, promote the temp target on success only, and clean
 * the temp output on any other outcome. Cancel kills the child with SIGTERM.
 */
export async function runPandocExport(
  options: RunPandocOptions,
  ports: ExportPorts,
): Promise<ExportRunResult> {
  const { config } = options;
  await ports.fs.writeText(config.bibliographyPath, options.libraryJson);
  await ports.fs.writeText(config.aliasFilterPath, options.aliasFilterLua);

  if (config.format === "pdf" && isTypstEngine(config.pdfEngine)) {
    return await runTypstTwoStepExport(options, ports);
  }
  return await runPandocSingleStep(options, ports);
}

type SpawnStatus = "success" | "failed" | "cancelled";

interface SpawnOutcome {
  status: SpawnStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn one child, capture stdout/stderr, resolve on close with the exit
 * code, and resolve cancelled (killing the child with SIGTERM) on abort.
 * Shared by the single-step pandoc path and both steps of the typst path.
 */
function spawnCollect(
  ports: ExportPorts,
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: PandocProcess;
    try {
      child = ports.runner(command, args, { cwd });
    } catch (error) {
      resolve({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (status: SpawnStatus, exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve({ status, exitCode, stdout, stderr });
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish("cancelled", null);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      stderr += `\n[spawn error] ${error.message}`;
      finish("failed", null);
    });
    child.on("close", (code: number | null) => {
      finish(code === 0 ? "success" : "failed", code);
    });
  });
}

/**
 * Original single-step pandoc run: spawn once, promote the temp target on
 * exit 0 only; any other outcome preserves the previous artifact, surfaces
 * stderr and cleans the temp output.
 */
async function runPandocSingleStep(
  options: RunPandocOptions,
  ports: ExportPorts,
): Promise<ExportRunResult> {
  const { config } = options;
  const outcome = await spawnCollect(
    ports,
    config.pandocPath,
    buildExportArgs(config),
    dirname(config.markdownPath),
    options.signal,
  );
  if (outcome.status === "success") {
    try {
      await ports.fs.rename(config.tempOutputPath, config.outputPath);
    } catch (error) {
      await ports.fs.unlink(config.tempOutputPath).catch(() => {});
      return {
        status: "failed",
        outputPath: config.outputPath,
        exitCode: outcome.exitCode ?? null,
        stdout: outcome.stdout,
        stderr:
          outcome.stderr +
          (error instanceof Error ? `\n${error.message}` : `\n${String(error)}`),
      };
    }
    return {
      status: "success",
      targetPath: config.outputPath,
      outputPath: config.outputPath,
      exitCode: 0,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  }
  await ports.fs.unlink(config.tempOutputPath).catch(() => {});
  return {
    status: outcome.status,
    outputPath: config.outputPath,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
}

/**
 * Two-step PDF export for the typst engine (Repair R10). pandoc emits typst
 * source (citeproc has already resolved the citations into the source), then
 * the configured typst binary compiles it to the final temp PDF. This
 * bypasses pandoc 3.8's broken `--pdf-engine=typst` template ("font
 * fallback list must not be empty"). Both steps must exit 0 before the PDF
 * is atomically promoted; any other outcome preserves the previous
 * artifact, surfaces stderr and cleans the temp source/PDF. Cancel during
 * either step kills the running child with SIGTERM.
 *
 * typst CLI contract (verified against typst 0.15.1): the `compile`
 * subcommand is mandatory and the output is a positional argument —
 * `typst compile <input> <output>`. Neither the subcommand-less `typst
 * <input> -o <output>` nor `typst compile <input> -o <output>` forms are
 * accepted on 0.15 (the latter rejects `-o` as unexpected).
 */
async function runTypstTwoStepExport(
  options: RunPandocOptions,
  ports: ExportPorts,
): Promise<ExportRunResult> {
  const { config } = options;
  const cwd = dirname(config.markdownPath);
  const typSourcePath = `${config.tempOutputPath}.typ`;
  const typPdfPath = `${config.tempOutputPath}.pdf`;

  const step1 = await spawnCollect(
    ports,
    config.pandocPath,
    buildExportArgs(config),
    cwd,
    options.signal,
  );
  if (step1.status !== "success") {
    await ports.fs.unlink(typSourcePath).catch(() => {});
    return {
      status: step1.status,
      outputPath: config.outputPath,
      exitCode: step1.exitCode,
      stdout: step1.stdout,
      stderr: step1.stderr,
    };
  }

  const step2 = await spawnCollect(
    ports,
    config.pdfEngine,
    ["compile", typSourcePath, typPdfPath],
    cwd,
    options.signal,
  );
  if (step2.status !== "success") {
    await ports.fs.unlink(typSourcePath).catch(() => {});
    await ports.fs.unlink(typPdfPath).catch(() => {});
    return {
      status: step2.status,
      outputPath: config.outputPath,
      exitCode: step2.exitCode,
      stdout: step1.stdout + step2.stdout,
      stderr: step1.stderr + step2.stderr,
    };
  }

  try {
    await ports.fs.rename(typPdfPath, config.outputPath);
  } catch (error) {
    await ports.fs.unlink(typSourcePath).catch(() => {});
    await ports.fs.unlink(typPdfPath).catch(() => {});
    return {
      status: "failed",
      outputPath: config.outputPath,
      exitCode: 0,
      stdout: step1.stdout + step2.stdout,
      stderr:
        step1.stderr +
        step2.stderr +
        (error instanceof Error ? `\n${error.message}` : `\n${String(error)}`),
    };
  }
  await ports.fs.unlink(typSourcePath).catch(() => {});
  return {
    status: "success",
    targetPath: config.outputPath,
    outputPath: config.outputPath,
    exitCode: 0,
    stdout: step1.stdout + step2.stdout,
    stderr: step1.stderr + step2.stderr,
  };
}

export interface PandocExportJob {
  format: ExportFormat;
  baseName: string;
  /** Markdown text used for the pre-spawn citation gate. */
  markdown: string;
  /** Absolute path to the input Markdown file for pandoc. */
  markdownPath: string;
  /** Validated, writable global output directory. */
  exportDirectory: string;
  /** Resolved absolute pandoc binary path. */
  pandocPath: string;
  /** Resolved absolute PDF engine path (pdf; "" when unset). */
  pdfEngine: string;
  /** Absolute path of the selected CSL style. */
  cslPath: string;
  /** Absolute path of the reference DOCX (docx; "" when unset). */
  referenceDocx: string;
  records: PaperRecord[];
  signal?: AbortSignal;
}

/**
 * High-level export: gate citations, generate the CSL-JSON index and alias
 * filter in a temp work dir, run pandoc, publish atomically on success and
 * always remove the temp work dir.
 */
export async function exportPandoc(
  job: PandocExportJob,
  ports: ExportPorts,
): Promise<ExportRunResult> {
  const outputPath = exportTargetPath(job.exportDirectory, job.baseName, job.format);
  const aliases = aliasMapOf(job.records);
  const gate = checkCitationKeys(job.markdown, job.records, aliases);
  if (!gate.ok) {
    return {
      status: "blocked",
      outputPath,
      exitCode: null,
      stdout: "",
      stderr: "",
      unknownKeys: gate.unknownKeys,
    };
  }

  const workDir = await ports.fs.mkdtemp("paper-notes-export-");
  try {
    const tempOutputPath = tempOutputFor({
      exportDirectory: job.exportDirectory,
      baseName: job.baseName,
      format: job.format,
    });
    const config: ExportArgsConfig = {
      format: job.format,
      pandocPath: job.pandocPath,
      markdownPath: job.markdownPath,
      tempOutputPath,
      outputPath,
      bibliographyPath: join(workDir, "library.json"),
      aliasFilterPath: join(workDir, "alias.lua"),
      cslPath: job.cslPath,
      referenceDocx: job.referenceDocx,
      pdfEngine: job.pdfEngine,
    };
    return await runPandocExport(
      {
        config,
        workDir,
        libraryJson: generateCslJson(job.records),
        aliasFilterLua: buildAliasLuaFilter(aliases),
        signal: job.signal,
      },
      ports,
    );
  } finally {
    await ports.fs.rmRecursive(workDir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Success actions (open / show in Finder).
// ---------------------------------------------------------------------------

export interface OpenRevealActions {
  /** Open the file with its default application. */
  open(path: string): Promise<void>;
  /** Reveal the file in the OS file manager (Finder). */
  reveal(path: string): Promise<void>;
}

/** Electron-shell backed actions for the Obsidian desktop runtime. */
export function desktopOpenRevealActions(): OpenRevealActions {
  const loadShell = (): { shell?: { openPath(p: string): Promise<string>; showItemInFolder(p: string): void } } => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("electron") as {
        shell?: { openPath(p: string): Promise<string>; showItemInFolder(p: string): void };
      };
    } catch {
      return {};
    }
  };
  return {
    async open(path: string): Promise<void> {
      const shell = loadShell().shell;
      if (shell !== undefined) {
        await shell.openPath(path);
      }
    },
    async reveal(path: string): Promise<void> {
      const shell = loadShell().shell;
      if (shell !== undefined) {
        shell.showItemInFolder(path);
      }
    },
  };
}

export interface SuccessActionChoice {
  label: string;
  run(): Promise<void>;
}

/** Success actions offered after a successful export. */
export function exportSuccessActions(
  path: string,
  actions: OpenRevealActions,
): SuccessActionChoice[] {
  return [
    { label: "Open file", run: () => actions.open(path) },
    { label: "Show in Finder", run: () => actions.reveal(path) },
  ];
}
