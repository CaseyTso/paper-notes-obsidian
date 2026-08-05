/**
 * Task 30B — core/plugin protocol contract against the isolated fixture vault
 * (plan Task 30, lines 1506-1556; plugin portion).
 *
 * Proves the paper-notes core ↔ Obsidian plugin protocol by driving the
 * production CLI bridge (`CliClient`, protocol v1) against a fresh copy of
 * the committed fixture vault (`paper-notes/tests/fixtures/v01_vault`,
 * core commit 4595816) and then running the plugin's real consumers
 * (LibraryIndex, MetricsCache, citation inserter, Pandoc exporter) over the
 * result. Everything runs inside OS temp dirs; the core repository is only
 * read (fixture copy + CLI invocation). No network, no real vault, no
 * Zotero, no credentials, no live API.
 *
 * Mirrors plan Task 30 step 2 (plugin portion):
 *   1. create / migrate fixture items        -> CLI `item create` + `migrate`
 *   2. verify schema/layout/hashes           -> canonical layout assertions
 *   3. rebuild citation index                -> CLI `index rebuild`
 *   4. index via plugin contract test        -> LibraryIndex over the vault
 *   5. mocked EasyScholar, Markdown unchanged -> MetricsCache, hash manifest
 *   6. insert single/multiple citations      -> citation-inserter
 *   7. export DOCX (Pandoc)                  -> exportPandoc, real binary
 *   8. rename key and resolve alias          -> CLI rename + plugin alias
 *   9. deletion only on a disposable item    -> CLI delete + plugin index drop
 *  10. deliberately failed migration rolls back -> CLI conflict envelope
 *
 * CROSS-REPO CONTRACT (verified end-to-end): the core migration writes
 * `schema_version: 1` into every migrated main note's raw frontmatter (core
 * repair commit 05720a4, alongside `citation_key` / `paper_id` /
 * `pdf_status` / `reading_status`), and `item create` writes the same. The
 * plugin index (Task 23) requires `schema_version === 1`, so all four
 * migrated fixture notes index as valid plugin records alongside CLI-created
 * items. The assertions below pin this aligned cross-repo behavior.
 */

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  searchCitationCandidates,
  buildCitationText,
  insertCitation,
} from "../src/services/citation-inserter";
import { CliClient, type CliRunResult } from "../src/services/cli-client";
import {
  LibraryIndex,
  SearchCancelledError,
  VaultFileNotFoundError,
  type LiteratureVaultAdapter,
} from "../src/services/library-index";
import { MetricsCache } from "../src/services/metrics-cache";
import {
  aliasMapOf,
  defaultExportPorts,
  exportPandoc,
} from "../src/services/pandoc-export";
import type { ProtocolEnvelope } from "../src/types/protocol";

// ---------------------------------------------------------------------------
// Environment discovery (mirrors tests/pandoc-integration.test.ts patterns).
// ---------------------------------------------------------------------------

/** The paper-notes core repository: a sibling of this plugin repository. */
const CORE_REPO = resolve(__dirname, "..", "..", "paper-notes");
/** Task 30A's committed fixture vault, read-only (copied into temp dirs). */
const FIXTURE = join(CORE_REPO, "tests", "fixtures", "v01_vault");
const LIT = "05 Literature";

/** The user's real vault path; fixture copies and outputs must never contain it. */
const REAL_VAULT =
  process.env.OBSIDIAN_VAULT_PATH ??
  "/Users/juicewrld/Downloads/obsidian/知识库";

/** All temp roots created by this file, removed in afterAll. */
const tempRoots: string[] = [];

/** Synthetic citation keys (Task 30A fixture + CLI-created items). */
const MIGRATED_KEYS = [
  "doeDisposablePaper2027",
  "jonesCardPaper2025",
  "leeMultiPdfTwoCards2026",
  "smithStandardOnePdf2024",
] as const;
/** The migrated fixture note whose year (2026) matches the picker query. */
const MIGRATED_2026_KEY = "leeMultiPdfTwoCards2026";
const MAIN_KEY = "chenSyntheticSlice2026";
const MAIN_RENAMED = "chenSyntheticRenamed2027";
const DISPOSABLE_KEY = "zhaoDisposableSlice2026";
const MAIN_TITLE = "A synthetic vertical slice study";
/**
 * Deliberately free of lexical overlap with every existing fixture/main
 * title: the core's create flow refuses to auto-merge fuzzy duplicates
 * (returns `needs_confirmation`), so a second item needs a distinct title.
 */
const DISPOSABLE_TITLE = "Quantum coherence benchmark item";

function cliWrapper(root: string): string {
  // The production bridge spawns `[cliPath, "--json", ...args]` without a
  // shell or cwd, so the CLI path must be a self-contained executable.
  // The wrapper pins the core repo, strips the polluted PYTHONPATH and runs
  // the real CLI through the interpreter the core supports.
  const wrapper = join(root, "paper-notes-cli");
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `cd ${JSON.stringify(CORE_REPO)} || exit 127`,
      'exec env -u PYTHONPATH python3 -m paper_notes.cli "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return wrapper;
}

const probeRoot = mkdtempSync(join(tmpdir(), "paper-notes-probe-"));
tempRoots.push(probeRoot);
const cliPath = cliWrapper(probeRoot);
const probe = spawnSync(cliPath, ["--json", "version"], { encoding: "utf8" });
let probeOk = false;
if (probe.status === 0) {
  try {
    const parsed = JSON.parse(probe.stdout.trim()) as { protocol_version?: number };
    probeOk = parsed.protocol_version === 1;
  } catch {
    probeOk = false;
  }
}
/** The full contract suite needs the sibling core repo, fixture and CLI. */
const hasCore = existsSync(join(FIXTURE, LIT)) && probeOk;

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function makeVault(): { vault: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "paper-notes-contract-"));
  tempRoots.push(root);
  const vault = join(root, "vault");
  const state = join(root, "state");
  cpSync(FIXTURE, vault, { recursive: true });
  return { vault, state };
}

function dataOf(envelope: ProtocolEnvelope): Record<string, unknown> {
  return envelope.data as Record<string, unknown>;
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : String(value);
}

const client = new CliClient(cliPath);

async function runCli(args: string[]): Promise<CliRunResult> {
  return client.run(args);
}

async function applyMigration(vault: string, state: string): Promise<void> {
  const dry = await runCli([
    "migrate",
    "legacy-obsidian",
    "--vault",
    vault,
    "--state-root",
    state,
    "--dry-run",
  ]);
  expect(dry.envelope.status).toBe("needs_confirmation");
  const data = dataOf(dry.envelope);
  expect(data.items).toHaveLength(4);
  const applied = await runCli([
    "migrate",
    "legacy-obsidian",
    "--apply",
    str(data, "run_id"),
    "--confirm-token",
    str(data, "confirmation_token"),
    "--vault",
    vault,
    "--state-root",
    state,
  ]);
  expect(applied.envelope.status).toBe("success");
}

/** Write a synthetic PDF via the core interpreter (PyMuPDF is a core dep). */
function makeSyntheticPdf(target: string, text: string): void {
  const code = [
    "import fitz",
    `doc = fitz.open()`,
    `page = doc.new_page(width=612, height=792)`,
    `page.insert_text((72, 72), ${JSON.stringify(text)})`,
    `doc.save(${JSON.stringify(target)})`,
    `doc.close()`,
    `print("ok")`,
  ].join("\n");
  const result = spawnSync("env", ["-u", "PYTHONPATH", "python3", "-c", code], {
    cwd: CORE_REPO,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`synthetic PDF generation failed: ${result.stderr}`);
  }
}

async function createItem(
  vault: string,
  key: string,
  title = MAIN_TITLE,
  family = "Chen",
  given = "Wei",
  year = 2026,
  publicationDate = "2026-06-01",
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "paper-notes-create-"));
  tempRoots.push(root);
  const pdf = join(root, "input.pdf");
  makeSyntheticPdf(pdf, `Synthetic create input for ${key}.`);
  const confirmed = join(root, "confirmed.json");
  writeFileSync(
    confirmed,
    JSON.stringify({
      citation_key: key,
      title,
      authors: [{ family, given }],
      publication_date: publicationDate,
      year,
    }),
    "utf8",
  );
  const result = await runCli([
    "item",
    "create",
    "--vault",
    vault,
    "--pdf",
    pdf,
    "--confirmed",
    confirmed,
  ]);
  expect(result.envelope.status).toBe("success");
  expect(str(dataOf(result.envelope), "citation_key")).toBe(key);
}

// ---------------------------------------------------------------------------
// Plugin consumers.
// ---------------------------------------------------------------------------

/** Read-only disk adapter: real canonical notes, real YAML frontmatter. */
class DiskVaultAdapter implements LiteratureVaultAdapter {
  constructor(private readonly vaultRoot: string) {}

  listMarkdownFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full, childRel);
        } else if (entry.name.endsWith(".md")) {
          out.push(childRel);
        }
      }
    };
    walk(this.vaultRoot, "");
    return out.sort();
  }

  getFrontmatter(path: string): Record<string, unknown> | undefined {
    try {
      const text = readFileSync(join(this.vaultRoot, path), "utf8");
      return parseFrontmatter(text);
    } catch {
      return undefined;
    }
  }

  async readText(path: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new SearchCancelledError();
    }
    try {
      return readFileSync(join(this.vaultRoot, path), "utf8");
    } catch {
      throw new VaultFileNotFoundError(path);
    }
  }
}

/**
 * Minimal YAML-subset frontmatter parser covering the exact shapes the core
 * emits (verified against `item create` / `migrate` output): flat scalars,
 * quoted scalars, booleans/numbers, flow `[]` sequences, block sequences of
 * scalars and of maps (`authors:`, `metadata_sources:`), and nested maps
 * (`field_provenance:`). Anything the index does not read stays unparsed.
 */
function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return undefined;
  }
  const { node } = parseBlock(match[1].split(/\r?\n/), 0, 0);
  return node as Record<string, unknown>;
}

function indentation(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") {
    n += 1;
  }
  return n;
}

/** `key: value` map entry; `raw` is the part after `: ` ("" when absent). */
function splitKeyValue(
  line: string,
): { key: string; raw: string } | null {
  const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
  if (match === null) {
    return null;
  }
  return { key: match[1], raw: match[2] ?? "" };
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("'")) {
    const quoted = /^'(.*)'$/.exec(trimmed);
    return quoted === null ? trimmed.slice(1, -1) : quoted[1].replace(/''/g, "'");
  }
  if (trimmed.startsWith('"')) {
    const quoted = /^"(.*)"$/.exec(trimmed);
    return quoted === null
      ? trimmed.slice(1, -1)
      : quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed === "null" || trimmed === "~") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseScalarOrInline(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("[")) {
    const inner = trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed.slice(1);
    if (inner.trim() === "") {
      return [];
    }
    return inner
      .split(",")
      .map((part) => parseScalar(part.trim()))
      .filter((value) => value !== null);
  }
  return parseScalar(trimmed);
}

interface ContentLine {
  index: number;
  ind: number;
  body: string;
}

function nextContentLine(lines: string[], from: number): ContentLine | null {
  for (let i = from; i < lines.length; i += 1) {
    const body = lines[i].trim();
    if (body === "" || body.startsWith("#")) {
      continue;
    }
    return { index: i, ind: indentation(lines[i]), body };
  }
  return null;
}

function parseBlock(
  lines: string[],
  from: number,
  indent: number,
): { node: unknown; next: number } {
  const map: Record<string, unknown> = {};
  let i = from;
  while (i < lines.length) {
    const body = lines[i].trim();
    if (body === "" || body.startsWith("#")) {
      i += 1;
      continue;
    }
    const ind = indentation(lines[i]);
    if (ind < indent) {
      break;
    }
    if (ind > indent) {
      i += 1; // tolerate odd continuation nesting; callers handle depth
      continue;
    }
    const content = lines[i].slice(ind);
    if (content.startsWith("-")) {
      break; // a sequence at this level is handled by parseSequence
    }
    const entry = splitKeyValue(content);
    if (entry === null) {
      i += 1;
      continue;
    }
    if (entry.raw !== "") {
      map[entry.key] = parseScalarOrInline(entry.raw);
      i += 1;
      continue;
    }
    const nested = nextContentLine(lines, i + 1);
    if (nested === null) {
      map[entry.key] = null;
      i += 1;
      continue;
    }
    if (nested.body.startsWith("-")) {
      const sequence = parseSequence(lines, nested.index, nested.ind);
      map[entry.key] = sequence.node;
      i = sequence.next;
      continue;
    }
    if (nested.ind > indent) {
      const child = parseBlock(lines, nested.index, nested.ind);
      map[entry.key] = child.node;
      i = child.next;
      continue;
    }
    map[entry.key] = null;
    i += 1;
  }
  return { node: map, next: i };
}

function parseSequence(
  lines: string[],
  from: number,
  indent: number,
): { node: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = from;
  while (i < lines.length) {
    const body = lines[i].trim();
    if (body === "" || body.startsWith("#")) {
      i += 1;
      continue;
    }
    const ind = indentation(lines[i]);
    if (ind < indent || ind > indent) {
      break;
    }
    const content = lines[i].slice(ind);
    if (!content.startsWith("-")) {
      break;
    }
    const rest = content.slice(1).trimStart();
    if (rest === "") {
      const child = parseBlock(lines, i + 1, ind + 2);
      items.push(child.node);
      i = child.next;
      continue;
    }
    const entry = splitKeyValue(rest);
    if (entry === null) {
      items.push(parseScalar(rest));
      i += 1;
      continue;
    }
    const item: Record<string, unknown> = {};
    item[entry.key] =
      entry.raw === "" ? null : parseScalarOrInline(entry.raw);
    i += 1;
    while (i < lines.length) {
      const contBody = lines[i].trim();
      if (contBody === "" || contBody.startsWith("#")) {
        i += 1;
        continue;
      }
      const contInd = indentation(lines[i]);
      if (contInd <= ind) {
        break;
      }
      const contEntry = splitKeyValue(lines[i].slice(contInd));
      if (contEntry === null) {
        i += 1;
        continue;
      }
      item[contEntry.key] =
        contEntry.raw === "" ? null : parseScalarOrInline(contEntry.raw);
      i += 1;
    }
    items.push(item);
  }
  return { node: items, next: i };
}

// ---------------------------------------------------------------------------
// Manifest helpers.
// ---------------------------------------------------------------------------

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mdHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, childRel);
      } else if (entry.name.endsWith(".md")) {
        out[childRel] = sha256(readFileSync(full));
      }
    }
  };
  walk(root, "");
  return out;
}

function treeManifest(root: string): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, childRel);
      } else {
        out.push([
          childRel,
          statSync(full).size,
          sha256(readFileSync(full)),
        ]);
      }
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function walkFiles(root: string, visit: (file: string) => void): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        visit(full);
      }
    }
  };
  walk(root);
}

function indexRecords(vault: string): LibraryIndex {
  const index = new LibraryIndex(new DiskVaultAdapter(vault), LIT);
  index.scanAll();
  return index;
}

// ---------------------------------------------------------------------------
// Pandoc availability (same probes as tests/pandoc-integration.test.ts).
// ---------------------------------------------------------------------------

function binaryAvailable(name: string): boolean {
  try {
    const check = spawnSync(name, ["--version"], { stdio: "ignore" });
    return check.status === 0;
  } catch {
    return false;
  }
}

const hasPandoc = binaryAvailable("pandoc");

function pandocBinaryPath(): string {
  const which = spawnSync("which", ["pandoc"], { encoding: "utf8" });
  return (which.stdout ?? "").trim() || "pandoc";
}

const MINIMAL_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>Minimal Contract Style</title>
    <id>http://example.org/styles/minimal-contract</id>
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

function docxText(target: string): string {
  return execFileSync("pandoc", ["-f", "docx", "-t", "plain", target], {
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// The contract suite.
// ---------------------------------------------------------------------------

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe.skipIf(!hasCore)("core/plugin contract against the fixture vault", () => {
  it(
    "probes the core CLI and reports protocol v1 compatibility",
    async () => {
      const probeResult = await client.probe();
      expect(probeResult.compatible).toBe(true);
      expect(probeResult.protocolVersion).toBe(1);
      expect(probeResult.readOnlyMode).toBe(false);
      expect(probeResult.cliVersion).toBeTruthy();
    },
    60_000,
  );

  it(
    "migrates the fixture and rebuilds the citation index through the production CLI bridge",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);

      // canonical layout: key-named directory, key-named main note + PDF
      for (const key of MIGRATED_KEYS) {
        expect(existsSync(join(vault, LIT, key, `${key}.md`))).toBe(true);
        expect(existsSync(join(vault, LIT, key, `${key}.pdf`))).toBe(true);
      }
      // legacy title-folder names are gone
      expect(existsSync(join(vault, LIT, "Standard Single PDF 2024"))).toBe(false);

      const rebuilt = await runCli(["index", "rebuild", "--vault", vault]);
      expect(rebuilt.envelope.status).toBe("success");
      const data = dataOf(rebuilt.envelope);
      expect(data.papers).toBe(4);
      expect(data.invalid_count).toBe(0);
      const library = JSON.parse(
        readFileSync(join(vault, ".paper-notes", "library.json"), "utf8"),
      ) as Array<{ id: string }>;
      expect(library.map((entry) => entry.id).sort()).toEqual(
        [...MIGRATED_KEYS].sort(),
      );
      const aliases = JSON.parse(
        readFileSync(join(vault, ".paper-notes", "citation-aliases.json"), "utf8"),
      );
      expect(aliases).toEqual({});
    },
    120_000,
  );

  it(
    "indexes the migrated fixture notes as valid records (core writes schema_version: 1)",
    async () => {
      // Core repair (commit 05720a4) makes the migration write
      // `schema_version: 1` into every migrated main note's raw frontmatter,
      // so the plugin index (Task 23) accepts all four migrated fixture
      // notes as valid records. Pin the aligned contract.
      const { vault, state } = makeVault();
      await applyMigration(vault, state);

      const index = indexRecords(vault);
      expect(index.getRecords().map((record) => record.key).sort()).toEqual(
        [...MIGRATED_KEYS].sort(),
      );
      expect(index.isReadOnly()).toBe(false);
      expect(index.getInvalidRecords()).toHaveLength(0);
    },
    120_000,
  );

  it(
    "indexes a CLI-created canonical item as a valid plugin record",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);

      const index = indexRecords(vault);
      const record = index.getRecordByKey(MAIN_KEY);
      expect(record).toBeDefined();
      expect(record!.key).toBe(MAIN_KEY);
      expect(record!.title).toBe(MAIN_TITLE);
      expect(record!.year).toBe(2026);
      expect(record!.authors[0]).toMatchObject({ family: "Chen", given: "Wei" });
      expect(index.search("synthetic").map((r) => r.key)).toContain(MAIN_KEY);
      // the migrated fixture notes are valid too (schema_version written by
      // the core migration), so nothing remains invalid
      expect(index.getInvalidRecords()).toHaveLength(0);
    },
    120_000,
  );

  it(
    "never auto-merges a fuzzy-duplicate create: needs_confirmation and no write",
    async () => {
      // The core's create flow treats lexically similar titles as fuzzy
      // duplicates and requires explicit confirmation; nothing is written.
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);

      const root = mkdtempSync(join(tmpdir(), "paper-notes-probe-"));
      tempRoots.push(root);
      const pdf = join(root, "input.pdf");
      makeSyntheticPdf(pdf, "Near-duplicate create input.");
      const confirmed = join(root, "confirmed.json");
      writeFileSync(
        confirmed,
        JSON.stringify({
          // shares "disposable"/"deletion" with doeDisposablePaper2027
          citation_key: "nearDuplicateProbe2026",
          title: "Disposable deletion target paper",
          authors: [{ family: "Zhao", given: "Lin" }],
          publication_date: "2026-06-01",
          year: 2026,
        }),
        "utf8",
      );
      const result = await runCli([
        "item",
        "create",
        "--vault",
        vault,
        "--pdf",
        pdf,
        "--confirmed",
        confirmed,
      ]);
      expect(result.envelope.status).toBe("needs_confirmation");
      const data = dataOf(result.envelope);
      const candidates = data.candidates as unknown as Array<{
        citation_key: string;
      }>;
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.map((candidate) => candidate.citation_key)).toContain(
        "doeDisposablePaper2027",
      );
      // confirmation was never given: nothing was created
      expect(existsSync(join(vault, LIT, "nearDuplicateProbe2026"))).toBe(false);
    },
    120_000,
  );

  it(
    "keeps every Markdown hash unchanged when EasyScholar metrics are queried (volatile UI data)",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      const mdBefore = mdHashes(vault);
      const treeBefore = treeManifest(vault);

      const calls: string[][] = [];
      const mockedClient: Pick<CliClient, "run"> = {
        run: async (args: string[]) => {
          calls.push(args);
          return {
            envelope: {
              protocol_version: 1,
              status: "success",
              data: {
                metrics: {
                  journal: "Nature Medicine",
                  metrics: {
                    if: 82.9,
                    jci: 8.11,
                    jcr_partition: "Q1",
                    cas_partition: "1区",
                  },
                },
              },
              warnings: [],
              errors: [],
            } satisfies ProtocolEnvelope,
            exitCode: 0,
            stderr: "",
          };
        },
      };
      const persisted: unknown[] = [];
      const cache = new MetricsCache({
        client: mockedClient,
        ttlDays: () => 30,
        enabled: () => true,
        load: async () => ({}),
        save: async (payload) => {
          persisted.push(payload);
        },
        now: () => 1_700_000_000_000,
      });

      const result = await cache.refresh({ journal: "Nature Medicine" });
      expect(result.status).toBe("refreshed");
      expect(cache.getEntryFor({ journal: "Nature Medicine" })?.metrics).toEqual({
        if: 82.9,
        jci: 8.11,
        jcr: "Q1",
        cas: "1区",
      });
      // the only CLI operation ever issued is the read-only metrics query
      expect(calls).toEqual([["metrics", "query", "--journal", "Nature Medicine"]]);
      // volatile UI data: the vault is untouched
      expect(mdHashes(vault)).toEqual(mdBefore);
      expect(treeManifest(vault)).toEqual(treeBefore);
      // persisted data.json payload carries only non-sensitive fields
      expect(JSON.stringify(persisted[0])).not.toContain("sk-");
    },
    120_000,
  );

  it(
    "inserts single and multi citations from the fixture records",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);
      await createItem(vault, DISPOSABLE_KEY, DISPOSABLE_TITLE, "Zhao", "Lin");

      const index = indexRecords(vault);
      const main = index.getRecordByKey(MAIN_KEY);
      const disposable = index.getRecordByKey(DISPOSABLE_KEY);
      expect(main).toBeDefined();
      expect(disposable).toBeDefined();

      expect(buildCitationText([main!])).toBe(`[@${MAIN_KEY}]`);
      expect(buildCitationText([main!, disposable!])).toBe(
        `[@${MAIN_KEY}; @${DISPOSABLE_KEY}]`,
      );
      expect(
        searchCitationCandidates(index.getRecords(), "2026").map((r) => r.key),
      ).toEqual([MAIN_KEY, MIGRATED_2026_KEY, DISPOSABLE_KEY]);

      const edits: string[] = [];
      const editor = { replaceSelection: (text: string) => edits.push(text) };
      insertCitation(editor, [main!]);
      expect(edits).toEqual([`[@${MAIN_KEY}]`]);
    },
    120_000,
  );

  it(
    "renames a key through the CLI and the plugin index resolves the old key as an alias",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);

      const preview = await runCli([
        "item",
        "rename-key",
        "--vault",
        vault,
        "--key",
        MAIN_KEY,
        "--new-key",
        MAIN_RENAMED,
        "--dry-run",
      ]);
      expect(preview.envelope.status).toBe("needs_confirmation");
      const token = str(dataOf(preview.envelope), "confirmation_token");
      const confirmed = await runCli([
        "item",
        "rename-key",
        "--vault",
        vault,
        "--key",
        MAIN_KEY,
        "--new-key",
        MAIN_RENAMED,
        "--confirm-token",
        token,
      ]);
      expect(confirmed.envelope.status).toBe("success");
      expect(str(dataOf(confirmed.envelope), "citation_key")).toBe(MAIN_RENAMED);
      expect(existsSync(join(vault, LIT, MAIN_RENAMED, `${MAIN_RENAMED}.md`))).toBe(true);
      expect(existsSync(join(vault, LIT, MAIN_KEY))).toBe(false);

      // rename preserves schema_version, so the renamed item stays a valid
      // record and the old key resolves through the reserved alias
      const index = indexRecords(vault);
      const renamed = index.getRecordByKey(MAIN_RENAMED);
      expect(renamed).toBeDefined();
      expect(renamed!.citationKeyAliases).toContain(MAIN_KEY);
      expect(index.getRecordByKey(MAIN_KEY)?.key).toBe(MAIN_RENAMED);
      expect(aliasMapOf(index.getRecords())).toEqual({
        [MAIN_KEY]: MAIN_RENAMED,
      });
    },
    120_000,
  );

  it(
    "deletes only a disposable created item and the plugin index drops it",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);
      await createItem(vault, DISPOSABLE_KEY, DISPOSABLE_TITLE, "Zhao", "Lin");

      const index = indexRecords(vault);
      expect(index.getRecordByKey(DISPOSABLE_KEY)).toBeDefined();

      const preview = await runCli([
        "item",
        "delete",
        "--vault",
        vault,
        "--key",
        DISPOSABLE_KEY,
        "--dry-run",
      ]);
      expect(preview.envelope.status).toBe("needs_confirmation");
      const data = dataOf(preview.envelope);
      const confirmed = await runCli([
        "item",
        "delete",
        "--vault",
        vault,
        "--key",
        DISPOSABLE_KEY,
        "--confirm-key",
        DISPOSABLE_KEY,
        "--confirm-token",
        str(data, "confirmation_token"),
      ]);
      expect(confirmed.envelope.status).toBe("success");
      expect(existsSync(join(vault, LIT, DISPOSABLE_KEY))).toBe(false);

      index.scanAll();
      expect(index.getRecordByKey(DISPOSABLE_KEY)).toBeUndefined();
      expect(index.getRecordByKey(MAIN_KEY)).toBeDefined();
    },
    120_000,
  );

  it.skipIf(!hasPandoc)(
    "exports a DOCX whose bibliography renders the fixture records (current key and alias)",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);

      const preview = await runCli([
        "item",
        "rename-key",
        "--vault",
        vault,
        "--key",
        MAIN_KEY,
        "--new-key",
        MAIN_RENAMED,
        "--dry-run",
      ]);
      const token = str(dataOf(preview.envelope), "confirmation_token");
      await runCli([
        "item",
        "rename-key",
        "--vault",
        vault,
        "--key",
        MAIN_KEY,
        "--new-key",
        MAIN_RENAMED,
        "--confirm-token",
        token,
      ]);

      const index = indexRecords(vault);
      const records = index.getRecords();
      // all four migrated fixture notes are valid now (schema_version written
      // by the core migration) plus the renamed CLI-created item
      expect(records.map((record) => record.key).sort()).toEqual(
        [...MIGRATED_KEYS, MAIN_RENAMED].sort(),
      );
      expect(aliasMapOf(records)).toEqual({ [MAIN_KEY]: MAIN_RENAMED });

      const root = mkdtempSync(join(tmpdir(), "paper-notes-export-"));
      tempRoots.push(root);
      const manuscript = join(root, "manuscript.md");
      writeFileSync(
        manuscript,
        [
          "# Manuscript",
          "",
          "Synthetic study [@" + MAIN_RENAMED + "] and its legacy key [@" + MAIN_KEY + "].",
          "",
        ].join("\n"),
        "utf8",
      );
      const cslPath = join(root, "minimal.csl");
      writeFileSync(cslPath, MINIMAL_CSL, "utf8");

      const result = await exportPandoc(
        {
          format: "docx",
          baseName: "contract-manuscript",
          markdown: readFileSync(manuscript, "utf8"),
          markdownPath: manuscript,
          exportDirectory: root,
          pandocPath: pandocBinaryPath(),
          pdfEngine: "",
          cslPath,
          referenceDocx: "",
          records,
        },
        defaultExportPorts(),
      );

      expect(result.status).toBe("success");
      expect(existsSync(result.targetPath as string)).toBe(true);
      const text = docxText(result.targetPath as string);
      // the alias filter rewrote the legacy key; citeproc renders the item
      expect(text).toContain(MAIN_TITLE);
    },
    180_000,
  );

  it(
    "returns a conflict envelope for a deliberately failed migration and rolls back cleanly",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "paper-notes-conflict-"));
      tempRoots.push(root);
      const vault = join(root, "vault");
      const state = join(root, "state");
      cpSync(FIXTURE, vault, { recursive: true });
      const before = treeManifest(vault);

      const dry = await runCli([
        "migrate",
        "legacy-obsidian",
        "--vault",
        vault,
        "--state-root",
        state,
        "--dry-run",
      ]);
      expect(dry.envelope.status).toBe("needs_confirmation");
      const data = dataOf(dry.envelope);
      // pre-seed the LAST-processed target (Standard is last alphabetically):
      // the first three items are switched, then this conflict fires
      const target = join(vault, LIT, "smithStandardOnePdf2024");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "smithStandardOnePdf2024.md"), "occupied\n", "utf8");

      const conflict = await runCli([
        "migrate",
        "legacy-obsidian",
        "--apply",
        str(data, "run_id"),
        "--confirm-token",
        str(data, "confirmation_token"),
        "--vault",
        vault,
        "--state-root",
        state,
      ]);
      expect(conflict.envelope.status).toBe("conflict");
      // auto-rollback restored the items switched before the conflict
      for (const key of ["doeDisposablePaper2027", "jonesCardPaper2025", "leeMultiPdfTwoCards2026"]) {
        expect(existsSync(join(vault, LIT, key))).toBe(false);
      }
      expect(readFileSync(join(target, "smithStandardOnePdf2024.md"), "utf8")).toBe(
        "occupied\n",
      );

      // once the racer is gone a fresh plan applies, verifies and rolls back
      rmSync(target, { recursive: true, force: true });
      const dry2 = await runCli([
        "migrate",
        "legacy-obsidian",
        "--vault",
        vault,
        "--state-root",
        state,
        "--dry-run",
      ]);
      const data2 = dataOf(dry2.envelope);
      const applied2 = await runCli([
        "migrate",
        "legacy-obsidian",
        "--apply",
        str(data2, "run_id"),
        "--confirm-token",
        str(data2, "confirmation_token"),
        "--vault",
        vault,
        "--state-root",
        state,
      ]);
      expect(applied2.envelope.status).toBe("success");
      const verify = await runCli([
        "migrate",
        "verify",
        str(data2, "run_id"),
        "--vault",
        vault,
        "--state-root",
        state,
      ]);
      expect(verify.envelope.status).toBe("success");
      const rolled = await runCli([
        "migrate",
        "rollback",
        str(data2, "run_id"),
        "--vault",
        vault,
        "--state-root",
        state,
      ]);
      expect(rolled.envelope.status).toBe("success");
      expect(dataOf(rolled.envelope).action).toBe("rolled_back");
      expect(treeManifest(vault)).toEqual(before);
    },
    180_000,
  );

  it(
    "produces no output containing the real vault path",
    async () => {
      const { vault, state } = makeVault();
      await applyMigration(vault, state);
      await createItem(vault, MAIN_KEY);
      await runCli(["index", "rebuild", "--vault", vault]);

      const hits: string[] = [];
      for (const root of [vault, state]) {
        walkFiles(root, (file) => {
          const content = readFileSync(file, "utf8");
          if (content.includes(REAL_VAULT)) {
            hits.push(file);
          }
        });
      }
      expect(hits).toEqual([]);
    },
    120_000,
  );
});
