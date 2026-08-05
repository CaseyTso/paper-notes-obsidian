/**
 * Export preflight health (Task 29).
 *
 * Validates every external dependency before a Pandoc export launches
 * (design spec §14.2: "Validate Pandoc, PDF engine, CSL, reference DOCX,
 * citation index, and output directory before launch"). The fixed global
 * output directory is *required* — there is no same-directory fallback, and
 * a missing or unwritable directory blocks export with an actionable
 * message (§14.3).
 *
 * All filesystem/binary probes go through an injectable port so unit tests
 * exercise every gate against fake conditions; `defaultHealthPort()` backs
 * the port with the real filesystem and PATH resolution.
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";

import type { ExportStyleCheck } from "./csl-style-manager";
import type { ExportFormat } from "./pandoc-export";

export interface HealthFs {
  isDirectory(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
}

export interface HealthProcess {
  /** Resolve `binary` to an absolute executable path, or null. */
  resolveBinary(binary: string): Promise<string | null>;
}

export interface ExportHealthInput {
  format: ExportFormat;
  exportDirectory: string;
  pandocPath: string;
  pdfEngine: string;
  referenceDocx: string;
  /** Result of `requireExportStyle` (Task 28 gate), computed by the caller. */
  csl: ExportStyleCheck;
}

export type ExportHealth =
  | {
      ok: true;
      exportDirectory: string;
      /** Resolved absolute pandoc binary path. */
      pandocPath: string;
      /** Resolved absolute PDF engine path (pdf; "" when unset). */
      pdfEngine: string;
      /** Reference DOCX path as configured (docx; "" when unset). */
      referenceDocx: string;
      /** Vault-relative path of the selected CSL style. */
      cslPath: string;
      cslTitle: string;
    }
  | { ok: false; problems: string[] };

/**
 * Run every preflight gate. Problems accumulate so the user sees the full
 * list of blockers at once; any problem makes the check fail.
 */
export async function checkExportHealth(
  port: HealthFs & HealthProcess,
  input: ExportHealthInput,
): Promise<ExportHealth> {
  const problems: string[] = [];
  const csl = input.csl;

  const exportDirectory = input.exportDirectory.trim();
  if (exportDirectory.length === 0) {
    problems.push(
      "Export directory is not configured. Set a global output directory in the plugin settings before exporting.",
    );
  } else if (!(await port.isDirectory(exportDirectory))) {
    problems.push(
      `Export directory does not exist: ${exportDirectory}. Create it or fix the plugin setting.`,
    );
  } else if (!(await port.isWritable(exportDirectory))) {
    problems.push(`Export directory is not writable: ${exportDirectory}.`);
  }

  const pandocPath = await port.resolveBinary(input.pandocPath.trim() || "pandoc");
  if (pandocPath === null) {
    problems.push(
      `Pandoc binary not found: ${input.pandocPath}. Install Pandoc or fix the Pandoc path setting.`,
    );
  }

  let cslPath = "";
  let cslTitle = "";
  if (csl.ok) {
    cslPath = csl.path;
    cslTitle = csl.title;
  } else {
    problems.push(csl.error);
  }

  let pdfEngine = "";
  if (input.format === "pdf") {
    if (input.pdfEngine.trim().length === 0) {
      problems.push(
        "No PDF engine configured. Set a PDF engine (e.g. xelatex, weasyprint, typst) in the plugin settings.",
      );
    } else {
      const resolved = await port.resolveBinary(input.pdfEngine.trim());
      if (resolved === null) {
        problems.push(
          `PDF engine not found: ${input.pdfEngine}. Install it or fix the PDF engine setting.`,
        );
      } else {
        pdfEngine = resolved;
      }
    }
  }

  let referenceDocx = "";
  const configuredReferenceDocx = input.referenceDocx.trim();
  if (input.format === "docx" && configuredReferenceDocx.length > 0) {
    if (await port.isFile(configuredReferenceDocx)) {
      referenceDocx = configuredReferenceDocx;
    } else {
      problems.push(
        `Reference DOCX not found: ${configuredReferenceDocx}. Fix the reference DOCX setting or clear it.`,
      );
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    exportDirectory,
    pandocPath: pandocPath as string,
    pdfEngine,
    referenceDocx,
    cslPath,
    cslTitle,
  };
}

/** Real filesystem + PATH-backed health port. */
export function defaultHealthPort(): HealthFs & HealthProcess {
  return {
    async isDirectory(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async isWritable(path: string): Promise<boolean> {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    async isFile(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    resolveBinary,
  };
}

/**
 * Resolve a configured binary to an absolute executable path. Paths
 * containing a separator are checked directly; bare names are searched on
 * PATH. Returns null when the binary cannot be found or executed.
 */
async function resolveBinary(binary: string): Promise<string | null> {
  const candidate = binary.trim();
  if (candidate.length === 0) {
    return null;
  }
  const hasSeparator =
    candidate.includes("/") ||
    (platform === "win32" && candidate.includes("\\"));
  if (hasSeparator) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    return (await isExecutableFile(absolute)) ? absolute : null;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidatePath = join(dir, candidate);
    if (await isExecutableFile(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
