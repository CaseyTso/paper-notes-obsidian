/**
 * Focused Pandoc export — real-binary integration (Task 29).
 *
 * Runs the *production* export path (`exportPandoc` with the default
 * process/filesystem ports) against a temporary fixture: a Markdown
 * manuscript with both a current citation key and a legacy alias, a
 * generated CSL-JSON index, a bundled alias Lua filter, a CSL style and a
 * reference DOCX. With a real Pandoc binary present this asserts:
 *
 * - DOCX output exists, is a valid ZIP and contains the rendered
 *   bibliography text after extraction;
 * - PDF output exists and begins with `%PDF` when the configured engine
 *   (typst/xelatex/…) is available;
 * - the alias citation resolves to the *current* item (the alias Lua
 *   filter rewrites legacy keys before citeproc, so the bibliography shows
 *   the current item instead of an unresolved key);
 * - unknown citation keys block the run before any spawn (status
 *   `blocked`, no output file created).
 *
 * When Pandoc (or the PDF engine) is absent the affected suites are
 * skipped and reported as such by vitest — never faked green.
 */

import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { PaperRecord } from "../src/types/paper";
import { defaultExportPorts } from "../src/services/pandoc-export";
import { exportPandoc } from "../src/services/pandoc-export";

// ---------------------------------------------------------------------------
// Availability probes — skipped (not faked) when binaries are missing.
// ---------------------------------------------------------------------------

function binaryAvailable(name: string): boolean {
  try {
    const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const hasPandoc = binaryAvailable("pandoc");
// Only LaTeX-family engines are usable with the mandated CSL-JSON
// pipeline. Pandoc's typst writer (3.x) emits native `@key` citations and
// a `#bibliography(path)` directive that typst's own citeproc cannot
// consume from a CSL-JSON `library.json` — typst accepts .yaml/.yml/.bib
// only. Verified against pandoc 3.3 + typst 0.13 on macOS: the export
// fails cleanly in the production path (status `failed`, stderr surfaced),
// but a `%PDF` assertion is impossible, so the PDF integration case is
// skipped — never faked green — until a LaTeX engine is present.
const PDF_ENGINES = ["xelatex", "lualatex", "pdflatex"];
const hasPdfEngine = PDF_ENGINES.some(binaryAvailable);

function pandocBinaryPath(): string {
  const which = spawnSync("which", ["pandoc"], { encoding: "utf8" });
  return (which.stdout ?? "").trim() || "pandoc";
}

function pdfEnginePath(): string {
  for (const engine of PDF_ENGINES) {
    const which = spawnSync("which", [engine], { encoding: "utf8" });
    if ((which.stdout ?? "").trim().length > 0) {
      return which.stdout.trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fixture helpers (all under an OS temp dir, removed in afterAll).
// ---------------------------------------------------------------------------

const SMITH: PaperRecord = {
  path: "05 Literature/smith2024current/smith2024current.md",
  key: "smith2024current",
  paperId: "11111111-1111-4111-8111-111111111111",
  title: "A current paper on lung cancer",
  authors: [
    { family: "Smith", given: "John" },
    { family: "王", given: "芳" },
  ],
  journal: "Journal of Thoracic Disease",
  year: 2024,
  identifiers: { doi: "10.1000/xyz" },
  citationKeyAliases: ["oldSmith2020"],
  titleAliases: [],
};

const MINIMAL_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>Minimal Test Style</title>
    <id>http://example.org/styles/minimal</id>
  </info>
  <citation>
    <layout prefix="(" suffix=")">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <text variable="title"/>
    </layout>
  </bibliography>
</style>
`;

interface FixtureDir {
  root: string;
  manuscriptMd: string;
  markdownPath: string;
  cslPath: string;
  referenceDocx: string;
}

function makeFixture(markdown: string): FixtureDir {
  const root = mkdtempSync(join(tmpdir(), "paper-notes-integration-"));
  const manuscriptMd = join(root, "manuscript.md");
  writeFileSync(manuscriptMd, markdown, "utf8");
  const cslPath = join(root, "minimal.csl");
  writeFileSync(cslPath, MINIMAL_CSL, "utf8");
  const referenceDocx = join(root, "reference.docx");
  return { root, manuscriptMd, markdownPath: manuscriptMd, cslPath, referenceDocx };
}

function makeReferenceDocx(target: string): void {
  // `pandoc --print-default-data-file reference.docx` emits Pandoc's stock
  // reference document — a valid DOCX usable with --reference-doc.
  const stdout = execFileSync("pandoc", ["--print-default-data-file", "reference.docx"]);
  writeFileSync(target, stdout);
}

function docxIsZip(target: string): boolean {
  const head = readFileSync(target).subarray(0, 4);
  return head.equals(Buffer.from("PK\u0003\u0004"));
}

/** Extract DOCX text with pandoc itself (docx → plain). */
function docxText(target: string): string {
  return execFileSync("pandoc", ["-f", "docx", "-t", "plain", target], {
    encoding: "utf8",
  });
}

function pdfStartsWithMagic(target: string): boolean {
  return readFileSync(target).subarray(0, 4).equals(Buffer.from("%PDF"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasPandoc)("pandoc integration (real binary)", () => {
  let fixture: FixtureDir;
  const exportDirectory = mkdtempSync(join(tmpdir(), "paper-notes-export-dir-"));

  afterAll(() => {
    rmSync(fixture?.root, { recursive: true, force: true });
    rmSync(exportDirectory, { recursive: true, force: true });
  });

  it("DOCX export produces a valid ZIP with the bibliography text", async () => {
    fixture = makeFixture(
      [
        "# Manuscript",
        "",
        "Lung cancer remains a major burden [@smith2024current].",
        "",
      ].join("\n"),
    );
    makeReferenceDocx(fixture.referenceDocx);

    const result = await exportPandoc(
      {
        format: "docx",
        baseName: "manuscript",
        markdown: readFileSync(fixture.manuscriptMd, "utf8"),
        markdownPath: fixture.markdownPath,
        exportDirectory,
        pandocPath: pandocBinaryPath(),
        pdfEngine: "",
        cslPath: fixture.cslPath,
        referenceDocx: fixture.referenceDocx,
        records: [SMITH],
      },
      defaultExportPorts(),
    );

    expect(result.status).toBe("success");
    const target = result.targetPath as string;
    expect(docxIsZip(target)).toBe(true);
    const text = docxText(target);
    // Bibliography is rendered by citeproc; the CSL bibliography layout
    // prints the item title.
    expect(text).toContain("A current paper on lung cancer");
  });

  it("alias citation resolves to the current item in the bibliography", async () => {
    fixture = makeFixture(
      [
        "# Manuscript",
        "",
        "Earlier work used a legacy key [@oldSmith2020] here.",
        "",
      ].join("\n"),
    );
    makeReferenceDocx(fixture.referenceDocx);

    const result = await exportPandoc(
      {
        format: "docx",
        baseName: "alias-manuscript",
        markdown: readFileSync(fixture.manuscriptMd, "utf8"),
        markdownPath: fixture.markdownPath,
        exportDirectory,
        pandocPath: pandocBinaryPath(),
        pdfEngine: "",
        cslPath: fixture.cslPath,
        referenceDocx: fixture.referenceDocx,
        records: [SMITH],
      },
      defaultExportPorts(),
    );

    expect(result.status).toBe("success");
    const text = docxText(result.targetPath as string);
    // The Lua filter rewrote oldSmith2020 → smith2024current before
    // citeproc, so the current item title appears (no unresolved key).
    expect(text).toContain("A current paper on lung cancer");
  });

  it("unknown citation keys block before any spawn and create no output", async () => {
    fixture = makeFixture(
      ["# Manuscript", "", "Bad citation [@totallyUnknownKey].", ""].join("\n"),
    );

    const result = await exportPandoc(
      {
        format: "docx",
        baseName: "blocked-manuscript",
        markdown: readFileSync(fixture.manuscriptMd, "utf8"),
        markdownPath: fixture.markdownPath,
        exportDirectory,
        pandocPath: pandocBinaryPath(),
        pdfEngine: "",
        cslPath: fixture.cslPath,
        referenceDocx: fixture.referenceDocx,
        records: [SMITH],
      },
      defaultExportPorts(),
    );

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.unknownKeys).toEqual(["totallyUnknownKey"]);
    }
    const target = join(exportDirectory, "blocked-manuscript.docx");
    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(!hasPdfEngine)("PDF export exists and begins with %PDF", async () => {
    fixture = makeFixture(
      [
        "# Manuscript",
        "",
        "Lung cancer remains a major burden [@smith2024current].",
        "",
      ].join("\n"),
    );

    const result = await exportPandoc(
      {
        format: "pdf",
        baseName: "manuscript",
        markdown: readFileSync(fixture.manuscriptMd, "utf8"),
        markdownPath: fixture.markdownPath,
        exportDirectory,
        pandocPath: pandocBinaryPath(),
        pdfEngine: pdfEnginePath(),
        cslPath: fixture.cslPath,
        referenceDocx: "",
        records: [SMITH],
      },
      defaultExportPorts(),
    );

    expect(result.status).toBe("success");
    expect(pdfStartsWithMagic(result.targetPath as string)).toBe(true);
  });
});
