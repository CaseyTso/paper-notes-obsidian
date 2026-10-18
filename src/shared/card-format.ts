/**
 * Literature Card format contract — the single source of truth shared by the
 * desktop CLI writer and the mobile direct-vault writer (ADR 0006 / 0007).
 *
 * Everything in this file is **pure computation**: no Obsidian API, no Node
 * builtin, no filesystem, no DOM beyond `TextEncoder` / `TextDecoder` /
 * Web Crypto (all available in Obsidian desktop, Obsidian mobile and Node
 * 20+). Both writers must produce byte-identical output, so the slug rules,
 * the Card Anchor naming, the card markdown assembly and the anchor insertion
 * plan all live here and nowhere else.
 *
 * The behaviour mirrors the Python CLI (`paper_notes/cards.py`):
 * - `slugify_card_filename`          ↔ `slugifyCardFilename`
 * - `card-{sha256(card_stem)[:16]}`  ↔ `cardAnchorName`
 * - `_format_card_content`           ↔ `formatCardContent`
 * - `_resolve_and_insert_anchor` +
 *   `_parse_lines` + `_parse_blocks` ↔ `buildAnchorInsertion`
 *
 * The editor-side helpers (`parseFigureSource`, `computeSelectionByteOffsets`,
 * `findPositionAfterHeading`) used to live in `src/services/card-creation.ts`
 * and were moved here so the mobile plugin can reuse them without pulling in
 * the Node-dependent desktop service. `card-creation.ts` re-exports them, so
 * every existing importer is unaffected.
 */

/** Citation keys are validated with the same regex as the CLI. */
export const CITATION_KEY_RE = /^[A-Za-z][A-Za-z0-9+_.-]*$/;

/** Default vault-relative root of the literature tree. */
export const LITERATURE_ROOT = "05 Literature";

/** Anchor name shape mandated by the CLI: `card-` + 16 lowercase hex chars. */
export const CARD_ANCHOR_RE = /^card-[0-9a-f]{16}$/;

/** The trailing heading every card carries; the cursor lands right after it. */
export const EXTENSION_HEADING = "## 扩展";

/** Prefix of the backlink line pointing from the card at the source note. */
export const CARD_BACKLINK_PREFIX = "> 参见 ";

// ---------------------------------------------------------------------------
// Pure helpers: slug + anchor name
// ---------------------------------------------------------------------------

/**
 * Characters that are never safe inside a filename. CJK is deliberately
 * preserved (the CLI keeps it); control characters fold into `_`.
 */
const UNSAFE_FILENAME_CHARS_RE = /[/\\:*?"<>|\x00-\x1f]+/g;
/** Runs of leading / trailing dots, stripped after the unsafe-char pass. */
const LEADING_TRAILING_DOTS_RE = /^\.+|\.+$/g;

/**
 * Python's `str.strip()` / `re` `\s` character set, exactly.
 *
 * JS `String.prototype.trim()` and JS `\s` disagree with Python in both
 * directions, and the two writers must agree byte-for-byte:
 * - Python strips U+0085 and U+001C–U+001F, JS does not;
 * - JS strips U+FEFF (BOM), Python does not — and preserving a leading BOM
 *   is what keeps the CLI's "revert restores the exact byte stream" contract.
 *
 * Enumerated from CPython 3.13 (`unicodedata` 15.1) over U+0000–U+10FFFF:
 * `[[9,13],[28,32],[133],[160],[5760],[8192,8202],[8232,8233],[8239],[8287],[12288]]`.
 */
const PY_STRIP_RE = /^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/**
 * Python's `re` `\s` for `str` patterns — the same set as `str.strip()`,
 * applied globally by `re.sub(r"[\s]+", "_", ...)`.
 */
const PY_WHITESPACE_RE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/**
 * Python's `bytes.strip()` set — ASCII whitespace only:
 * `b' \t\n\r\x0b\x0c'` (values 9, 10, 11, 12, 13, 32).
 *
 * Used wherever the CLI strips a *byte* slice rather than decoded text, so a
 * non-ASCII whitespace byte (e.g. the U+00A0 lead byte 0xC2) is NOT stripped
 * there even though it is by `str.strip()`.
 */
const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

/**
 * Python's `re` `\d` for `str` patterns == `Nd` under Unicode 15.1.
 *
 * JS `\p{Nd}` follows the engine's newer Unicode tables and adds eight blocks
 * that Python does not yet know, so `\p{Nd}` alone is not equivalent. The
 * extra blocks (Unicode 16.0) are subtracted explicitly.
 */
const UNICODE_16_ND_RANGES: readonly [number, number][] = [
  [0x10d40, 0x10d49],
  [0x116d0, 0x116e3],
  [0x11bf0, 0x11bf9],
  [0x11de0, 0x11de9],
  [0x16130, 0x16139],
  [0x16d70, 0x16d79],
  [0x1ccf0, 0x1ccf9],
  [0x1e5f1, 0x1e5fa],
];

/** True when `codePoint` is a decimal digit under Python's `\d` (Unicode 15.1). */
function isPythonDigit(codePoint: number): boolean {
  if (codePoint < 0 || codePoint > 0x10ffff) return false;
  if (!/^\p{Nd}$/u.test(String.fromCodePoint(codePoint))) return false;
  for (const [lo, hi] of UNICODE_16_ND_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return false;
  }
  return true;
}

/**
 * Python's `str.strip()` on `text`: both ends, Unicode whitespace, BOM kept.
 */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

/**
 * Python's `str.lstrip()` on `text`.
 */
function pyLstrip(text: string): string {
  return text.replace(/^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "");
}

/**
 * Python's `bytes.strip()` on `bytes`: ASCII whitespace only (9–13, 32).
 */
function bytesStripIsEmpty(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (!ASCII_WHITESPACE.has(bytes[i])) return false;
  }
  return true;
}

/**
 * True when `text` is a block-level Markdown list marker under Python's
 * `\d`, mirroring `^[ \t]*([-*+]|\d+[\.\)])([ \t]+|$)`.
 *
 * Note this differs from the container-walk regex below: it accepts a tab
 * indent, an unbounded digit run, and **requires** a trailing space/tab (so a
 * bare `-` on its own line is NOT a list item at block level).
 */
function isListMarkerLine(text: string): boolean {
  // ASCII fast path — the overwhelmingly common case.
  if (/^[ \t]*([-*+]|[0-9]+)[\.\)][ \t]+/.test(text)) return true;
  return listMarkerAt(text, 0, "block") !== null;
}

/**
 * Match the CLI's `_LIST_MARKER_RE` — `^[ ]{0,3}([-*+]|\d{1,9}[\.\)])([ \t]+|$)`
 * — used by the container Setext-hazard walk, with Python's Unicode `\d`.
 *
 * Returns the number of **code points** consumed (Python's `len(m.group(0))`
 * counts code points, not UTF-16 units) and the continuation indent, or
 * `null` when the text does not open a list item there.
 */
function listMarkerAt(
  text: string,
  col: number,
  mode: "block" | "container",
): { consumed: number; width: number } | null {
  let i = col;
  if (mode === "container") {
    // `^[ ]{0,3}` — spaces only, at most three.
    let spaces = 0;
    while (i < text.length && spaces < 3 && text[i] === " ") {
      i += 1;
      spaces += 1;
    }
  } else {
    // `^[ \t]*` — any mix of spaces and tabs.
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  }

  const markerStart = i;
  let markerEnd: number;
  const ch = text[i];
  if (ch === "-" || ch === "*" || ch === "+") {
    markerEnd = i + 1;
  } else {
    const maxDigits = mode === "container" ? 9 : Number.POSITIVE_INFINITY;
    let digits = 0;
    let j = i;
    while (j < text.length && digits < maxDigits) {
      const cp = text.codePointAt(j)!;
      if (!isPythonDigit(cp)) break;
      j += cp > 0xffff ? 2 : 1;
      digits += 1;
    }
    if (digits === 0) return null;
    if (text[j] !== "." && text[j] !== ")") return null;
    markerEnd = j + 1;
  }

  let after = markerEnd;
  let sepLen = 0;
  while (after < text.length && (text[after] === " " || text[after] === "\t")) {
    after += 1;
    sepLen += 1;
  }
  // The container regex accepts end-of-string; the block-level one requires
  // at least one space/tab after the marker.
  if (sepLen === 0 && (mode === "block" || after !== text.length)) return null;

  const consumed = Array.from(text.slice(col, after)).length;
  // `marker_width = len(group(0))` in code points, +1 for a bare marker.
  let width = Array.from(text.slice(markerStart, after)).length;
  if (sepLen === 0) width += 1;
  return { consumed, width };
}

/**
 * Turn a card title into the filename stem used by the CLI.
 *
 * Mirrors `slugify_card_filename` step for step:
 * 1. unsafe characters → `_`
 * 2. leading/trailing dots removed
 * 3. whitespace runs → `_`
 * 4. `_` runs collapsed, then trimmed of `_`
 * 5. an empty result falls back to `card`
 */
export function slugifyCardFilename(title: string): string {
  // Step 1 — unsafe characters → `_`. The trim that follows is Python's
  // `str.strip()`: Unicode whitespace at both ends, but a BOM is kept.
  let cleaned = pyStrip(title.replace(UNSAFE_FILENAME_CHARS_RE, "_"));
  cleaned = cleaned.replace(LEADING_TRAILING_DOTS_RE, "");
  // Step 3 — whitespace runs → `_`, using Python's `\s` (Unicode, BOM kept).
  cleaned = cleaned.replace(PY_WHITESPACE_RE, "_");
  // Step 4 — `_` runs collapsed, then trimmed of `_` (ASCII underscore only,
  // so this stays `str.strip("_")`, not the Unicode strip).
  cleaned = cleaned.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "card";
}

/**
 * The card filename including extension: `card_<slug>.md`.
 *
 * `slugifyCardFilename` never returns an empty string, so the stem is always
 * at least `card` long and the path is always safe.
 */
export function cardFilenameOf(title: string): string {
  return `card_${slugifyCardFilename(title)}.md`;
}

/** A digest implementation, injected so tests need not depend on Web Crypto. */
export type DigestFn = (bytes: Uint8Array) => Promise<Uint8Array>;

/**
 * Digest `bytes` with SHA-256 through Web Crypto.
 *
 * Node 20+, Obsidian desktop and Obsidian mobile all expose
 * `globalThis.crypto.subtle`, so no platform branching is needed.
 */
async function sha256Hex(
  bytes: Uint8Array,
  digest: DigestFn = defaultDigest,
): Promise<string> {
  const out = await digest(bytes);
  let hex = "";
  for (let i = 0; i < out.length; i++) {
    hex += out[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function defaultDigest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto (crypto.subtle) is not available in this runtime.");
  }
  const buffer = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return new Uint8Array(buffer);
}

/**
 * Card Anchor name for a card stem: `card-` plus the first 16 hex characters
 * of the UTF-8 SHA-256 digest of the stem.
 *
 * Deterministic per stem, so both writers agree and re-running the same title
 * lands on the same anchor.
 */
export async function cardAnchorName(
  cardStem: string,
  digest: DigestFn = defaultDigest,
): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(cardStem), digest);
  return `card-${hex.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Pure helpers: card content assembly
// ---------------------------------------------------------------------------

export interface FormatCardContentParams {
  /** Paper UUID, taken verbatim from the canonical note frontmatter. */
  paperId: string;
  /** Citation key of the paper the card belongs to. */
  citationKey: string;
  /** Selected text, embedded verbatim (CRLF preserved). */
  selection: string;
  /**
   * Anchor backlink to emit, or `null` when the anchor could not be inserted —
   * omitting it keeps the card free of dead links.
   */
  anchorLink: string | null;
}

/**
 * Assemble the full card markdown, byte-identical to the CLI's output.
 *
 * The frontmatter is the fixed three-field block; the body is the verbatim
 * selection, then (only when linked) the `> 参见` line, then `## 扩展`. The
 * newline style follows the selection: CRLF when it contains any CRLF, LF
 * otherwise.
 */
export function formatCardContent(params: FormatCardContentParams): string {
  const { paperId, citationKey, selection, anchorLink } = params;
  const frontmatter =
    "---\n" +
    `paper_id: ${paperId}\n` +
    `citation_key: ${citationKey}\n` +
    `paper: "[[${citationKey}]]"\n` +
    "---\n\n";
  const nl = selection.includes("\r\n") ? "\r\n" : "\n";
  const backlink = anchorLink ? `${CARD_BACKLINK_PREFIX}${anchorLink}` : null;
  let suffix: string;
  if (backlink) {
    if (selection.endsWith(nl + nl)) {
      suffix = `${backlink}${nl}${nl}${EXTENSION_HEADING}${nl}`;
    } else if (selection.endsWith(nl)) {
      suffix = `${nl}${backlink}${nl}${nl}${EXTENSION_HEADING}${nl}`;
    } else {
      suffix = `${nl}${nl}${backlink}${nl}${nl}${EXTENSION_HEADING}${nl}`;
    }
  } else if (selection.endsWith(nl + nl)) {
    suffix = `${EXTENSION_HEADING}${nl}`;
  } else if (selection.endsWith(nl)) {
    suffix = `${nl}${EXTENSION_HEADING}${nl}`;
  } else {
    suffix = `${nl}${nl}${EXTENSION_HEADING}${nl}`;
  }
  return frontmatter + selection + suffix;
}

/**
 * The `[[Figure解读_<key>#^<anchor>|Figure解读_<key>]]` backlink the card
 * carries. Never emitted for a `failed` anchor, so no dead link survives.
 */
export function cardAnchorLink(citationKey: string, anchorName: string): string {
  const stem = `Figure解读_${citationKey}`;
  return `[[${stem}#^${anchorName}|${stem}]]`;
}

/**
 * Vault-relative POSIX path of the card note for a title:
 * `05 Literature/<key>/cards/card_<slug>.md` — forward slashes, no root.
 */
export function cardRelativePath(citationKey: string, title: string): string {
  return `${LITERATURE_ROOT}/${citationKey}/cards/${cardFilenameOf(title)}`;
}

// ---------------------------------------------------------------------------
// Pure helpers: Figure source identification
// ---------------------------------------------------------------------------

export interface FigureSourceInfo {
  key: string;
  sourceNote: string;
}

/**
 * Strict check for a Figure Interpretation Note.
 *
 * The path must be exactly `<literatureRoot>/<key>/Figure解读_<key>.md`, the
 * key must satisfy the citation-key regex, and traversal segments are
 * rejected. Anything else yields `null`.
 */
export function parseFigureSource(
  filePath: string,
  literatureRoot: string = LITERATURE_ROOT,
): FigureSourceInfo | null {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  const cleanPath = filePath.replace(/^\/+|\/+$/g, "");
  const cleanRoot = literatureRoot.replace(/^\/+|\/+$/g, "");
  const prefix = cleanRoot.length > 0 ? `${cleanRoot}/` : "";
  if (prefix.length > 0 && !cleanPath.startsWith(prefix)) {
    return null;
  }
  const rel = cleanPath.slice(prefix.length);
  const parts = rel.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [dir, file] = parts;
  if (!dir || !file) {
    return null;
  }
  if (!CITATION_KEY_RE.test(dir) || dir.includes("..")) {
    return null;
  }
  const expectedName = `Figure解读_${dir}.md`;
  if (file !== expectedName) {
    return null;
  }
  return {
    key: dir,
    sourceNote: `Figure解读_${dir}`,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: editor selection → UTF-8 byte range
// ---------------------------------------------------------------------------

export interface SelectionRangeResult {
  startByte: number;
  endByte: number;
  selectionText: string;
  selectionBytes: Uint8Array;
}

function isSurrogateHalf(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff;
}

/**
 * Map editor selection coordinates onto the half-open UTF-8 byte range
 * `[startByte, endByte)` of the saved file text.
 *
 * `expectedSelectedText`, when given, is compared after CRLF normalisation so
 * a stale buffer is detected instead of silently mis-mapping the range.
 */
export function computeSelectionByteOffsets(
  savedText: string,
  from: { line: number; ch: number },
  to: { line: number; ch: number },
  expectedSelectedText?: string,
): SelectionRangeResult {
  let startPos = from;
  let endPos = to;
  if (from.line > to.line || (from.line === to.line && from.ch > to.ch)) {
    startPos = to;
    endPos = from;
  }

  const lineStarts: number[] = [0];
  for (let i = 0; i < savedText.length; i++) {
    if (savedText[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }

  if (
    startPos.line < 0 ||
    startPos.line >= lineStarts.length ||
    endPos.line < 0 ||
    endPos.line >= lineStarts.length
  ) {
    throw new Error("选区行号超出文件行数范围。");
  }

  const charStart = lineStarts[startPos.line] + startPos.ch;
  const charEnd = lineStarts[endPos.line] + endPos.ch;

  if (charStart < 0 || charEnd > savedText.length || charStart >= charEnd) {
    throw new Error("选区范围无效或为空。");
  }

  if (isSurrogateHalf(savedText, charStart) || isSurrogateHalf(savedText, charEnd)) {
    throw new Error("选区边界不能位于 Unicode 代理对内部。");
  }

  const rawSlice = savedText.slice(charStart, charEnd);
  if (expectedSelectedText !== undefined) {
    const normExpected = expectedSelectedText.replace(/\r\n/g, "\n");
    const normSlice = rawSlice.replace(/\r\n/g, "\n");
    if (normExpected !== normSlice) {
      throw new Error("保存后的文件内容与编辑器选区不一致。");
    }
  }

  const encoder = new TextEncoder();
  const startByte = encoder.encode(savedText.slice(0, charStart)).length;
  const endByte = encoder.encode(savedText.slice(0, charEnd)).length;

  const fullBytes = encoder.encode(savedText);
  const selectionBytes = fullBytes.subarray(startByte, endByte);
  const selectionText = new TextDecoder("utf-8").decode(selectionBytes);

  return {
    startByte,
    endByte,
    selectionText,
    selectionBytes,
  };
}

/**
 * Locate the line/ch immediately following `heading` in card content, so the
 * editor can drop the cursor there after opening a new card.
 */
export function findPositionAfterHeading(
  content: string,
  heading: string = EXTENSION_HEADING,
): { line: number; ch: number } | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pyStrip(lines[i]) === heading) {
      if (i + 1 < lines.length) {
        return { line: i + 1, ch: 0 };
      }
      return { line: i, ch: lines[i].length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure helpers: Markdown block model for anchor insertion
// ---------------------------------------------------------------------------

/**
 * One physical line of the source note. Byte offsets are relative to the whole
 * file and mirror the CLI's `SourceLine`:
 * - `startByte` / `endByte` / `rawBytes` exclude the line terminator
 * - `fullEndByte` includes it
 */
export interface SourceLine {
  index: number;
  startByte: number;
  endByte: number;
  fullEndByte: number;
  newline: Uint8Array;
  /** Line text with the terminator stripped. */
  text: string;
  /** Line bytes with the terminator stripped. */
  rawBytes: Uint8Array;
}

export type BlockType =
  | "paragraph"
  | "list"
  | "blockquote"
  | "table"
  | "fenced"
  | "unclosed_fenced"
  | "heading"
  | "setext_heading";

export interface MarkdownBlock {
  blockType: BlockType;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  fullEndByte: number;
  /** Anchor already attached to this block, if any. */
  existingAnchor: string | null;
  /**
   * Conservative whole-block flag: the container's logical content holds a
   * nested Setext heading, so any exact selection inside it fails closed.
   */
  containerSetextHazard: boolean;
}

/** Outcome of resolving the anchor for a selection. */
export type AnchorInsertionStatus = "inserted" | "existing" | "failed";

export interface AnchorInsertionPlan {
  status: AnchorInsertionStatus;
  /** Human-readable reason; present whenever the status is not a plain insert. */
  reason?: string;
  /** Newline style detected in the source note. */
  newline: "\n" | "\r\n";
  /** Byte offset the insertion happens at; `null` when nothing is written. */
  insertByte: number | null;
  /** Exact bytes to splice in at `insertByte`; `null` when nothing is written. */
  insertBytes: Uint8Array | null;
}

const LF = 0x0a;
const CR = 0x0d;

const SETEXT_UNDERLINE_RE = /^[ ]{0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_HEADING_RE = /^[ ]{0,3}#{1,6}([ \t]+|$)/;
const STANDALONE_ANCHOR_RE = /^\^([a-zA-Z0-9-]+)$/;
/**
 * Trailing block anchor on a paragraph/heading line.
 *
 * Mirrors the CLI's `re.search(r"(?:[ \t])\^([a-zA-Z0-9-]+)[ \t]*$",
 * last_line_text)`: the anchor must be preceded by a space or tab and may be
 * followed by trailing spaces/tabs. Note this is applied to the RAW line text
 * — not a stripped one — so the preceding-space requirement is what
 * disambiguates a real anchor from text that merely ends in `^name`.
 */
const TRAILING_ANCHOR_RE = /[ \t]\^([a-zA-Z0-9-]+)[ \t]*$/;
/**
 * The same trailing anchor, but searched on ALREADY-STRIPPED text — mirrors
 * the CLI's `_find_all_anchor_tokens` regex
 * `re.search(r"(?:^|[ \t])\^([a-zA-Z0-9-]+)$", stripped)`, where `^` is an
 * alternative because stripping removed the separator.
 */
const TRAILING_ANCHOR_STRIPPED_RE = /(?:^|[ \t])\^([a-zA-Z0-9-]+)$/;

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Decode UTF-8 bytes the way the CLI does: `raw.decode("utf-8",
 * errors="replace")`, which keeps a leading BOM as U+FEFF.
 *
 * The default `TextDecoder("utf-8")` strips a BOM, which would shift every
 * byte offset after it and break the CLI's "revert restores the exact byte
 * stream" invariant. `ignoreBOM: true` preserves it.
 */
const TEXT_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

function utf8Decode(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Split the raw note bytes into physical lines, recording byte offsets.
 *
 * Mirrors the CLI's `_parse_lines`: a lone `\n` terminates a line, a `\r\n`
 * pair terminates a line with the `\r` excluded from its text, and a final
 * line without a terminator is still a line.
 */
export function parseSourceLines(sourceBytes: Uint8Array): SourceLine[] {
  const lines: SourceLine[] = [];
  const n = sourceBytes.length;
  let pos = 0;
  let index = 0;
  while (pos < n) {
    const start = pos;
    const nlPos = sourceBytes.indexOf(LF, pos);
    let end: number;
    let fullEnd: number;
    let newline: Uint8Array;
    if (nlPos === -1) {
      end = n;
      fullEnd = n;
      newline = new Uint8Array(0);
      pos = n;
    } else {
      fullEnd = nlPos + 1;
      if (nlPos > start && sourceBytes[nlPos - 1] === CR) {
        end = nlPos - 1;
        newline = new Uint8Array([CR, LF]);
      } else {
        end = nlPos;
        newline = new Uint8Array([LF]);
      }
      pos = fullEnd;
    }
    const rawBytes = sourceBytes.subarray(start, end);
    lines.push({
      index,
      startByte: start,
      endByte: end,
      fullEndByte: fullEnd,
      newline,
      text: utf8Decode(rawBytes),
      rawBytes,
    });
    index += 1;
  }
  return lines;
}

function isSetextUnderline(lineText: string): boolean {
  return SETEXT_UNDERLINE_RE.test(lineText);
}

function parseFenceOpen(text: string): { char: string; length: number } | null {
  const m = FENCE_OPEN_RE.exec(text);
  if (!m) return null;
  const fenceStr = m[1];
  const info = m[2];
  const fenceChar = fenceStr[0];
  // Backtick fences may not carry backticks in the info string (CommonMark).
  if (fenceChar === "`" && info.includes("`")) return null;
  return { char: fenceChar, length: fenceStr.length };
}

function isFenceClose(text: string, fenceChar: string, fenceLen: number): boolean {
  const m = FENCE_CLOSE_RE.exec(text);
  if (!m) return false;
  const closeStr = m[1];
  return closeStr[0] === fenceChar && closeStr.length >= fenceLen;
}

function isTableDelimiterRow(lineText: string): boolean {
  const stripped = pyStrip(lineText);
  if (!stripped || !stripped.includes("|")) return false;
  const hasOuterPipe = stripped.startsWith("|") || stripped.endsWith("|");
  let inner = stripped;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|");
  if (!cells || (cells.length === 1 && !hasOuterPipe)) return false;
  for (const cell of cells) {
    const c = pyStrip(cell);
    if (!c || !/^:?-+:?$/.test(c)) return false;
  }
  return true;
}

function hasUnescapedPipeOutsideCode(text: string): boolean {
  let inCode = false;
  let codeFenceLen = 0;
  let idx = 0;
  const n = text.length;
  while (idx < n) {
    const ch = text[idx];
    if (ch === "\\") {
      idx += 2;
      continue;
    }
    if (ch === "`") {
      const start = idx;
      while (idx < n && text[idx] === "`") idx += 1;
      const cnt = idx - start;
      if (!inCode) {
        inCode = true;
        codeFenceLen = cnt;
      } else if (cnt === codeFenceLen) {
        inCode = false;
        codeFenceLen = 0;
      }
      continue;
    }
    if (ch === "|" && !inCode) return true;
    idx += 1;
  }
  return false;
}

function isTableStart(lines: SourceLine[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  if (!hasUnescapedPipeOutsideCode(lines[i].text)) return false;
  return isTableDelimiterRow(lines[i + 1].text);
}

function isIndentedContinuation(text: string): boolean {
  return text.startsWith("  ") || text.startsWith("\t");
}

/** Python's `str.expandtabs(4)`: advance to the next multiple of the tab size. */
function expandTabs(text: string, tabSize: number): string {
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = tabSize - (col % tabSize);
      out += " ".repeat(spaces);
      col += spaces;
      continue;
    }
    out += ch;
    col += 1;
  }
  return out;
}

interface ContainerFrame {
  kind: "blockquote" | "list";
  indent: number;
}

/**
 * Walk a blockquote/list container the way CommonMark does and report whether
 * its logical content contains a Setext heading.
 *
 * Over-approximating is the accepted trade-off (Phase 4b of the CLI): a false
 * positive only turns a risky insertion into a conservative failure, never
 * into a bad write.
 */
function containerSetextHazard(
  lines: SourceLine[],
  startLine: number,
  endLine: number,
): boolean {
  const stack: ContainerFrame[] = [];
  let activeFence: { char: string; length: number; depth: number } | null = null;
  let lastParagraphStack: string | null = null;

  for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
    const expanded = expandTabs(lines[lineIdx].text, 4);

    // A completely blank line ends any open paragraph; blockquotes cannot
    // continue across one without `>`.
    if (!pyStrip(expanded)) {
      lastParagraphStack = null;
      while (stack.length && stack[stack.length - 1].kind === "blockquote") stack.pop();
      if (activeFence && activeFence.depth > stack.length) activeFence = null;
      continue;
    }

    let col = 0;
    let matchedDepth = 0;
    while (matchedDepth < stack.length) {
      const frame = stack[matchedDepth];
      let sp = 0;
      while (col + sp < expanded.length && expanded[col + sp] === " ") sp += 1;
      if (frame.kind === "blockquote") {
        if (sp <= 3 && col + sp < expanded.length && expanded[col + sp] === ">") {
          col += sp + 1;
          if (col < expanded.length && expanded[col] === " ") col += 1;
          matchedDepth += 1;
          continue;
        }
        break;
      }
      if (sp >= frame.indent) {
        col += frame.indent;
        matchedDepth += 1;
        continue;
      }
      break;
    }

    if (matchedDepth < stack.length) {
      stack.length = matchedDepth;
      if (activeFence && activeFence.depth > matchedDepth) activeFence = null;
      lastParagraphStack = null;
    }

    if (activeFence && activeFence.depth === stack.length) {
      const innerText = expanded.slice(col);
      if (isFenceClose(innerText, activeFence.char, activeFence.length)) {
        activeFence = null;
      }
      lastParagraphStack = null;
      continue;
    }

    let openedNewContainer = false;
    for (;;) {
      let sp = 0;
      while (col + sp < expanded.length && expanded[col + sp] === " ") sp += 1;
      if (sp <= 3 && col + sp < expanded.length && expanded[col + sp] === ">") {
        col += sp + 1;
        if (col < expanded.length && expanded[col] === " ") col += 1;
        stack.push({ kind: "blockquote", indent: 0 });
        openedNewContainer = true;
        continue;
      }
      // Python's `_LIST_MARKER_RE` on the de-containerized inner text. Its `\d`
      // is Unicode-aware, so this must be too (a fullwidth `１.` opens a list).
      const marker = listMarkerAt(expanded, col, "container");
      if (marker) {
        col += marker.consumed;
        stack.push({ kind: "list", indent: marker.width });
        openedNewContainer = true;
        continue;
      }
      break;
    }

    const innerText = expanded.slice(col);
    const currentStack = stack.map((f) => `${f.kind}:${f.indent}`).join("|");

    if (!pyStrip(innerText)) {
      lastParagraphStack = null;
      continue;
    }

    const fenceInfo = parseFenceOpen(innerText);
    if (fenceInfo) {
      activeFence = {
        char: fenceInfo.char,
        length: fenceInfo.length,
        depth: stack.length,
      };
      lastParagraphStack = null;
      continue;
    }

    if (ATX_HEADING_RE.test(innerText)) {
      lastParagraphStack = null;
      continue;
    }

    // A `=+`/`-+` line only counts as a Setext underline when it continues the
    // exact same container stack as the immediately preceding paragraph line
    // without opening a new container — so thematic breaks and new list items
    // do not trigger the hazard.
    if (!openedNewContainer && isSetextUnderline(innerText)) {
      if (lastParagraphStack === currentStack) return true;
      lastParagraphStack = null;
      continue;
    }

    lastParagraphStack = currentStack;
  }

  return false;
}

/**
 * Detect the end of a Setext heading opening at line `i`, or `null` when the
 * line does not open one. Mirrors the CLI's `_check_setext_heading`.
 */
function checkSetextHeading(lines: SourceLine[], i: number): number | null {
  const firstLine = lines[i].text;
  if (!pyStrip(firstLine)) return null;
  if (firstLine.startsWith("    ") || firstLine.startsWith("\t")) return null;
  if (isSetextUnderline(firstLine)) return null;

  let j = i + 1;
  while (j < lines.length) {
    const lineText = lines[j].text;
    if (isSetextUnderline(lineText)) return j;
    const stripped = pyStrip(lineText);
    if (!stripped) return null;
    if (lineText.startsWith("    ") || lineText.startsWith("\t")) return null;
    if (
      /^[ \t]*(`{3,}|~{3,})/.test(lineText) ||
      pyLstrip(lineText).startsWith(">") ||
      isTableStart(lines, j) ||
      isListMarkerLine(lineText) ||
      /^[ \t]*#{1,6}[ \t]+/.test(lineText) ||
      STANDALONE_ANCHOR_RE.test(stripped)
    ) {
      return null;
    }
    j += 1;
  }
  return null;
}

/**
 * Group physical lines into structural Markdown blocks.
 * Mirrors the CLI's `_parse_blocks`, including its conservative ordering.
 */
export function parseMarkdownBlocks(lines: SourceLine[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const numLines = lines.length;
  let i = 0;

  while (i < numLines) {
    const line = lines[i];
    const text = line.text;
    const stripped = pyStrip(text);

    if (!stripped) {
      i += 1;
      continue;
    }

    // Fenced code block (``` or ~~~)
    const fenceInfo = parseFenceOpen(text);
    if (fenceInfo) {
      const startLine = i;
      i += 1;
      let closed = false;
      while (i < numLines) {
        if (isFenceClose(lines[i].text, fenceInfo.char, fenceInfo.length)) {
          closed = true;
          break;
        }
        i += 1;
      }
      const endLine = Math.min(i, numLines - 1);
      blocks.push({
        blockType: closed ? "fenced" : "unclosed_fenced",
        startLine,
        endLine,
        startByte: lines[startLine].startByte,
        endByte: lines[endLine].endByte,
        fullEndByte: lines[endLine].fullEndByte,
        existingAnchor: null,
        containerSetextHazard: false,
      });
      i += 1;
      continue;
    }

    // Blockquote / callout (`> ...`, consecutive lines)
    if (pyLstrip(text).startsWith(">")) {
      const startLine = i;
      while (i + 1 < numLines) {
        const nxt = lines[i + 1];
        if (pyLstrip(nxt.text).startsWith(">")) i += 1;
        else break;
      }
      const endLine = i;
      blocks.push({
        blockType: "blockquote",
        startLine,
        endLine,
        startByte: lines[startLine].startByte,
        endByte: lines[endLine].endByte,
        fullEndByte: lines[endLine].fullEndByte,
        existingAnchor: null,
        containerSetextHazard: containerSetextHazard(lines, startLine, endLine),
      });
      i += 1;
      continue;
    }

    // Table, only when a header row is confirmed by a delimiter row
    if (isTableStart(lines, i)) {
      const startLine = i;
      i += 2;
      while (i < numLines) {
        const nxt = lines[i];
        if (!pyStrip(nxt.text)) break;
        if (!hasUnescapedPipeOutsideCode(nxt.text)) break;
        i += 1;
      }
      const endLine = i - 1;
      blocks.push({
        blockType: "table",
        startLine,
        endLine,
        startByte: lines[startLine].startByte,
        endByte: lines[endLine].endByte,
        fullEndByte: lines[endLine].fullEndByte,
        existingAnchor: null,
        containerSetextHazard: false,
      });
      continue;
    }

    // List
    if (isListMarkerLine(text)) {
      const startLine = i;
      while (i + 1 < numLines) {
        const nxt = lines[i + 1];
        if (!pyStrip(nxt.text)) {
          // A blank line only continues the list when the next non-blank line
          // is another item or a non-blank indented continuation. Note that
          // `\t` alone is blank: `startswith` must be combined with a non-empty
          // trim, exactly as the CLI combines them.
          if (i + 2 < numLines) {
            const afterBlank = lines[i + 2];
            if (
              isListMarkerLine(afterBlank.text) ||
              (isIndentedContinuation(afterBlank.text) && pyStrip(afterBlank.text) !== "")
            ) {
              i += 2;
              continue;
            }
          }
          break;
        }
        if (isListMarkerLine(nxt.text) || isIndentedContinuation(nxt.text)) {
          i += 1;
          continue;
        }
        break;
      }
      const endLine = i;
      blocks.push({
        blockType: "list",
        startLine,
        endLine,
        startByte: lines[startLine].startByte,
        endByte: lines[endLine].endByte,
        fullEndByte: lines[endLine].fullEndByte,
        existingAnchor: null,
        containerSetextHazard: containerSetextHazard(lines, startLine, endLine),
      });
      i += 1;
      continue;
    }

    // ATX heading
    if (/^[ \t]*#{1,6}[ \t]+/.test(text)) {
      blocks.push({
        blockType: "heading",
        startLine: i,
        endLine: i,
        startByte: line.startByte,
        endByte: line.endByte,
        fullEndByte: line.fullEndByte,
        existingAnchor: null,
        containerSetextHazard: false,
      });
      i += 1;
      continue;
    }

    // Standalone anchor line: not a content block
    if (STANDALONE_ANCHOR_RE.test(stripped)) {
      i += 1;
      continue;
    }

    // Setext heading
    const setextEnd = checkSetextHeading(lines, i);
    if (setextEnd !== null) {
      blocks.push({
        blockType: "setext_heading",
        startLine: i,
        endLine: setextEnd,
        startByte: lines[i].startByte,
        endByte: lines[setextEnd].endByte,
        fullEndByte: lines[setextEnd].fullEndByte,
        existingAnchor: null,
        containerSetextHazard: false,
      });
      i = setextEnd + 1;
      continue;
    }

    // Paragraph
    const startLine = i;
    while (i + 1 < numLines) {
      const nxt = lines[i + 1];
      if (!pyStrip(nxt.text)) break;
      if (
        /^[ \t]*(`{3,}|~{3,})/.test(nxt.text) ||
        pyLstrip(nxt.text).startsWith(">") ||
        isTableStart(lines, i + 1) ||
        isListMarkerLine(nxt.text) ||
        /^[ \t]*#{1,6}[ \t]+/.test(nxt.text) ||
        STANDALONE_ANCHOR_RE.test(pyStrip(nxt.text))
      ) {
        break;
      }
      i += 1;
    }
    const endLine = i;
    blocks.push({
      blockType: "paragraph",
      startLine,
      endLine,
      startByte: lines[startLine].startByte,
      endByte: lines[endLine].endByte,
      fullEndByte: lines[endLine].fullEndByte,
      existingAnchor: null,
      containerSetextHazard: false,
    });
    i += 1;
  }

  detectExistingAnchors(lines, blocks);
  return blocks;
}

/**
 * Attach anchors already present in the document to their blocks, honouring
 * the approved layouts only:
 * - paragraph / heading: a trailing ` ^anchor` on the block's last line
 * - list / blockquote / table / fenced: a standalone `^anchor` line exactly
 *   one blank line after the block, followed by a blank line or EOF
 */
function detectExistingAnchors(lines: SourceLine[], blocks: MarkdownBlock[]): void {
  const numLines = lines.length;
  for (const block of blocks) {
    if (block.existingAnchor !== null) continue;
    if (block.blockType === "paragraph" || block.blockType === "heading") {
      const m = TRAILING_ANCHOR_RE.exec(lines[block.endLine].text);
      if (m) block.existingAnchor = m[1];
      continue;
    }
    if (
      block.blockType === "list" ||
      block.blockType === "blockquote" ||
      block.blockType === "table" ||
      block.blockType === "fenced"
    ) {
      if (block.endLine + 2 >= numLines) continue;
      const sep = lines[block.endLine + 1];
      const marker = lines[block.endLine + 2];
      if (pyStrip(sep.text) !== "") continue;
      const m = STANDALONE_ANCHOR_RE.exec(pyStrip(marker.text));
      if (!m) continue;
      if (block.endLine + 3 >= numLines || pyStrip(lines[block.endLine + 3].text) === "") {
        block.existingAnchor = m[1];
      }
    }
  }
}

/** All standalone / trailing anchor tokens present anywhere in the note. */
function findAllAnchorTokens(lines: SourceLine[]): Set<string> {
  const tokens = new Set<string>();
  for (const line of lines) {
    const stripped = pyStrip(line.text);
    const standalone = STANDALONE_ANCHOR_RE.exec(stripped);
    if (standalone) {
      tokens.add(standalone[1]);
      continue;
    }
    const trailing = TRAILING_ANCHOR_STRIPPED_RE.exec(stripped);
    if (trailing) tokens.add(trailing[1]);
  }
  return tokens;
}

/**
 * Find the single block containing every non-empty fragment of the selection.
 *
 * Fails closed: if any non-empty fragment maps to no block, or to a different
 * block, the selection is not anchorable.
 */
function findTargetBlock(
  lines: SourceLine[],
  blocks: MarkdownBlock[],
  startByte: number,
  endByte: number,
): MarkdownBlock | null {
  let target: MarkdownBlock | null = null;
  for (const line of lines) {
    if (line.endByte <= startByte || line.startByte >= endByte) continue;
    const segStart = Math.max(line.startByte, startByte);
    const segEnd = Math.min(line.endByte, endByte);
    if (segEnd <= segStart) continue;
    // The CLI strips the raw *bytes* here (`seg_bytes.strip()`), whose default
    // set is ASCII whitespace only — unlike `str.strip()`.
    if (bytesStripIsEmpty(
      line.rawBytes.subarray(segStart - line.startByte, segEnd - line.startByte),
    )) {
      continue;
    }
    let lineBlock: MarkdownBlock | null = null;
    for (const block of blocks) {
      if (block.startLine <= line.index && line.index <= block.endLine) {
        lineBlock = block;
        break;
      }
    }
    if (!lineBlock) return null;
    if (target === null) target = lineBlock;
    else if (target !== lineBlock) return null;
  }
  return target;
}

/**
 * Newline style of the note at `pos`, mirroring the CLI's `_detect_newline`
 * and falling back to whichever style the document actually contains.
 */
function detectNewline(sourceBytes: Uint8Array, pos: number): "\n" | "\r\n" {
  if (pos >= 2 && sourceBytes[pos - 2] === CR && sourceBytes[pos - 1] === LF) {
    return "\r\n";
  }
  if (pos >= 1 && sourceBytes[pos - 1] === LF) return "\n";
  for (let i = 0; i + 1 < sourceBytes.length; i++) {
    if (sourceBytes[i] === CR && sourceBytes[i + 1] === LF) return "\r\n";
  }
  return "\n";
}

/**
 * Resolve the target block for the selection and produce the byte-exact
 * insertion plan for `^<anchorName>`.
 *
 * The returned plan never mutates the source: the caller applies
 * `insertBytes` at `insertByte`. `existing` and `failed` carry no bytes, so
 * the caller leaves the note untouched.
 *
 * Mirrors the CLI's `_resolve_and_insert_anchor`, including every conservative
 * failure: unclosed fences, Setext headings, container Setext hazards and
 * foreign anchors.
 */
export function buildAnchorInsertion(
  sourceBytes: Uint8Array,
  startByte: number,
  endByte: number,
  anchorName: string,
): AnchorInsertionPlan {
  const lines = parseSourceLines(sourceBytes);
  const blocks = parseMarkdownBlocks(lines);
  const target = findTargetBlock(lines, blocks, startByte, endByte);
  // The CLI detects the newline lazily, at the container block's end position,
  // so an early `failed` return must not depend on it. Resolve it only where
  // bytes are actually produced.
  let cachedNewline: "\n" | "\r\n" | undefined;
  const newlineOf = (pos: number): "\n" | "\r\n" => {
    if (cachedNewline === undefined) {
      cachedNewline = detectNewline(sourceBytes, pos);
    }
    return cachedNewline;
  };

  const fail = (reason: string): AnchorInsertionPlan => ({
    status: "failed",
    reason,
    newline: newlineOf(endByte),
    insertByte: null,
    insertBytes: null,
  });

  if (!target) {
    return fail("could not identify containing block for selection; anchor not inserted");
  }
  if (target.blockType === "unclosed_fenced") {
    return fail("selection is inside an unclosed fenced code block; anchor not inserted");
  }
  if (target.blockType === "setext_heading") {
    return fail(
      "selection is a Setext heading; anchor insertion into Setext headings is not supported",
    );
  }
  if (target.containerSetextHazard) {
    return fail(
      "selection is inside a blockquote/callout/list containing a Setext heading; " +
        "anchor insertion into containers with Setext headings is not supported",
    );
  }

  if (target.existingAnchor !== null) {
    if (target.existingAnchor === anchorName) {
      return {
        status: "existing",
        reason: `anchor '^${anchorName}' already present; left unchanged`,
        newline: newlineOf(endByte),
        insertByte: null,
        insertBytes: null,
      };
    }
    return fail(
      `target block already has a different anchor '^${target.existingAnchor}'; anchor not inserted`,
    );
  }

  if (findAllAnchorTokens(lines).has(anchorName)) {
    return fail(
      `anchor '^${anchorName}' already exists on another block; anchor not inserted`,
    );
  }

  // Paragraph / heading: append to the last line of the block, preceded by a
  // single space unless the line already ends in whitespace.
  if (target.blockType === "paragraph" || target.blockType === "heading") {
    const lastLine = lines[target.endLine];
    const toInsert = /[ \t]$/.test(lastLine.text)
      ? utf8Encode(`^${anchorName}`)
      : utf8Encode(` ^${anchorName}`);
    return {
      status: "inserted",
      newline: newlineOf(endByte),
      insertByte: lastLine.endByte,
      insertBytes: toInsert,
    };
  }

  // Container blocks (list / blockquote / table / fenced): a standalone marker
  // line after the block, isolated by blank lines on both sides.
  const lastLine = lines[target.endLine];
  const blockEndPos = lastLine.fullEndByte;
  const newline = newlineOf(blockEndPos);
  const nlBytes = utf8Encode(newline);
  const anchorLine = utf8Encode(`^${anchorName}${newline}`);
  // A block whose last line carries no terminator (EOF, unterminated file)
  // needs a newline before the marker line can start.
  const leadingNl = lastLine.newline.length === 0 ? nlBytes : new Uint8Array(0);
  const rest = sourceBytes.subarray(blockEndPos);
  const followedByBlankLine = rest.length > 0 && (rest[0] === LF || (rest[0] === CR && rest[1] === LF));
  let toInsert: Uint8Array;
  if (rest.length === 0) {
    // EOF: blank line, marker line, terminating blank line.
    toInsert = concatBytes(leadingNl, nlBytes, anchorLine, nlBytes);
  } else if (followedByBlankLine) {
    // Already followed by a blank line; `rest` provides the trailing blank.
    toInsert = concatBytes(leadingNl, nlBytes, anchorLine);
  } else {
    // Immediately followed by text: a blank line on each side of the marker.
    toInsert = concatBytes(leadingNl, nlBytes, anchorLine, nlBytes);
  }
  return {
    status: "inserted",
    newline,
    insertByte: blockEndPos,
    insertBytes: toInsert,
  };
}

/**
 * Splice `insertBytes` into `sourceBytes` at `insertByte`.
 *
 * Only meaningful for a plan whose status is `inserted`; used by callers that
 * already hold the note bytes (the mobile director) to build the new content.
 */
export function applyAnchorInsertion(
  sourceBytes: Uint8Array,
  insertByte: number,
  insertBytes: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(sourceBytes.length + insertBytes.length);
  out.set(sourceBytes.subarray(0, insertByte), 0);
  out.set(insertBytes, insertByte);
  out.set(sourceBytes.subarray(insertByte), insertByte + insertBytes.length);
  return out;
}
