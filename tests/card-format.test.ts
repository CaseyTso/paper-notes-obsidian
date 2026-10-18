/**
 * Unit tests for `src/shared/card-format.ts` — the single format source shared
 * by the desktop CLI writer and the mobile direct-vault writer (ADR 0006 /
 * 0007).
 *
 * The contract asserted here is the one in
 * `tests/core-contract.integration.test.ts`: card path/stem/frontmatter, the
 * `> 参见` backlink line, the trailing `## 扩展`, the `^card-<16 hex>` anchor
 * naming, the block-type-dependent insertion, and the inserted / existing /
 * failed anchor statuses.
 *
 * Everything under test is a pure function, so these assertions hold on both
 * sides of the two-writer split: if the CLI and the TS re-implementation
 * disagree, one of these numbers is wrong and a card written on mobile will
 * be rejected by the desktop CLI.
 */

import { describe, expect, it } from "vitest";

import {
  applyAnchorInsertion,
  buildAnchorInsertion,
  cardAnchorLink,
  cardAnchorName,
  cardFilenameOf,
  cardRelativePath,
  computeSelectionByteOffsets,
  findPositionAfterHeading,
  formatCardContent,
  parseFigureSource,
  parseMarkdownBlocks,
  parseSourceLines,
  slugifyCardFilename,
  type DigestFn,
} from "../src/shared/card-format";

/** Deterministic digest so anchor-name tests need no Web Crypto. */
const stubDigest: DigestFn = async (bytes) => {
  // XOR-fold the bytes into a stable 32-byte digest.
  const out = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    out[i % 32] ^= bytes[i];
  }
  return out;
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
// BOM-preserving, matching the CLI's `raw.decode("utf-8", errors="replace")`
// and the module's own `utf8Decode`.
const decode = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

const ANCHOR = "card-0123456789abcdef";
const KEY = "shiau2024";

describe("slugifyCardFilename", () => {
  it("preserves CJK characters", () => {
    expect(slugifyCardFilename("多模态基准突破")).toBe("多模态基准突破");
    // A fullwidth colon is a legal filename character and survives.
    expect(slugifyCardFilename("中文：测试")).toBe("中文：测试");
  });

  it("replaces every unsafe filename character with an underscore", () => {
    expect(slugifyCardFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(slugifyCardFilename("a\x00b\x01c\x1fd")).toBe("a_b_c_d");
  });

  it("strips leading and trailing dots only after the unsafe-char pass", () => {
    expect(slugifyCardFilename("..leading")).toBe("leading");
    expect(slugifyCardFilename("trailing..")).toBe("trailing");
    expect(slugifyCardFilename("...dots...")).toBe("dots");
    // A dot in the middle is a legal filename character and survives.
    expect(slugifyCardFilename("a.b.c")).toBe("a.b.c");
  });

  it("collapses whitespace and underscore runs, then trims underscores", () => {
    expect(slugifyCardFilename("  spaced  out  ")).toBe("spaced_out");
    expect(slugifyCardFilename("a\tb\nc")).toBe("a_b_c");
    expect(slugifyCardFilename("a___b")).toBe("a_b");
    expect(slugifyCardFilename("_leading_")).toBe("leading");
    expect(slugifyCardFilename("__a__b__")).toBe("a_b");
  });

  it("falls back to `card` for an empty result", () => {
    expect(slugifyCardFilename("")).toBe("card");
    expect(slugifyCardFilename("   ")).toBe("card");
    expect(slugifyCardFilename("///")).toBe("card");
    expect(slugifyCardFilename("___")).toBe("card");
    expect(slugifyCardFilename("...")).toBe("card");
  });

  it("builds the final filename as card_<slug>.md", () => {
    expect(cardFilenameOf("多模态基准突破")).toBe("card_多模态基准突破.md");
    expect(cardFilenameOf("")).toBe("card_card.md");
  });

  it("builds the vault-relative POSIX card path", () => {
    expect(cardRelativePath(KEY, "多模态基准突破")).toBe(
      `05 Literature/${KEY}/cards/card_多模态基准突破.md`,
    );
    // Forward slashes, no leading slash: the CLI contract for `data.path`.
    const path = cardRelativePath(KEY, "a/b");
    expect(path.includes("\\")).toBe(false);
    expect(path.startsWith("/")).toBe(false);
  });
});

describe("cardAnchorName", () => {
  it("matches the CLI anchor shape /^card-[0-9a-f]{16}$/", async () => {
    const name = await cardAnchorName("card_多模态基准突破", stubDigest);
    expect(name).toMatch(/^card-[0-9a-f]{16}$/);
  });

  it("is deterministic for the same stem", async () => {
    const a = await cardAnchorName("card_多模态基准突破", stubDigest);
    const b = await cardAnchorName("card_多模态基准突破", stubDigest);
    expect(a).toBe(b);
  });

  it("differs for different stems", async () => {
    const a = await cardAnchorName("card_多模态基准突破", stubDigest);
    const b = await cardAnchorName("card_不同卡片针对相同锚点区块", stubDigest);
    expect(a).not.toBe(b);
  });

  it("hashes the stem's UTF-8 bytes", async () => {
    // Two stems with the same UTF-16 length but different byte lengths must
    // not collide: the digest is over bytes, not code units.
    const a = await cardAnchorName("card_a", stubDigest);
    const b = await cardAnchorName("card_中", stubDigest);
    expect(a).not.toBe(b);
  });

  it("uses Web Crypto when no digest is injected", async () => {
    // `crypto.subtle` is present in Node 20+, Obsidian desktop and mobile.
    const name = await cardAnchorName("card_多模态基准突破");
    expect(name).toMatch(/^card-[0-9a-f]{16}$/);
  });
});

describe("cardAnchorLink", () => {
  it("builds the backlink pointing at the Figure Interpretation note block", () => {
    expect(cardAnchorLink(KEY, ANCHOR)).toBe(
      `[[Figure解读_${KEY}#^${ANCHOR}|Figure解读_${KEY}]]`,
    );
  });
});

describe("formatCardContent", () => {
  const params = {
    paperId: "11111111-2222-3333-4444-555555555555",
    citationKey: KEY,
  };

  it("emits the three-field frontmatter with `paper` quoted", () => {
    const content = formatCardContent({ ...params, selection: "图 1", anchorLink: null });
    expect(content.startsWith(
      "---\n" +
        "paper_id: 11111111-2222-3333-4444-555555555555\n" +
        `citation_key: ${KEY}\n` +
        `paper: "[[${KEY}]]"\n` +
        "---\n\n",
    )).toBe(true);
  });

  it("keeps the selection verbatim and appends `## 扩展`", () => {
    const content = formatCardContent({ ...params, selection: "选中文本", anchorLink: null });
    expect(content).toContain("选中文本");
    expect(content.endsWith("选中文本\n\n## 扩展\n")).toBe(true);
  });

  it("emits the `> 参见` line when the anchor was inserted", () => {
    const link = cardAnchorLink(KEY, ANCHOR);
    const content = formatCardContent({ ...params, selection: "选中文本", anchorLink: link });
    expect(content).toContain(`> 参见 ${link}`);
    expect(content.endsWith(`选中文本\n\n> 参见 ${link}\n\n## 扩展\n`)).toBe(true);
  });

  it("omits the `> 参见` line entirely when the anchor failed", () => {
    const content = formatCardContent({ ...params, selection: "选中文本", anchorLink: null });
    expect(content).not.toContain("参见");
    expect(content).not.toContain(`[[Figure解读_${KEY}`);
    expect(content).not.toContain(`#^${ANCHOR}`);
  });

  it("uses LF when the selection has no CRLF", () => {
    const link = cardAnchorLink(KEY, ANCHOR);
    const content = formatCardContent({ ...params, selection: "a\nb", anchorLink: link });
    expect(content).not.toContain("\r\n");
    expect(content).toBe(
      `---\npaper_id: 11111111-2222-3333-4444-555555555555\n` +
        `citation_key: ${KEY}\npaper: "[[${KEY}]]"\n---\n\n` +
        `a\nb\n\n> 参见 ${link}\n\n## 扩展\n`,
    );
  });

  it("uses CRLF when the selection contains any CRLF", () => {
    const link = cardAnchorLink(KEY, ANCHOR);
    const content = formatCardContent({ ...params, selection: "a\r\nb", anchorLink: link });
    // The frontmatter stays LF: only the body follows the selection's style,
    // exactly as the CLI formats it.
    expect(content.startsWith(
      `---\npaper_id: 11111111-2222-3333-4444-555555555555\n` +
        `citation_key: ${KEY}\npaper: "[[${KEY}]]"\n---\n\n`,
    )).toBe(true);
    expect(content.endsWith(`a\r\nb\r\n\r\n> 参见 ${link}\r\n\r\n## 扩展\r\n`)).toBe(true);
  });

  it("does not double the separator when the selection already ends in newlines", () => {
    const link = cardAnchorLink(KEY, ANCHOR);
    expect(
      formatCardContent({ ...params, selection: "a\n", anchorLink: link }).endsWith(
        `a\n\n> 参见 ${link}\n\n## 扩展\n`,
      ),
    ).toBe(true);
    expect(
      formatCardContent({ ...params, selection: "a\n\n", anchorLink: link }).endsWith(
        `a\n\n> 参见 ${link}\n\n## 扩展\n`,
      ),
    ).toBe(true);
    expect(
      formatCardContent({ ...params, selection: "a\n\n", anchorLink: null }).endsWith(
        "a\n\n## 扩展\n",
      ),
    ).toBe(true);
  });
});

describe("parseFigureSource", () => {
  it("accepts the canonical Figure Interpretation Note path", () => {
    expect(parseFigureSource(`05 Literature/${KEY}/Figure解读_${KEY}.md`)).toEqual({
      key: KEY,
      sourceNote: `Figure解读_${KEY}`,
    });
  });

  it("rejects every non-canonical path", () => {
    expect(parseFigureSource(`05 Literature/${KEY}/${KEY}.md`)).toBeNull();
    expect(parseFigureSource(`05 Literature/${KEY}/cards/card_one.md`)).toBeNull();
    expect(parseFigureSource(`05 Literature/${KEY}/minerUmd_${KEY}.md`)).toBeNull();
    // A different but valid key is still a canonical Figure note.
    expect(parseFigureSource("05 Literature/other/Figure解读_other.md")).toEqual({
      key: "other",
      sourceNote: "Figure解读_other",
    });
    expect(parseFigureSource(`Notes/${KEY}/Figure解读_${KEY}.md`)).toBeNull();
    expect(parseFigureSource(`05 Literature/${KEY}/Figure解读_${KEY}.md/extra`)).toBeNull();
  });

  it("rejects traversal and invalid keys", () => {
    expect(parseFigureSource(`05 Literature/../${KEY}/Figure解读_${KEY}.md`)).toBeNull();
    expect(parseFigureSource("05 Literature/123author/Figure解读_123author.md")).toBeNull();
    expect(parseFigureSource("05 Literature/author 2024/Figure解读_author 2024.md")).toBeNull();
  });

  it("honours a custom literature root and strips surrounding slashes", () => {
    expect(
      parseFigureSource("Library/Papers/shiau2024/Figure解读_shiau2024.md", "Library/Papers"),
    ).toEqual({ key: "shiau2024", sourceNote: "Figure解读_shiau2024" });
    expect(
      parseFigureSource("/05 Literature/shiau2024/Figure解读_shiau2024.md", "/05 Literature/"),
    ).toEqual({ key: "shiau2024", sourceNote: "Figure解读_shiau2024" });
  });
});

describe("computeSelectionByteOffsets", () => {
  it("maps a single-line selection to its UTF-8 byte range", () => {
    const text = "abc\ndef";
    const result = computeSelectionByteOffsets(text, { line: 0, ch: 1 }, { line: 0, ch: 3 });
    expect(result.startByte).toBe(1);
    expect(result.endByte).toBe(3);
    expect(result.selectionText).toBe("bc");
  });

  it("handles CRLF without counting the terminator twice", () => {
    const text = "abc\r\ndef";
    const result = computeSelectionByteOffsets(text, { line: 1, ch: 0 }, { line: 1, ch: 3 });
    expect(result.startByte).toBe(5);
    expect(result.endByte).toBe(8);
    expect(result.selectionText).toBe("def");
  });

  it("handles multi-byte UTF-8 (CJK, emoji)", () => {
    const text = "图 1\n🧬 emoji";
    // ch counts UTF-16 code units, so "🧬 emo" ends at ch 6, not 5.
    const result = computeSelectionByteOffsets(
      text,
      { line: 1, ch: 0 },
      { line: 1, ch: 6 },
      "🧬 emo",
    );
    // "图 1\n" is 3 + 1 + 1 = 6 bytes; "🧬 emo" is 4 + 4 = 8 bytes.
    expect(result.startByte).toBe(6);
    expect(result.endByte).toBe(14);
    expect(result.selectionText).toBe("🧬 emo");
  });

  it("rejects a selection whose boundary splits a surrogate pair", () => {
    const text = "a🔬b";
    // ch 2 is between the two surrogates of the emoji.
    expect(() =>
      computeSelectionByteOffsets(text, { line: 0, ch: 1 }, { line: 0, ch: 2 }),
    ).toThrow(/代理对/);
  });

  it("rejects out-of-range and empty selections", () => {
    expect(() =>
      computeSelectionByteOffsets("a\nb", { line: 0, ch: 0 }, { line: 9, ch: 0 }),
    ).toThrow(/行号/);
    expect(() =>
      computeSelectionByteOffsets("a\nb", { line: 0, ch: 1 }, { line: 0, ch: 1 }),
    ).toThrow(/为空|无效/);
  });

  it("detects a stale buffer when the expected text no longer matches", () => {
    expect(() =>
      computeSelectionByteOffsets("a\nb", { line: 0, ch: 0 }, { line: 0, ch: 1 }, "z"),
    ).toThrow(/不一致/);
  });

  it("normalises CRLF before comparing the expected text", () => {
    const text = "abc\r\ndef";
    const result = computeSelectionByteOffsets(
      text,
      { line: 0, ch: 0 },
      { line: 0, ch: 3 },
      "abc",
    );
    expect(result.selectionText).toBe("abc");
  });

  it("returns the selected bytes as a subarray of the encoded file", () => {
    const text = "图 1\n选中";
    const result = computeSelectionByteOffsets(text, { line: 1, ch: 0 }, { line: 1, ch: 2 });
    expect(Array.from(result.selectionBytes)).toEqual(Array.from(encode("选中")));
  });
});

describe("findPositionAfterHeading", () => {
  it("finds the line after `## 扩展`", () => {
    expect(findPositionAfterHeading("---\na\n---\n\n## 扩展\n")).toEqual({ line: 5, ch: 0 });
  });

  it("handles CRLF content", () => {
    expect(findPositionAfterHeading("a\r\n## 扩展\r\nb")).toEqual({ line: 2, ch: 0 });
  });

  it("falls back to the heading's own line when it is last", () => {
    expect(findPositionAfterHeading("a\n## 扩展")).toEqual({ line: 1, ch: 5 });
  });

  it("returns null when the heading is absent", () => {
    expect(findPositionAfterHeading("no heading here")).toBeNull();
  });
});

describe("parseSourceLines", () => {
  it("records byte offsets for LF, CRLF and unterminated lines", () => {
    const lines = parseSourceLines(encode("a\nb\r\nc"));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
    expect(lines[0].startByte).toBe(0);
    expect(lines[0].endByte).toBe(1);
    expect(lines[0].fullEndByte).toBe(2);
    expect(lines[1].startByte).toBe(2);
    expect(lines[1].endByte).toBe(3);
    expect(lines[1].fullEndByte).toBe(5);
    expect(lines[2].startByte).toBe(5);
    expect(lines[2].endByte).toBe(6);
    expect(lines[2].fullEndByte).toBe(6);
    // The `\r` of a CRLF is not part of the line's text.
    expect(lines[1].text).toBe("b");
  });

  it("returns an empty list for empty input", () => {
    expect(parseSourceLines(encode(""))).toHaveLength(0);
  });
});

describe("buildAnchorInsertion — paragraph / heading blocks", () => {
  it("appends ` ^anchor` to the last line of the paragraph", () => {
    const text = "para line one\n\nnext\n";
    const bytes = encode(text);
    const start = 0;
    const end = start + encode("para line one").length;
    const plan = buildAnchorInsertion(bytes, start, end, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(plan.insertByte).toBe(encode("para line one").length);
    expect(decode(plan.insertBytes!)).toBe(` ^${ANCHOR}`);
    const out = applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!);
    expect(decode(out)).toBe(`para line one ^${ANCHOR}\n\nnext\n`);
  });

  it("does not double the space when the line already ends in whitespace", () => {
    const bytes = encode("para   \n");
    const plan = buildAnchorInsertion(bytes, 0, 6, ANCHOR);
    expect(decode(plan.insertBytes!)).toBe(`^${ANCHOR}`);
  });

  it("appends to an ATX heading block", () => {
    const bytes = encode("## heading\n\nbody\n");
    const plan = buildAnchorInsertion(bytes, 3, 10, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `## heading ^${ANCHOR}\n\nbody\n`,
    );
  });
});

describe("buildAnchorInsertion — container blocks", () => {
  it("adds a standalone marker line after a list, isolated by blank lines", () => {
    const text = "- item one\n- item two\n\nafter\n";
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 2, 11, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `- item one\n- item two\n\n^${ANCHOR}\n\nafter\n`,
    );
  });

  it("adds a standalone marker line after a blockquote", () => {
    const text = "> quoted\n> lines\n\nafter\n";
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 2, 15, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `> quoted\n> lines\n\n^${ANCHOR}\n\nafter\n`,
    );
  });

  it("adds a standalone marker line after a table", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter\n";
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 24, 29, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `| a | b |\n| --- | --- |\n| 1 | 2 |\n\n^${ANCHOR}\n\nafter\n`,
    );
  });

  it("keeps the source's CRLF when the note uses CRLF", () => {
    const text = "- item\r\n- item2\r\n\r\nafter\r\n";
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 10, 19, ANCHOR);
    expect(plan.newline).toBe("\r\n");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `- item\r\n- item2\r\n\r\n^${ANCHOR}\r\n\r\nafter\r\n`,
    );
  });

  it("emits a trailing blank line when the block is at EOF", () => {
    const bytes = encode("- item one\n- item two");
    const plan = buildAnchorInsertion(bytes, 2, 11, ANCHOR);
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `- item one\n- item two\n\n^${ANCHOR}\n\n`,
    );
  });

  it("does not add a blank line before the marker when the block already has none", () => {
    // A list followed directly by text (no blank line): the marker still gets
    // blank lines on both sides.
    const bytes = encode("- item\ntext\n");
    const plan = buildAnchorInsertion(bytes, 2, 6, ANCHOR);
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      `- item\n\n^${ANCHOR}\n\ntext\n`,
    );
  });
});

describe("buildAnchorInsertion — existing anchor", () => {
  it("reports `existing` and writes nothing when the block already has the same anchor", () => {
    const text = `para line ^${ANCHOR}\n\nafter\n`;
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 0, 14, ANCHOR);
    expect(plan.status).toBe("existing");
    expect(plan.insertBytes).toBeNull();
    expect(plan.insertByte).toBeNull();
  });

  it("detects a container's standalone anchor line", () => {
    const text = `- item one\n- item two\n\n^${ANCHOR}\n\nafter\n`;
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 2, 11, ANCHOR);
    expect(plan.status).toBe("existing");
    expect(plan.insertBytes).toBeNull();
  });

  it("reports `failed` and writes nothing when the block has a different anchor", () => {
    const text = "para line ^card-aaaaaaaaaaaaaaaa\n\nafter\n";
    const bytes = encode(text);
    const plan = buildAnchorInsertion(bytes, 0, 14, "card-bbbbbbbbbbbbbbbb");
    expect(plan.status).toBe("failed");
    expect(plan.insertBytes).toBeNull();
    expect(plan.reason).toMatch(/different anchor/);
  });

  it("reports `failed` when the anchor exists on another block", () => {
    const text = `first ^${ANCHOR}\n\nsecond para\n`;
    const bytes = encode(text);
    // Byte range of `second para`, a block that carries no anchor of its own.
    const start = encode(text.slice(0, text.indexOf("second"))).length;
    const plan = buildAnchorInsertion(bytes, start, start + encode("second para").length, ANCHOR);
    expect(plan.status).toBe("failed");
    expect(plan.reason).toMatch(/already exists on another block/);
  });
});

describe("buildAnchorInsertion — conservative failures", () => {
  it("fails inside an unclosed fenced code block", () => {
    const bytes = encode("```\ncode inside\n");
    const plan = buildAnchorInsertion(bytes, 4, 15, ANCHOR);
    expect(plan.status).toBe("failed");
    expect(plan.reason).toMatch(/unclosed fenced code block/);
    expect(plan.insertBytes).toBeNull();
  });

  it("appends after a closed fenced code block, never inside it", () => {
    // The CLI treats a closed fence as a container block: the marker line goes
    // after the closing fence, so no code line is ever annotated.
    const bytes = encode("```\ncode\n```\n\nafter\n");
    const plan = buildAnchorInsertion(bytes, 4, 8, ANCHOR);
    expect(plan.status).toBe("inserted");
    expect(decode(applyAnchorInsertion(bytes, plan.insertByte!, plan.insertBytes!))).toBe(
      "```\ncode\n```\n\n^" + ANCHOR + "\n\nafter\n",
    );
  });

  it("fails on a Setext heading", () => {
    const bytes = encode("Setext title\n=====\n\nbody\n");
    const plan = buildAnchorInsertion(bytes, 0, 13, ANCHOR);
    expect(plan.status).toBe("failed");
    expect(plan.reason).toMatch(/Setext heading/);
    expect(plan.insertBytes).toBeNull();
  });

  it("fails when the selection spans two blocks", () => {
    const bytes = encode("para one\n\npara two\n");
    const plan = buildAnchorInsertion(bytes, 0, 20, ANCHOR);
    expect(plan.status).toBe("failed");
    expect(plan.insertBytes).toBeNull();
  });

  it("fails inside a container whose logical content holds a Setext heading", () => {
    const bytes = encode("> quoted\n> ====\n\nafter\n");
    const plan = buildAnchorInsertion(bytes, 2, 8, ANCHOR);
    expect(plan.status).toBe("failed");
    expect(plan.reason).toMatch(/Setext heading/);
    expect(plan.insertBytes).toBeNull();
  });

  it("does not fail a container that merely contains a thematic break", () => {
    // `- - -` is a thematic break, not a Setext underline.
    const bytes = encode("- item\n\n- - -\n\nafter\n");
    const plan = buildAnchorInsertion(bytes, 2, 6, ANCHOR);
    expect(plan.status).toBe("inserted");
  });
});

describe("applyAnchorInsertion", () => {
  it("splices bytes at the given offset without touching the rest", () => {
    const bytes = encode("abcXYZdef");
    const out = applyAnchorInsertion(bytes, 3, encode("123"));
    expect(decode(out)).toBe("abc123XYZdef");
  });

  it("is a no-op for empty inserted bytes", () => {
    const bytes = encode("abc");
    expect(decode(applyAnchorInsertion(bytes, 1, new Uint8Array(0)))).toBe("abc");
  });
});

/**
 * Unicode alignment with the Python CLI.
 *
 * These pin the divergences that JS and Python have by default. Every
 * assertion here was verified against `paper_notes/cards.py` on CPython 3.13
 * (Unicode 15.1); see the differential case in
 * `tests/core-contract.integration.test.ts` for the end-to-end proof.
 */
describe("Python-semantics Unicode primitives", () => {
  it("treats fullwidth and non-ASCII decimal digits as list markers (Finding 2)", () => {
    for (const text of [
      "\uff11. item",
      "\uff12. item",
      "\u0663. item",
      "\u0664. item",
      "\u0967. item",
      "\u0e51. item",
    ]) {
      const blocks = parseMarkdownBlocks(parseSourceLines(encode(`${text}\n`)));
      expect(blocks.map((b) => b.blockType)).toEqual(["list"]);
    }
  });

  it("does not treat a bare marker as a block-level list (no trailing space)", () => {
    // The block-level regex requires a trailing space/tab, unlike the
    // container-walk regex that also accepts end-of-line.
    const blocks = parseMarkdownBlocks(parseSourceLines(encode("-\n\nafter\n")));
    expect(blocks.map((b) => b.blockType)).toEqual(["paragraph", "paragraph"]);
  });

  it("treats NBSP / ideographic-space indented lines as blockquotes (Finding 2)", () => {
    for (const indent of ["\u00a0", "\u3000", "\u2000", "\u2028", "\u0085", "\u001c"]) {
      const blocks = parseMarkdownBlocks(
        parseSourceLines(encode(`${indent}> quoted\n\nafter\n`)),
      );
      expect(blocks.map((b) => b.blockType)).toEqual(["blockquote", "paragraph"]);
    }
  });

  it("treats exotic Unicode whitespace as a blank separator line", () => {
    for (const blank of ["\u00a0", "\u3000", "\u0085", "\u001c", "\u001f", "\u2028"]) {
      const blocks = parseMarkdownBlocks(parseSourceLines(encode(`para\n${blank}\nafter\n`)));
      // A blank line breaks the paragraph regardless of which whitespace it uses.
      expect(blocks.map((b) => b.blockType)).toEqual(["paragraph", "paragraph"]);
    }
  });

  it("does NOT treat U+FEFF (BOM) as whitespace, unlike JS (Finding 3)", () => {
    // Python's `str.strip()` and `re \s` both keep U+FEFF; JS `trim()` and
    // `\s` both strip it. A BOM-only line is therefore NOT blank, so it does
    // not break the paragraph — the three lines form ONE paragraph block.
    const blocks = parseMarkdownBlocks(parseSourceLines(encode("para\n\ufeff\nafter\n")));
    expect(blocks.map((b) => b.blockType)).toEqual(["paragraph"]);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(2);
  });

  it("strips U+0085 and U+001C-1F but keeps U+FEFF in slugs (Finding 3)", () => {
    expect(slugifyCardFilename("title\u0085title")).toBe("title_title");
    expect(slugifyCardFilename("title\u001ctitle\u001d")).toBe("title_title");
    // A BOM survives: it is not Python whitespace, and it is not an unsafe
    // filename character either.
    expect(slugifyCardFilename("title\ufefftitle")).toBe("title\ufefftitle");
    expect(slugifyCardFilename("\u3000title\u3000")).toBe("title");
  });

  it("keeps a BOM through decode → insertion → encode (Finding 4)", () => {
    const withBom = encode("\ufeffpara\n");
    const plan = buildAnchorInsertion(withBom, 0, 4, ANCHOR);
    expect(plan.status).toBe("inserted");
    const out = applyAnchorInsertion(withBom, plan.insertByte!, plan.insertBytes!);
    // The three BOM bytes are untouched, and the anchor lands after the text.
    expect(Array.from(out.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(decode(out)).toBe(`\ufeffpara ^${ANCHOR}\n`);
    // Reverting the anchor restores the exact original byte stream.
    const reverted = out.subarray(0, plan.insertByte!) as Uint8Array;
    const rest = out.subarray(plan.insertByte! + plan.insertBytes!.length);
    const joined = new Uint8Array(reverted.length + rest.length);
    joined.set(reverted, 0);
    joined.set(rest, reverted.length);
    expect(Array.from(joined)).toEqual(Array.from(withBom));
  });

  it("detects a trailing anchor on a line with trailing whitespace", () => {
    // The CLI's regex allows trailing spaces/tabs after `^name`.
    const bytes = encode(`para ^${ANCHOR}  \n\nafter\n`);
    const plan = buildAnchorInsertion(bytes, 0, 4, ANCHOR);
    expect(plan.status).toBe("existing");
  });

  it("does not treat text that merely ends in `^name` as an anchor", () => {
    // The CLI requires a preceding space/tab; a bare `^name` at the end of a
    // paragraph is just text.
    const bytes = encode(`para^${ANCHOR}\n\nafter\n`);
    const plan = buildAnchorInsertion(bytes, 0, 8, "card-bbbbbbbbbbbbbbbb");
    expect(plan.status).toBe("inserted");
  });
});

describe("parseMarkdownBlocks", () => {
  it("classifies paragraphs, headings, lists, quotes, tables and fences", () => {
    const lines = parseSourceLines(
      encode("para\n## head\n- item\n> quote\n| a | b |\n| - | - |\n```\ncode\n```\n"),
    );
    const blocks = parseMarkdownBlocks(lines);
    expect(blocks.map((b) => b.blockType)).toEqual([
      "paragraph",
      "heading",
      "list",
      "blockquote",
      "table",
      "fenced",
    ]);
  });

  it("classifies an unclosed fence as `unclosed_fenced`", () => {
    const blocks = parseMarkdownBlocks(parseSourceLines(encode("```\ncode\n")));
    expect(blocks.map((b) => b.blockType)).toEqual(["unclosed_fenced"]);
  });

  it("classifies a Setext heading", () => {
    const blocks = parseMarkdownBlocks(parseSourceLines(encode("title\n=====\n")));
    expect(blocks.map((b) => b.blockType)).toEqual(["setext_heading"]);
  });

  it("skips standalone anchor lines rather than treating them as content", () => {
    const blocks = parseMarkdownBlocks(parseSourceLines(encode(`^${ANCHOR}\n\npara\n`)));
    expect(blocks.map((b) => b.blockType)).toEqual(["paragraph"]);
  });
});
