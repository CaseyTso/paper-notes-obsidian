/**
 * CSL Style Preview Generator (Stage S1).
 *
 * Renders an HTML preview of a CSL style using Pandoc citeproc so users can
 * inspect both in-text citation formatting and bibliography layout before
 * choosing or exporting with a style.
 *
 * Contract:
 * - A fixed, three-item sample CSL-JSON bibliography (`SAMPLE_CSL_JSON`) and
 *   a minimal Markdown snippet (`SAMPLE_MARKDOWN`) provide reproducible preview
 *   inputs covering journal articles, books, and conference proceedings.
 * - `generateCslPreview` orchestrates Pandoc:
 *   1. Creates an isolated temporary directory via injected filesystem ports.
 *   2. Writes `sample.md` and `library.json` into the temporary directory.
 *   3. Spawns Pandoc:
 *      `pandoc sample.md --from markdown --to html --citeproc --bibliography library.json --csl <cslPath> -o out.html`
 *      (No Lua filters, no reference DOCX).
 *   4. Reads `out.html` and extracts the bibliography block (`<div id="refs" ...>...</div>`)
 *      together with the in-text citation paragraph for preview context. If no
 *      `refs` div is present, falls back to the full body HTML.
 *   5. Writes the extracted preview HTML fragment to the designated `cachePath`.
 *   6. Cleans up the temporary directory in a `finally` block regardless of outcome.
 * - Error and process handling:
 *   - Process failures (nonzero exit code, spawn error) return `{ ok: false, error }`
 *     with stderr surfaced; errors are never thrown for process failures.
 *   - On failure, no cache file is written.
 *   - Execution times out after 30 seconds (configurable via `timeoutMs`), killing
 *     the process with SIGTERM and returning `{ ok: false, error: ... }`.
 * - Pure path resolution:
 *   - `cslPreviewCachePath(cslDir, cslFile)` returns `<cslDir>/.cache/<cslFile>.html`.
 * - Injectable ports (`CslPreviewPorts`) decouple filesystem and process execution
 *   from real disk/OS, enabling complete unit testing with in-memory state.
 */

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Fixed sample bibliography and Markdown source.
// ---------------------------------------------------------------------------

export const SAMPLE_CSL_ITEMS = [
  {
    id: "sample-article",
    type: "article-journal",
    author: [{ family: "Smith", given: "John" }],
    title: "A Sample Journal Article",
    "container-title": "Journal of Examples",
    issued: { "date-parts": [[2020]] },
    volume: "10",
    issue: "2",
    page: "100-110",
    DOI: "10.1234/example",
  },
  {
    id: "sample-book",
    type: "book",
    author: [{ family: "Doe", given: "Jane" }],
    title: "The Sample Book",
    issued: { "date-parts": [[2019]] },
    publisher: "Example Press",
    "publisher-place": "New York",
  },
  {
    id: "sample-inproceedings",
    type: "paper-conference",
    author: [{ family: "Zhang", given: "Wei" }],
    title: "A Sample Conference Paper",
    "container-title": "Proceedings of the Example Conference",
    issued: { "date-parts": [[2021]] },
    page: "50-55",
  },
] as const;

export const SAMPLE_CSL_JSON: string =
  JSON.stringify(SAMPLE_CSL_ITEMS, null, 2) + "\n";

export const SAMPLE_MARKDOWN: string =
  `# Preview\n\nCiting [@sample-article; @sample-book; @sample-inproceedings].\n`;

// ---------------------------------------------------------------------------
// Pure helpers: cache paths, argument construction, HTML extraction.
// ---------------------------------------------------------------------------

/**
 * Return the absolute path of the cached HTML preview fragment:
 * `<cslDir>/.cache/<cslFile>.html`.
 */
export function cslPreviewCachePath(cslDir: string, cslFile: string): string {
  return join(cslDir, ".cache", `${cslFile}.html`);
}

/**
 * Build the argument array for Pandoc preview generation.
 * Pandoc input: `sample.md --from markdown --to html --citeproc --bibliography library.json --csl <cslPath> -o out.html`.
 */
export function buildPreviewArgs(cslPath: string): string[] {
  return [
    "sample.md",
    "--from",
    "markdown",
    "--to",
    "html",
    "--citeproc",
    "--bibliography",
    "library.json",
    "--csl",
    cslPath,
    "-o",
    "out.html",
  ];
}

/**
 * Extract the `<div id="refs" ...>...</div>` block from pandoc HTML output,
 * properly handling nested `<div>` tags by tracking opening and closing tags.
 */
export function extractRefsDiv(html: string): string | null {
  const match = html.match(/<div\b[^>]*\bid=["']refs["'][^>]*>/i);
  if (!match || match.index === undefined) {
    return null;
  }
  const startIndex = match.index;
  const tagRegex = /<\/?div\b[^>]*>/gi;
  tagRegex.lastIndex = startIndex;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, tagRegex.lastIndex);
      }
    } else {
      if (!m[0].endsWith("/>")) {
        depth += 1;
      }
    }
  }
  return html.slice(startIndex);
}

/**
 * Extract the paragraph containing the in-text citation, if present.
 */
export function extractCitationParagraph(html: string): string | null {
  const match = html.match(
    /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*(?:class=["'][^"']*\bcitation\b|data-cites=)(?:(?!<\/p>)[\s\S])*<\/p>/i,
  );
  return match ? match[0].trim() : null;
}

/**
 * Extract the preview HTML fragment:
 * - The bibliography block (`<div id="refs"...>...</div>`).
 * - Preceded by the in-text citation paragraph for context.
 * - Falls back to full body (or full html) if no refs div is present.
 */
export function extractPreviewHtml(html: string): string {
  const refs = extractRefsDiv(html);
  if (!refs) {
    const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    return (bodyMatch ? bodyMatch[1] : html).trim();
  }
  const citationPara = extractCitationParagraph(html);
  if (citationPara) {
    return `${citationPara}\n${refs}`.trim();
  }
  return refs.trim();
}

// ---------------------------------------------------------------------------
// Process/filesystem ports (injectable for tests).
// ---------------------------------------------------------------------------

export type CslPreviewResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

export interface CslPreviewConfig {
  /** Absolute path to the pandoc executable. */
  pandocPath: string;
  /** Absolute path to the .csl style file. */
  cslPath: string;
  /** Absolute path of the HTML cache file to write. */
  cachePath: string;
  /** Process timeout in milliseconds. Defaults to 30,000ms (30s). */
  timeoutMs?: number;
}

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

export interface CslPreviewFileSystem {
  /** Create a unique temp directory and return its absolute path. */
  mkdtemp(prefix: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  readText(path: string): Promise<string>;
  rmRecursive(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface CslPreviewPorts {
  runner: PandocRunner;
  fs: CslPreviewFileSystem;
}

function realCslPreviewFileSystem(): CslPreviewFileSystem {
  return {
    async mkdtemp(prefix: string): Promise<string> {
      return mkdtemp(join(tmpdir(), prefix));
    },
    async writeText(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    async readText(path: string): Promise<string> {
      return readFile(path, "utf8");
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

/** Default production ports: real `spawn` and real filesystem. */
export function defaultCslPreviewPorts(): CslPreviewPorts {
  return {
    runner: (command, args, options) =>
      spawn(command, args, { cwd: options.cwd }) as unknown as PandocProcess,
    fs: realCslPreviewFileSystem(),
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnCollect(
  runner: PandocRunner,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    let child: PandocProcess;
    try {
      child = runner(command, args, { cwd });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore kill failure
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      stderr += `\n[spawn error] ${error.message}`;
      finish(null);
    });
    child.on("close", (code: number | null) => {
      finish(code);
    });
  });
}

/**
 * Generate a CslPreviewResult by running Pandoc against the sample bibliography
 * and markdown, extracting the formatted preview HTML fragment, and caching it.
 *
 * Guaranteed contract:
 * - Isolated temp directory created and cleaned up in `finally`.
 * - Timeouts kill after 30s (SIGTERM) returning `ok: false`.
 * - Process failures return `ok: false` with stderr and never throw.
 * - Cache file written only on exit 0.
 */
export async function generateCslPreview(
  ports: CslPreviewPorts,
  config: CslPreviewConfig,
): Promise<CslPreviewResult> {
  let workDir: string | null = null;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    workDir = await ports.fs.mkdtemp("csl-preview-");
    const markdownPath = join(workDir, "sample.md");
    const bibliographyPath = join(workDir, "library.json");
    const outHtmlPath = join(workDir, "out.html");

    await ports.fs.writeText(markdownPath, SAMPLE_MARKDOWN);
    await ports.fs.writeText(bibliographyPath, SAMPLE_CSL_JSON);

    const args = buildPreviewArgs(config.cslPath);
    const outcome = await spawnCollect(
      ports.runner,
      config.pandocPath,
      args,
      workDir,
      timeoutMs,
    );

    if (outcome.timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      return {
        ok: false,
        error: `Pandoc preview timed out after ${seconds}s`,
      };
    }

    if (outcome.exitCode !== 0) {
      const errorMsg =
        outcome.stderr.trim() ||
        `Pandoc process exited with code ${outcome.exitCode ?? "null"}`;
      return {
        ok: false,
        error: errorMsg,
      };
    }

    try {
      const rawHtml = await ports.fs.readText(outHtmlPath);
      const previewHtml = extractPreviewHtml(rawHtml);
      await ports.fs.writeText(config.cachePath, previewHtml);
      return { ok: true, html: previewHtml };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (workDir !== null) {
      try {
        await ports.fs.rmRecursive(workDir);
      } catch {
        // Temp dir cleanup errors must not mask or throw
      }
    }
  }
}
