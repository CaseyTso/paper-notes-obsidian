/**
 * CLI-backed item actions (Task 25).
 *
 * Every mutation the Library can trigger is routed through the paper-notes
 * core CLI (`item create / update / attach-pdf / rename-key / delete`) —
 * the plugin never writes YAML, never edits the vault directly, and never
 * starts MinerU or Hermes jobs (design spec §9.5). The core CLI performs
 * all managed writes (lock, staging, atomic replacement, index rebuild).
 *
 * Confirmation flows (design spec §7.3, §8.2, §8.3, §9.5):
 * - `needs_confirmation` envelopes carry a `confirmation_token` plus a
 *   machine-readable `plan` (and `candidates` for fuzzy duplicates). The
 *   caller shows the rendered plan and resubmits with the token.
 * - `item create` has no `--confirm-token` flag: its token is derived
 *   deterministically from identifiers + PDF hash + confirmed values, so
 *   the resubmission carrier is the `--confirmed` JSON file holding the
 *   user-confirmed values (core recomputes and verifies the token).
 * - `item rename-key` and `item delete` always preview (`--dry-run`)
 *   before any confirm; delete additionally requires the exact citation
 *   key (`--confirm-key`) per spec §8.3.
 *
 * Transport errors (missing CLI, timeout, protocol mismatch, ...) are
 * mapped to `error` outcomes — there is deliberately no fallback path
 * that writes to the vault directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CliClient, CliError } from "./cli-client";
import type { ProtocolEnvelope } from "../types/protocol";
import type { ReadingStatus } from "../components/library-table";

/** Sources accepted by `item create` (spec §7.1). */
export interface CreateItemInput {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
  url?: string;
  /** Absolute path to a local PDF; the CLI copies and hashes it. */
  pdf?: string;
}

export type ActionOutcome =
  | { status: "success"; envelope: ProtocolEnvelope }
  | {
      status: "needs_confirmation";
      /** Token to resubmit with (from `data.confirmation_token`). */
      token: string;
      envelope: ProtocolEnvelope;
    }
  | { status: "error"; code: string; message: string; envelope?: ProtocolEnvelope };

/** Temp JSON-file IO for `--patch` / `--confirmed` payloads. */
export interface TempJsonIo {
  write(payload: unknown): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface ItemActionsConfig {
  client: CliClient;
  /** Absolute vault root passed to every CLI `--vault` argument. */
  vaultRoot: string;
}

const IDENTIFIER_FLAGS: ReadonlyArray<readonly [string, keyof CreateItemInput]> = [
  ["--doi", "doi"],
  ["--pmid", "pmid"],
  ["--pmcid", "pmcid"],
  ["--arxiv", "arxiv"],
  ["--url", "url"],
] as const;

function hasSource(input: CreateItemInput): boolean {
  return IDENTIFIER_FLAGS.some(([, key]) => {
    const value = input[key];
    return typeof value === "string" && value.length > 0;
  });
}

function createArgs(vaultRoot: string, input: CreateItemInput): string[] {
  const args = ["item", "create", "--vault", vaultRoot];
  for (const [flag, key] of IDENTIFIER_FLAGS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      args.push(flag, value);
    }
  }
  if (typeof input.pdf === "string" && input.pdf.length > 0) {
    args.push("--pdf", input.pdf);
  }
  return args;
}

function attachArgs(vaultRoot: string, key: string, file: string, supplementary: boolean): string[] {
  const args = ["item", "attach-pdf", "--vault", vaultRoot, "--key", key, "--file", file];
  if (supplementary) {
    args.push("--supplementary");
  }
  return args;
}

function defaultTempJsonIo(): TempJsonIo {
  return {
    async write(payload: unknown): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "paper-notes-actions-"));
      const path = join(dir, "payload.json");
      writeFileSync(path, JSON.stringify(payload));
      return path;
    },
    async remove(path: string): Promise<void> {
      rmSync(dirname(path), { recursive: true, force: true });
    },
  };
}

/** Map a protocol envelope onto the structured action outcome. */
export function outcomeOf(envelope: ProtocolEnvelope): ActionOutcome {
  if (envelope.status === "success") {
    return { status: "success", envelope };
  }
  if (envelope.status === "needs_confirmation") {
    const token = envelope.data.confirmation_token;
    if (typeof token !== "string" || token.length === 0) {
      return {
        status: "error",
        code: "missing_token",
        message: "CLI returned needs_confirmation without a confirmation token",
        envelope,
      };
    }
    return { status: "needs_confirmation", token, envelope };
  }
  const issue = envelope.errors[0];
  return {
    status: "error",
    code: issue?.code ?? envelope.status,
    message: issue?.message ?? "CLI operation failed",
    envelope,
  };
}

export class ItemActions {
  private readonly io: TempJsonIo;

  constructor(
    private readonly config: ItemActionsConfig,
    io?: TempJsonIo,
  ) {
    this.io = io ?? defaultTempJsonIo();
  }

  private async run(args: string[]): Promise<ActionOutcome> {
    try {
      const { envelope } = await this.config.client.run(args);
      return outcomeOf(envelope);
    } catch (error) {
      if (error instanceof CliError) {
        return { status: "error", code: error.code, message: error.message };
      }
      return {
        status: "error",
        code: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected CLI error",
      };
    }
  }

  /** Run a CLI command whose last flag points at a temp JSON payload. */
  private async runWithJsonFile(
    args: string[],
    flag: string,
    payload: unknown,
  ): Promise<ActionOutcome> {
    const path = await this.io.write(payload);
    try {
      return await this.run([...args, flag, path]);
    } finally {
      await this.io.remove(path);
    }
  }

  /** `item create`; never called without at least one source. */
  async create(input: CreateItemInput): Promise<ActionOutcome> {
    if (!hasSource(input)) {
      return {
        status: "error",
        code: "no_input",
        message: "Create requires an identifier, URL, or local PDF path.",
      };
    }
    return this.run(createArgs(this.config.vaultRoot, input));
  }

  /**
   * Resubmit `item create` with the user-confirmed values. The confirmed
   * file is the deterministic confirmation-token carrier: the core
   * recomputes the token from identifiers + PDF hash + confirmed values.
   */
  async confirmCreate(
    input: CreateItemInput,
    confirmed: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    if (!hasSource(input)) {
      return {
        status: "error",
        code: "no_input",
        message: "Create requires an identifier, URL, or local PDF path.",
      };
    }
    return this.runWithJsonFile(createArgs(this.config.vaultRoot, input), "--confirmed", confirmed);
  }

  /** Reading-status shortcuts always go through `item update`. */
  async updateReadingStatus(key: string, status: ReadingStatus): Promise<ActionOutcome> {
    return this.runWithJsonFile(
      ["item", "update", "--vault", this.config.vaultRoot, "--key", key],
      "--patch",
      { reading_status: status },
    );
  }

  /** `item attach-pdf` (primary PDF unless `supplementary`). */
  async attachPdf(key: string, file: string, supplementary = false): Promise<ActionOutcome> {
    return this.run(attachArgs(this.config.vaultRoot, key, file, supplementary));
  }

  /** Resubmit an attach that needs confirmation (replacing PDF etc.). */
  async confirmAttach(
    key: string,
    file: string,
    token: string,
    supplementary = false,
  ): Promise<ActionOutcome> {
    return this.run([
      ...attachArgs(this.config.vaultRoot, key, file, supplementary),
      "--confirm-token",
      token,
    ]);
  }

  /** Always preview a rename first (`--dry-run`, spec §8.2 step 3). */
  async previewRenameKey(key: string, newKey: string): Promise<ActionOutcome> {
    return this.run([
      "item", "rename-key", "--vault", this.config.vaultRoot, "--key", key,
      "--new-key", newKey, "--dry-run",
    ]);
  }

  /** Execute a rename only with the token from its preview. */
  async confirmRenameKey(key: string, newKey: string, token: string): Promise<ActionOutcome> {
    return this.run([
      "item", "rename-key", "--vault", this.config.vaultRoot, "--key", key,
      "--new-key", newKey, "--confirm-token", token,
    ]);
  }

  /** Read-only deletion plan (`--dry-run`, spec §8.3). */
  async previewDelete(key: string): Promise<ActionOutcome> {
    return this.run([
      "item", "delete", "--vault", this.config.vaultRoot, "--key", key, "--dry-run",
    ]);
  }

  /** Execute a deletion with the exact key typed by the user + token. */
  async confirmDelete(key: string, confirmKey: string, token: string): Promise<ActionOutcome> {
    return this.run([
      "item", "delete", "--vault", this.config.vaultRoot, "--key", key,
      "--confirm-key", confirmKey, "--confirm-token", token,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers: asset opening, reading cycle, confirmation/delete rendering.
// ---------------------------------------------------------------------------

/** Assets openable from the Library (design spec §9.5). */
export type OpenAssetKind = "main" | "pdf" | "minerU" | "figure" | "cards";

export interface OpenTarget {
  kind: OpenAssetKind;
  path: string;
}

/**
 * Canonical Paper Directory for a main-note path
 * (`05 Literature/<key>/`). Empty string when the path has no parent.
 */
export function paperDirectoryOf(notePath: string): string {
  const slash = notePath.lastIndexOf("/");
  return slash <= 0 ? "" : notePath.slice(0, slash);
}

/** Vault-relative path of a paper asset derived from the main-note path. */
export function assetPathOf(kind: OpenAssetKind, notePath: string): string {
  const dir = paperDirectoryOf(notePath);
  const basename =
    dir.length === 0 ? notePath : notePath.slice(dir.length + 1);
  const key = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
  switch (kind) {
    case "main":
      return notePath;
    case "pdf":
      return `${dir}/${key}.pdf`;
    case "minerU":
      return `${dir}/minerUmd_${key}.md`;
    case "figure":
      return `${dir}/Figure解读_${key}.md`;
    case "cards":
      return `${dir}/cards`;
  }
}

/**
 * Resolve the concrete file to open. `cards` has no single canonical
 * filename: the first (sorted) `.md` under `cards/` is opened, so the
 * caller must pass the directory listing. Returns `undefined` when the
 * asset cannot be resolved (e.g. no card note yet).
 */
export function resolveOpenTarget(
  kind: OpenAssetKind,
  notePath: string,
  cardNames: string[] = [],
): OpenTarget | undefined {
  if (kind === "cards") {
    const card = cardNames.filter((name) => name.endsWith(".md")).sort()[0];
    if (card === undefined) {
      return undefined;
    }
    return openCard(notePath, card);
  }
  return { kind, path: assetPathOf(kind, notePath) };
}

/**
 * Open one specific card note (Gate D R3 interface reservation): the
 * future in-panel card view reuses this entry to open an individual
 * card, and the detail Cards block is wired through it today. The card
 * name must be a bare `.md` basename — names with a slash (path
 * traversal) or without the `.md` suffix are rejected.
 */
export function openCard(notePath: string, cardName: string): OpenTarget | undefined {
  if (!cardName.endsWith(".md") || cardName.includes("/")) {
    return undefined;
  }
  return { kind: "cards", path: `${assetPathOf("cards", notePath)}/${cardName}` };
}

const READING_CYCLE: ReadingStatus[] = ["unread", "reading", "read"];

/** Cycling reading status: unset → unread → reading → read → unread. */
export function nextReadingStatus(current?: ReadingStatus): ReadingStatus {
  if (current === undefined) {
    return "unread";
  }
  const index = READING_CYCLE.indexOf(current);
  return READING_CYCLE[(index + 1) % READING_CYCLE.length];
}

/**
 * User-confirmable values from a create `plan`. Only a plain object with
 * at least one key is confirmable; plans that carry only a message (e.g.
 * fuzzy-duplicate notices) yield `undefined`.
 */
export function confirmedValuesOf(plan: unknown): Record<string, unknown> | undefined {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return undefined;
  }
  const values = (plan as Record<string, unknown>).values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return undefined;
  }
  const entries = Object.entries(values as Record<string, unknown>);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function planLinesOf(value: unknown, prefix?: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [prefix !== undefined ? `${prefix}: ${String(value)}` : String(value)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix !== undefined ? [`${prefix}: []`] : [];
    }
    return value.flatMap((item) => planLinesOf(item, prefix));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return prefix !== undefined ? [`${prefix}: {}`] : [];
    }
    return entries.flatMap(([key, child]) => planLinesOf(child, prefix !== undefined ? `${prefix}.${key}` : key));
  }
  return [String(value)];
}

/** Deterministic, human-readable lines for a confirmation `plan`. */
export function renderPlanLines(plan: unknown): string[] {
  return planLinesOf(plan);
}

/** Deterministic lines for `needs_confirmation` candidates (fuzzy dupes). */
export function renderCandidateLines(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      return JSON.stringify(candidate);
    }
    const entry = candidate as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title : undefined;
    if (title === undefined) {
      return JSON.stringify(candidate);
    }
    const year = typeof entry.year === "number" ? `(${entry.year})` : undefined;
    const author = typeof entry.first_author === "string" ? `— ${entry.first_author}` : undefined;
    const key = typeof entry.citation_key === "string" ? `[${entry.citation_key}]` : undefined;
    return [title, year, author, key].filter((part): part is string => part !== undefined).join(" ");
  });
}

/** Read-only deletion preview (spec §8.3): count, size, backlinks. */
export interface DeletePreview {
  key: string;
  fileCount: number;
  totalBytes: number;
  backlinkCount: number;
  backlinkLines: string[];
}

/** Parse the `item delete --dry-run` needs_confirmation payload. */
export function buildDeletePreview(data: Record<string, unknown>): DeletePreview {
  const key = typeof data.citation_key === "string" ? data.citation_key : "";
  const fileCount = typeof data.file_count === "number" ? data.file_count : 0;
  const totalBytes = typeof data.total_bytes === "number" ? data.total_bytes : 0;
  const occurrences = Array.isArray(data.occurrences) ? data.occurrences : [];
  const backlinkLines = occurrences.map((occurrence) => {
    if (typeof occurrence !== "object" || occurrence === null) {
      return JSON.stringify(occurrence);
    }
    const entry = occurrence as Record<string, unknown>;
    const path = typeof entry.path === "string" ? entry.path : "";
    if (path.length === 0) {
      return JSON.stringify(occurrence);
    }
    const kind = typeof entry.kind === "string" ? entry.kind : "reference";
    const line = typeof entry.line === "number" ? `:${entry.line}` : "";
    return `${kind}: ${path}${line}`;
  });
  return { key, fileCount, totalBytes, backlinkCount: backlinkLines.length, backlinkLines };
}

/** Deterministic byte formatting: B / KB / MB. */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deletion gate (spec §8.3): the user must type the exact canonical
 * citation key — no trimming, no case folding, fail closed.
 */
export function confirmKeyMatches(entered: string, key: string): boolean {
  return entered === key;
}

// ---------------------------------------------------------------------------
// Create-input classification (spec §7.1): identifier / URL / local PDF.
// ---------------------------------------------------------------------------

export type ParsedCreateInput =
  | { kind: "identifier"; field: "doi" | "pmid" | "pmcid" | "arxiv"; value: string }
  | { kind: "url"; value: string }
  | { kind: "pdf"; path: string }
  | { kind: "empty" }
  | { kind: "unrecognized" };

const CREATE_DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/;
const CREATE_PMID_RE = /^\d{1,8}$/;
const CREATE_PMCID_RE = /^PMC\d+$/i;
const CREATE_ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

/**
 * Classify a single create-modal input. Priority: DOI → PMID → PMCID →
 * arXiv → https URL → local file path → unrecognized. Prefixed forms
 * (`DOI:`, `PMID:`, `PMCID:`, `arXiv:`) are accepted and stripped.
 */
export function parseCreateInput(text: string): ParsedCreateInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  const prefixed = /^(DOI|PMID|PMCID|arXiv)\s*:\s*(.+)$/i.exec(trimmed);
  const candidate = prefixed !== null ? prefixed[2].trim() : trimmed;
  if (candidate.length === 0) {
    return { kind: "unrecognized" };
  }
  if (CREATE_DOI_RE.test(candidate)) {
    return { kind: "identifier", field: "doi", value: candidate };
  }
  if (prefixed !== null && prefixed[1].toLowerCase() === "pmid" && CREATE_PMID_RE.test(candidate)) {
    return { kind: "identifier", field: "pmid", value: candidate };
  }
  if (CREATE_PMID_RE.test(candidate)) {
    return { kind: "identifier", field: "pmid", value: candidate };
  }
  if (CREATE_PMCID_RE.test(candidate)) {
    return { kind: "identifier", field: "pmcid", value: candidate };
  }
  if (CREATE_ARXIV_RE.test(candidate)) {
    return { kind: "identifier", field: "arxiv", value: candidate };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "url", value: trimmed };
  }
  if (
    trimmed.toLowerCase().endsWith(".pdf") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return { kind: "pdf", path: trimmed };
  }
  return { kind: "unrecognized" };
}

/** Map a parsed input onto the CLI create input. */
export function buildCreateInput(parsed: ParsedCreateInput): CreateItemInput | undefined {
  switch (parsed.kind) {
    case "identifier":
      return { [parsed.field]: parsed.value };
    case "url":
      return { url: parsed.value };
    case "pdf":
      return { pdf: parsed.path };
    default:
      return undefined;
  }
}
