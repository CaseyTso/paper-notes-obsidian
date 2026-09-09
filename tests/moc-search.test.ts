import { describe, expect, it } from "vitest";

import {
  createSnippet,
  indexTopicMocs,
  searchTopicMocs,
} from "../src/services/moc-index";
import {
  extractCellVisibleText,
  parseMocNote,
} from "../src/services/moc-parse";

describe("extractCellVisibleText", () => {
  it("extracts visible label from wikilink with alias and ignores target", () => {
    const text = extractCellVisibleText("[[Figure解读_pbmc2024|PBMC图谱解读]]");
    expect(text).toBe("PBMC图谱解读");
    expect(text).not.toContain("Figure解读_pbmc2024");
  });

  it("extracts target without .md from wikilink without alias", () => {
    const text = extractCellVisibleText("[[Figure解读_smith2024.md]]");
    expect(text).toBe("Figure解读_smith2024");
  });

  it("handles escaped pipes in table cells", () => {
    const text = extractCellVisibleText("[[card_Figure1_x\\|细胞分化卡片]]");
    expect(text).toBe("细胞分化卡片");
    expect(text).not.toContain("card_Figure1_x");
  });

  it("extracts visible label from standard Markdown links and discards url", () => {
    const text = extractCellVisibleText("[单细胞测序论文](https://doi.org/10.1038/s41586-024-001)");
    expect(text).toBe("单细胞测序论文");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("doi.org");
  });

  it("preserves underscores inside scientific identifiers and abbreviations", () => {
    const text = extractCellVisibleText("scRNA_seq_sample of Gene_A_1 and CART_CRS_IL6 mechanism");
    expect(text).toBe("scRNA_seq_sample of Gene_A_1 and CART_CRS_IL6 mechanism");
  });

  it("converts underscore emphasis when bounded by whitespace", () => {
    const text = extractCellVisibleText("这是 _重点_ 和 __核心__ 概念");
    expect(text).toBe("这是 重点 和 核心 概念");
  });

  it("strips HTML tags and converts <br> to space", () => {
    const text = extractCellVisibleText("第一段<br>第二段<b>加粗</b>");
    expect(text).toBe("第一段 第二段加粗");
  });

  it("strips markdown formatting like bold, italic, strikethrough, and code", () => {
    const text = extractCellVisibleText("**加粗** and *斜体* and `代码` and ~~删除线~~");
    expect(text).toBe("加粗 and 斜体 and 代码 and 删除线");
  });

  it("unescapes escaped characters", () => {
    const text = extractCellVisibleText("Line with \\[brackets\\] and \\*asterisk\\*");
    expect(text).toBe("Line with [brackets] and *asterisk*");
  });
});

describe("createSnippet", () => {
  it("returns empty snippet for empty text", () => {
    expect(createSnippet("", ["test"])).toEqual({ snippet: "", matchedTerms: [] });
  });

  it("returns full text if length is within maxLen", () => {
    const { snippet, matchedTerms } = createSnippet("Short summary", ["summary"], 80);
    expect(snippet).toBe("Short summary");
    expect(matchedTerms).toEqual(["summary"]);
  });

  it("centers snippet window around earliest matched term and adds ellipses", () => {
    const longText =
      "Introduction to single-cell genomics followed by nonnegative matrix factorization NMF analysis on PBMC samples for immunology research";
    const { snippet, matchedTerms } = createSnippet(longText, ["nmf"], 40);
    expect(snippet).toContain("NMF");
    expect(snippet.startsWith("…") || snippet.endsWith("…")).toBe(true);
    expect(matchedTerms).toEqual(["nmf"]);
  });

  it("preserves complete matched token when query token exceeds normal snippet budget (>80 chars)", () => {
    const longToken = "immunoglobulin_heavy_chain_variable_region_hypermutation_frequency_analysis_protocol_sc_2024"; // 93 chars
    expect(longToken.length).toBeGreaterThan(80);
    const fullText = `Prefix text before the target sequence: ${longToken}. Trailing summary analysis information text.`;
    const { snippet, matchedTerms } = createSnippet(fullText, [longToken], 80);
    expect(snippet).toContain(longToken);
    expect(matchedTerms).toEqual([longToken]);
  });
});

describe("MOC Content Search (MOC 内容搜索)", () => {
  const MOC_A = `---
kind: topic-moc
title: 单细胞NMF分析
---

这是外部段落说明，提到了 SECRET_OUTSIDE_PROSE。

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 单细胞测序综述 | [[Figure解读_sc2024\\|单细胞图谱解读]] | 采用多样本一致性元程序提取与质控评估 | [[card_Fig1\\|质控卡片]] |
| 淋巴细胞分化机制 | [[Figure解读_tcell2023\\|T细胞分化解读]] | 揭示了单核细胞分化路径 | [[card_Fig2\\|分化卡片]] |
`;

  const MOC_B = `---
kind: topic-moc
title: CART-CRS核心机制
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 细胞因子释放综合征 | [[Figure解读_crs2024\\|CRS机制解读]] | 涉及巨噬细胞活化与IL-6级联反应 | [[card_CRS_IL6\\|CRS卡片]] |
`;

  const MOC_EMPTY = `---
kind: topic-moc
title: 纯空主题
---
`;

  const parsedMocs = [
    parseMocNote("05 Literature/MOCs/单细胞NMF分析.md", MOC_A)!,
    parseMocNote("05 Literature/MOCs/CART-CRS核心机制.md", MOC_B)!,
    parseMocNote("05 Literature/MOCs/纯空主题.md", MOC_EMPTY)!,
  ];

  it("searches Column 1: Title (论文标题)", () => {
    const results = searchTopicMocs(parsedMocs, "测序综述");
    expect(results).toHaveLength(1);
    expect(results[0].moc.title).toBe("单细胞NMF分析");
    expect(results[0].matchingRowCount).toBe(1);
    expect(results[0].excerpts[0].column).toBe("title");
    expect(results[0].excerpts[0].snippet).toContain("测序综述");
  });

  it("searches Column 2: Figure解读 link text (visible label, not target path)", () => {
    // Search visible label
    const labelResults = searchTopicMocs(parsedMocs, "单细胞图谱解读");
    expect(labelResults).toHaveLength(1);
    expect(labelResults[0].moc.title).toBe("单细胞NMF分析");
    expect(labelResults[0].matchingRowCount).toBe(1);
    expect(labelResults[0].excerpts.some((e) => e.column === "figure")).toBe(true);

    // Search hidden target path: should NOT match because alias is present
    const targetResults = searchTopicMocs(parsedMocs, "sc2024");
    expect(targetResults).toHaveLength(0);
  });

  it("searches Column 3: Topic Summary (总结)", () => {
    const results = searchTopicMocs(parsedMocs, "质控评估");
    expect(results).toHaveLength(1);
    expect(results[0].moc.title).toBe("单细胞NMF分析");
    expect(results[0].matchingRowCount).toBe(1);
    expect(results[0].excerpts[0].column).toBe("summary");
    expect(results[0].excerpts[0].snippet).toContain("质控评估");
  });

  it("searches Column 4: Card Column (卡片 wikilink visible labels)", () => {
    // Search visible label
    const results = searchTopicMocs(parsedMocs, "分化卡片");
    expect(results).toHaveLength(1);
    expect(results[0].moc.title).toBe("单细胞NMF分析");
    expect(results[0].matchingRowCount).toBe(1);
    expect(results[0].excerpts.some((e) => e.column === "card")).toBe(true);

    // Search hidden target: should NOT match
    const hiddenResults = searchTopicMocs(parsedMocs, "card_Fig2");
    expect(hiddenResults).toHaveLength(0);
  });

  it("excludes text outside the Topic Table and external note bodies", () => {
    const results = searchTopicMocs(parsedMocs, "SECRET_OUTSIDE_PROSE");
    expect(results).toHaveLength(0);
  });

  it("is case-insensitive for English and mixed queries", () => {
    const r1 = searchTopicMocs(parsedMocs, "nmf");
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0].moc.title).toBe("单细胞NMF分析");

    const r2 = searchTopicMocs(parsedMocs, "cart");
    expect(r2.length).toBeGreaterThan(0);
    expect(r2[0].moc.title).toBe("CART-CRS核心机制");

    const r3 = searchTopicMocs(parsedMocs, "il-6");
    expect(r3.length).toBeGreaterThan(0);
    expect(r3[0].moc.title).toBe("CART-CRS核心机制");
  });

  it("ANDs multiple terms within a single Topic Entry + Topic Title", () => {
    // Term 1 in Topic Title ("单细胞"), Term 2 in Row 2 Summary ("单核细胞")
    const results = searchTopicMocs(parsedMocs, "单细胞 单核细胞");
    expect(results).toHaveLength(1);
    expect(results[0].moc.title).toBe("单细胞NMF分析");
    expect(results[0].matchingRowCount).toBe(1);
  });

  it("prevents cross-row false positives (words scattered across different rows never match)", () => {
    // Row 1 has "测序综述", Row 2 has "单核细胞".
    // Neither term is in Topic Title ("CART-CRS核心机制").
    // Under MOC_A, title is "单细胞NMF分析" which does NOT contain either term.
    const results = searchTopicMocs(parsedMocs, "测序综述 单核细胞");
    expect(results).toHaveLength(0);
  });

  it("matches title-only without fabricated row snippets on empty table or non-matching table", () => {
    // 1. Title match on empty table
    const rEmpty = searchTopicMocs(parsedMocs, "纯空主题");
    expect(rEmpty).toHaveLength(1);
    expect(rEmpty[0].moc.title).toBe("纯空主题");
    expect(rEmpty[0].titleMatched).toBe(true);
    expect(rEmpty[0].matchingRowCount).toBe(0);
    expect(rEmpty[0].excerpts).toEqual([]);

    // 2. Title match on topic whose table rows don't contain query term
    const rTitle = searchTopicMocs(parsedMocs, "CART-CRS");
    expect(rTitle).toHaveLength(1);
    expect(rTitle[0].moc.title).toBe("CART-CRS核心机制");
    expect(rTitle[0].titleMatched).toBe(true);
    expect(rTitle[0].matchingRowCount).toBe(0);
    expect(rTitle[0].excerpts).toEqual([]);
  });

  it("limits snippets to at most two excerpts per topic card", () => {
    // Row 1 matches in multiple columns: title, figure, summary, card
    const results = searchTopicMocs(parsedMocs, "单细胞");
    expect(results).toHaveLength(1);
    expect(results[0].excerpts.length).toBeLessThanOrEqual(2);
  });

  it("returns all topics with empty excerpts when query is empty or whitespace", () => {
    const results = searchTopicMocs(parsedMocs, "   ");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.excerpts.length === 0)).toBe(true);
  });

  it("indexes and sorts topic notes by zh-CN title, skipping non-MOCs", () => {
    const notes = [
      { path: "05 Literature/MOCs/Z.md", text: "---\nkind: topic-moc\ntitle: 乙主题\n---\n" },
      { path: "05 Literature/MOCs/A.md", text: "---\nkind: topic-moc\ntitle: 甲主题\n---\n" },
      { path: "05 Literature/MOCs/Ignore.md", text: "# Not a MOC" },
      { path: "05 Literature/Other/Outside.md", text: "---\nkind: topic-moc\ntitle: 外层\n---\n" },
    ];
    const indexed = indexTopicMocs(notes);
    expect(indexed.map((m) => m.title)).toEqual(["甲主题", "乙主题"]);
  });

  it("extracts excerpt with intact token when matching table text with query token > 80 chars", () => {
    const longToken = "chimeric_antigen_receptor_t_cell_immunotherapy_cytokine_release_syndrome_biomarker_cascade"; // 90 chars
    const mocWithLongText = `---
kind: topic-moc
title: CAR-T免疫疗法
---
| Title | Figure解读 | 总结 | 卡片 |
| --- | --- | --- | --- |
| 临床试验 | [[Figure1\\|疗效分析]] | Context before: ${longToken} Context after. | [[card1]] |
`;
    const parsed = [parseMocNote("05 Literature/MOCs/CAR-T.md", mocWithLongText)!];
    const results = searchTopicMocs(parsed, longToken);
    expect(results).toHaveLength(1);
    expect(results[0].excerpts).toHaveLength(1);
    expect(results[0].excerpts[0].snippet).toContain(longToken);
    expect(results[0].excerpts[0].matchedTerms).toContain(longToken);
  });
});

