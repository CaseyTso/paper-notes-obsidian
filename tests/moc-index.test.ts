import { describe, expect, it } from "vitest";

import { listTopicMocs } from "../src/services/moc-index";

const MOC_TEXT = (title: string): string =>
  `---\nkind: topic-moc\ntitle: ${title}\n---\n\n| Title | Figure解读 | 总结 | 卡片 |\n| ----- | -------- | --- | --- |\n`;

const NON_MOC_TEXT = `---
kind: paper
title: not a moc
---

Some content.
`;

describe("listTopicMocs", () => {
  it("returns MOC items sorted by title via localeCompare", () => {
    const notes = [
      { path: "05 Literature/MOCs/单细胞NMF分析.md", text: MOC_TEXT("单细胞NMF分析") },
      { path: "05 Literature/MOCs/CART-CRS核心机制.md", text: MOC_TEXT("CART-CRS核心机制") },
    ];
    const result = listTopicMocs(notes);
    expect(result).toHaveLength(2);
    // Verify sort: result must be in localeCompare order
    const expected = [...notes].sort((a, b) =>
      a.text.match(/title: (.+)/)![1].localeCompare(b.text.match(/title: (.+)/)![1], "zh-CN"),
    );
    expect(result.map((r) => r.path)).toEqual(expected.map((n) => n.path));
  });

  it("rejects notes outside MOCs folder", () => {
    const notes = [
      { path: "05 Literature/smith2024/smith2024.md", text: MOC_TEXT("fake") },
    ];
    expect(listTopicMocs(notes)).toEqual([]);
  });

  it("rejects notes in nested subfolders under MOCs", () => {
    const notes = [
      { path: "05 Literature/MOCs/nested/sub.md", text: MOC_TEXT("nested") },
    ];
    expect(listTopicMocs(notes)).toEqual([]);
  });

  it("skips non-MOC notes in MOCs folder", () => {
    const notes = [
      { path: "05 Literature/MOCs/valid.md", text: MOC_TEXT("valid") },
      { path: "05 Literature/MOCs/notmoc.md", text: NON_MOC_TEXT },
    ];
    const result = listTopicMocs(notes);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("valid");
  });

  it("keeps duplicate titles with different paths", () => {
    const notes = [
      { path: "05 Literature/MOCs/dup.md", text: MOC_TEXT("同名") },
      { path: "05 Literature/MOCs/dup2.md", text: MOC_TEXT("同名") },
    ];
    const result = listTopicMocs(notes);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("同名");
    expect(result[1].title).toBe("同名");
    expect(result[0].path).not.toBe(result[1].path);
  });

  it("returns empty array for empty input", () => {
    expect(listTopicMocs([])).toEqual([]);
  });
});
