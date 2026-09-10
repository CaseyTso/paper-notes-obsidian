import { describe, expect, it } from "vitest";
import {
  buildMocMembership,
  buildMocTitleToPathMap,
} from "../src/services/moc-membership";
import type { ParsedMoc } from "../src/services/moc-parse";

function makeMoc(
  path: string,
  title: string,
  figureKeys: Array<string | undefined>,
): ParsedMoc {
  return {
    path,
    title,
    entries: figureKeys.map((figureKey, index) => ({
      titleText: `Paper ${index + 1}`,
      figureLink: figureKey ? `Figure解读_${figureKey}` : undefined,
      figureKey,
      summaryText: `Summary ${index + 1}`,
      cardLinks: [],
      figureText: "Figure",
      cardText: "Card",
    })),
  };
}

describe("buildMocMembership", () => {
  it("resolves normal membership binding citation keys to MOC display names", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA.md", "Topic A", [
        "shiau2024",
        "wang2023",
      ]),
      makeMoc("05 Literature/MOCs/TopicB.md", "Topic B", ["shiau2024"]),
    ];

    const membership = buildMocMembership(mocs);

    expect(membership.get("shiau2024")).toEqual(["Topic A", "Topic B"]);
    expect(membership.get("wang2023")).toEqual(["Topic A"]);
  });

  it("deduplicates multiple entries for the same key within a single Topic MOC", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA.md", "Topic A", [
        "shiau2024",
        "shiau2024",
        "shiau2024",
      ]),
    ];

    const membership = buildMocMembership(mocs);

    expect(membership.get("shiau2024")).toEqual(["Topic A"]);
    expect(membership.get("shiau2024")?.length).toBe(1);
  });

  it("ignores entries with undefined, blank, or missing figureKey", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA.md", "Topic A", [
        undefined,
        "",
        "   ",
        "validKey2024",
      ]),
    ];

    const membership = buildMocMembership(mocs);

    expect(membership.has("")).toBe(false);
    expect(membership.has("   ")).toBe(false);
    expect(membership.size).toBe(1);
    expect(membership.get("validKey2024")).toEqual(["Topic A"]);
  });

  it("sorts multiple Topic MOC names stably using zh-CN locale comparison", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/Zeta.md", "Zeta Topic", ["key1"]),
      makeMoc("05 Literature/MOCs/Beta.md", "Beta Topic", ["key1"]),
      makeMoc("05 Literature/MOCs/Alpha.md", "Alpha Topic", ["key1"]),
      makeMoc("05 Literature/MOCs/Zhong.md", "中文主题", ["key1"]),
      makeMoc("05 Literature/MOCs/Bei.md", "北京主题", ["key1"]),
    ];

    const membership = buildMocMembership(mocs);
    const sorted = membership.get("key1");

    expect(sorted).toBeDefined();
    const copy = [...(sorted ?? [])].sort((a, b) => a.localeCompare(b, "zh-CN"));
    expect(sorted).toEqual(copy);
  });

  it("omits keys with no Topic MOC membership from the Map (not present)", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA.md", "Topic A", ["shiau2024"]),
    ];

    const membership = buildMocMembership(mocs);

    expect(membership.has("shiau2024")).toBe(true);
    expect(membership.has("nonExistentKey")).toBe(false);
    expect(membership.get("nonExistentKey")).toBeUndefined();
  });

  it("returns an empty map for empty input or MOCs without entries", () => {
    expect(buildMocMembership([])).toEqual(new Map());

    const emptyMocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/Empty1.md", "Empty 1", []),
      makeMoc("05 Literature/MOCs/Empty2.md", "Empty 2", [undefined]),
    ];
    expect(buildMocMembership(emptyMocs)).toEqual(new Map());
  });

  it("ignores MOCs with blank titles", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/Blank.md", "   ", ["key1"]),
    ];
    const membership = buildMocMembership(mocs);
    expect(membership.size).toBe(0);
  });
});

describe("buildMocTitleToPathMap", () => {
  it("maps Topic MOC titles to note paths", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA.md", "Topic A", ["key1"]),
      makeMoc("05 Literature/MOCs/TopicB.md", "Topic B", ["key2"]),
    ];

    const map = buildMocTitleToPathMap(mocs);

    expect(map.get("Topic A")).toBe("05 Literature/MOCs/TopicA.md");
    expect(map.get("Topic B")).toBe("05 Literature/MOCs/TopicB.md");
  });

  it("keeps first path when titles collide", () => {
    const mocs: ParsedMoc[] = [
      makeMoc("05 Literature/MOCs/TopicA1.md", "Topic A", ["key1"]),
      makeMoc("05 Literature/MOCs/TopicA2.md", "Topic A", ["key2"]),
    ];

    const map = buildMocTitleToPathMap(mocs);

    expect(map.get("Topic A")).toBe("05 Literature/MOCs/TopicA1.md");
  });
});
