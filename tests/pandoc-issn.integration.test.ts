/** Real regression: old ISSN arrays fail Pandoc; one scalar boundary fixes all writers. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  aliasMapOf, buildAliasLuaFilter, defaultExportPorts, exportPandoc, generateCslJson,
} from "../src/services/pandoc-export";
import type { PaperRecord } from "../src/types/paper";

const available = (binary: string): boolean => spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
const hasPandoc = available("pandoc");
const naturePath = fileURLToPath(new URL("./fixtures/nature.csl", import.meta.url));
const markdown = "# Synthetic ISSN regression\n\nCitations [@legacyAlpha; @beta2025].\n";
const records: PaperRecord[] = [
  {
    path: "Synthetic/alpha2024/alpha2024.md", key: "alpha2024", paperId: "11111111-1111-4111-8111-111111111111",
    title: "Alpha multi ISSN regression paper", authors: [{ family: "Alpha", given: "Ann" }],
    journal: "Synthetic Journal", journalAbbreviation: "Synth. J.", year: 2024, publicationDate: "2024-03-02",
    volume: "12", issue: "3", pages: "100-110", identifiers: { doi: "10.1000/synthetic-alpha" },
    citationKeyAliases: ["legacyAlpha"], titleAliases: ["Earlier synthetic title"],
    issn: ["1234-5678", "8765-4321"], language: "en", abstract: "Synthetic metadata retained unchanged.",
  },
  {
    path: "Synthetic/beta2025/beta2025.md", key: "beta2025", paperId: "22222222-2222-4222-8222-222222222222",
    title: "Beta single ISSN regression paper", authors: [{ literal: "Synthetic Study Group" }],
    journal: "Another Synthetic Journal", year: 2025, identifiers: {}, citationKeyAliases: [], titleAliases: [], issn: ["1111-2222"],
  },
  {
    path: "Synthetic/uncited2026/uncited2026.md", key: "uncited2026", paperId: "33333333-3333-4333-8333-333333333333",
    title: "Uncited paper must not be discarded", authors: [], year: 2026,
    identifiers: {}, citationKeyAliases: [], titleAliases: [], issn: ["3333-4444", "5555-6666"],
  },
];
const before = structuredClone(records);
for (const record of records) { Object.freeze(record.issn); Object.freeze(record); }

// Optional evidence retention is restricted to a fresh synthetic fixture directory.
// Default runs clean up all outputs, never touch vaults or installed plugin files.
const artifactsBase = process.env.PANDOC_TEST_ARTIFACTS;
let root: string;
const evidence: unknown[] = [];
function fixture(): string {
  if (root) return root;
  const base = artifactsBase ? resolve(artifactsBase) : tmpdir();
  if (artifactsBase) mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "paper-notes-issn-"));
  writeFileSync(join(root, "manuscript.md"), markdown);
  writeFileSync(join(root, "source-records.json"), JSON.stringify(before, null, 2));
  writeFileSync(join(root, "nature.csl"), readFileSync(naturePath));
  writeFileSync(join(root, "library.json"), generateCslJson(records));
  writeFileSync(join(root, "alias.lua"), buildAliasLuaFilter(aliasMapOf(records)));
  return root;
}
function checkLibrary(json: string): void {
  const items = JSON.parse(json) as Array<{ id: string; ISSN: string }>;
  expect(items.map((item) => item.id)).toEqual(["alpha2024", "beta2025", "uncited2026"]);
  expect(items.map((item) => item.ISSN)).toEqual(["1234-5678, 8765-4321", "1111-2222", "3333-4444, 5555-6666"]);
  expect(records).toEqual(before);
}

afterAll(() => {
  if (!root) return;
  writeFileSync(join(root, "evidence.json"), JSON.stringify({
    pandoc: spawnSync("pandoc", ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0],
    runs: evidence,
  }, null, 2));
  expect(records).toEqual(before);
  expect(JSON.parse(readFileSync(join(root, "source-records.json"), "utf8"))).toEqual(before);
  if (artifactsBase) console.log(`ISSN integration artifacts: ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPandoc)("ISSN real Pandoc regression (Nature CSL)", () => {
  it("reproduces Pandoc's array parse failure without dropping any records", () => {
    const dir = fixture();
    const oldItems = JSON.parse(generateCslJson(records));
    for (const item of oldItems) item.ISSN = records.find((record) => record.key === item.id)!.issn;
    const oldPath = join(dir, "old-array-library.json");
    writeFileSync(oldPath, JSON.stringify(oldItems, null, 2));
    const args = ["--from", "markdown", "--to", "markdown", "--citeproc", "--bibliography", oldPath, "--csl", naturePath, join(dir, "manuscript.md")];
    const run = spawnSync("pandoc", args, { encoding: "utf8" });
    evidence.push({ case: "old-array-negative-control", command: "pandoc", args, exitCode: run.status, stderr: run.stderr });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/parsing.*Text.*Array|expected.*String.*Array/is);
    expect(oldItems).toHaveLength(3);
  });

  it("the shared CSL boundary parses and renders Markdown with all ISSN values", () => {
    const dir = fixture();
    checkLibrary(readFileSync(join(dir, "library.json"), "utf8"));
    const target = join(dir, "rendered.md");
    const args = ["--from", "markdown", "--to", "markdown", "--lua-filter", join(dir, "alias.lua"), "--citeproc", "--bibliography", join(dir, "library.json"), "--csl", naturePath, "-o", target, join(dir, "manuscript.md")];
    const run = spawnSync("pandoc", args, { encoding: "utf8" });
    evidence.push({ case: "markdown", command: "pandoc", args, exitCode: run.status, stderr: run.stderr });
    expect(run.status, run.stderr).toBe(0);
    const output = readFileSync(target, "utf8").replace(/\s+/g, " ");
    expect(output).toContain(records[0].title);
    expect(output).toContain(records[1].title);
    expect(output).not.toContain("legacyAlpha");
  });

  it("production docx export succeeds with whole-library ISSNs and Nature CSL", async () => {
    const dir = fixture();
    const ports = defaultExportPorts();
    const realWrite = ports.fs.writeText;
    ports.fs.writeText = async (path, content) => {
      if (path.endsWith("library.json")) {
        checkLibrary(content);
        writeFileSync(join(dir, "docx-library.json"), content);
      }
      await realWrite(path, content);
    };
    const realRunner = ports.runner;
    ports.runner = (command, args, options) => {
      evidence.push({ case: "docx", command, args });
      return realRunner(command, args, options);
    };
    const result = await exportPandoc({
      format: "docx", baseName: "manuscript", markdown, markdownPath: join(dir, "manuscript.md"),
      exportDirectory: dir, pandocPath: "pandoc",
      cslPath: naturePath, referenceDocx: "", records,
    }, ports);
    evidence.push({ case: "docx", result });
    expect(result.status, result.stderr).toBe("success");
    const target = result.targetPath!;
    expect(existsSync(target)).toBe(true);
    const magic = readFileSync(target).subarray(0, 4).toString();
    expect(magic).toBe("PK\u0003\u0004");
    const text = execFileSync("pandoc", ["-f", "docx", "-t", "plain", target], { encoding: "utf8" });
    writeFileSync(join(dir, "docx-text.txt"), text);
    expect(text).toContain(records[0].title);
    expect(text).toContain(records[1].title);
    expect(text).not.toContain("legacyAlpha");
  });

});
