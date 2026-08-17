import { describe, expect, it } from "vitest";

import {
  extractWikilinks,
  figureKeyOf,
  parseMocNote,
} from "../src/services/moc-parse";

const BASE_MOC = `---
kind: topic-moc
title: 测试主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
`;

describe("figureKeyOf", () => {
  it("extracts key from Figure解读_<key>", () => {
    expect(figureKeyOf("Figure解读_fooBar2024")).toBe("fooBar2024");
  });

  it("strips .md suffix", () => {
    expect(figureKeyOf("Figure解读_fooBar2024.md")).toBe("fooBar2024");
  });

  it("returns undefined for non-Figure解读 target", () => {
    expect(figureKeyOf("someOtherNote")).toBeUndefined();
  });

  it("returns undefined for empty key after prefix", () => {
    expect(figureKeyOf("Figure解读_")).toBeUndefined();
  });
});

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    expect(extractWikilinks("[[target1]] and [[target2]]")).toEqual([
      "target1",
      "target2",
    ]);
  });

  it("uses target side of alias", () => {
    expect(extractWikilinks("[[target|label]]")).toEqual(["target"]);
  });

  it("ignores empty wikilinks", () => {
    expect(extractWikilinks("[[]]")).toEqual([]);
  });
});

describe("parseMocNote", () => {
  it("returns undefined when kind is missing", () => {
    const text = `---
title: 某主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
`;
    expect(parseMocNote("05 Literature/MOCs/x.md", text)).toBeUndefined();
  });

  it("returns undefined when kind is not topic-moc", () => {
    const text = `---
kind: paper
title: 某主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
`;
    expect(parseMocNote("05 Literature/MOCs/x.md", text)).toBeUndefined();
  });

  it("uses frontmatter title when present", () => {
    const result = parseMocNote("05 Literature/MOCs/x.md", BASE_MOC);
    expect(result?.title).toBe("测试主题");
  });

  it("falls back to filename stem when title is absent", () => {
    const text = `---
kind: topic-moc
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
`;
    const result = parseMocNote("05 Literature/MOCs/拟时序分析.md", text);
    expect(result?.title).toBe("拟时序分析");
  });

  it("uses only the first four-column table", () => {
    const text = `---
kind: topic-moc
title: 多表主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 摘要1 | |

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行2 | [[Figure解读_b2024]] | 摘要2 | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].titleText).toBe("行1");
  });

  it("ignores prose above the table", () => {
    const text = `---
kind: topic-moc
title: 带说明的主题
---

这是一些说明文字。

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 摘要1 | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries).toHaveLength(1);
  });

  it("drops fully empty placeholder rows", () => {
    const text = `---
kind: topic-moc
title: 带空行
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 摘要1 | |
| | | | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].titleText).toBe("行1");
  });

  it("converts <br> to newline in summary", () => {
    const text = `---
kind: topic-moc
title: 换行测试
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 第一行<br>第二行 | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries[0].summaryText).toBe("第一行\n第二行");
  });

  it("extracts figure key from wikilink", () => {
    const text = `---
kind: topic-moc
title: key测试
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_avdeevaArchVeloArchetypalVelocity2026]] | 摘要 | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries[0].figureKey).toBe(
      "avdeevaArchVeloArchetypalVelocity2026",
    );
    expect(result?.entries[0].figureLink).toBe(
      "Figure解读_avdeevaArchVeloArchetypalVelocity2026",
    );
  });

  it("extracts card links with alias labels", () => {
    const text = `---
kind: topic-moc
title: 卡片测试
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 摘要 | [[card_Figure2_x\\|短标题]] |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries[0].cardLinks).toEqual(["card_Figure2_x"]);
  });

  it("keeps entry when figure link is broken but title present", () => {
    const text = `---
kind: topic-moc
title: broken测试
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | 普通文字 | 摘要 | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].figureKey).toBeUndefined();
    expect(result?.entries[0].figureLink).toBeUndefined();
  });

  it("handles empty summary as empty string", () => {
    const text = `---
kind: topic-moc
title: 空摘要
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | | |
`;
    const result = parseMocNote("05 Literature/MOCs/x.md", text);
    expect(result?.entries[0].summaryText).toBe("");
  });

  it("returns empty entries for empty table", () => {
    const result = parseMocNote("05 Literature/MOCs/x.md", BASE_MOC);
    expect(result?.entries).toEqual([]);
  });
});
