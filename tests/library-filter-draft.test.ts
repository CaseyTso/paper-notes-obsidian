/**
 * Pending Library Filters draft contract tests (Task 24 redesign, lane F).
 *
 * Pure, vault-free coverage of the panel's editing contract:
 *  - raw-string numeric draft fields stay retainable while invalid
 *    (typing `2001` passes through `2` → `20` → `200` → `2001`),
 *  - blank vs. `0` minimum metrics are different states,
 *  - native `type=number` badInput (value sanitized to `""`) is rejected
 *    instead of being read as "unbounded",
 *  - drafts convert atomically: never a partially-applicable snapshot,
 *    never maxima, never shared arrays,
 *  - canonical CAS/JCR rank matching over known raw spellings, and
 *  - applied-group counting / summary / full-library journal options.
 *
 * Metrics are compared at their original precision; nothing rounds data.
 */
import { describe, expect, it } from "vitest";

import {
  CAS_PARTITION_CHOICES,
  JCR_QUARTILE_CHOICES,
  casPartitionRank,
  collectJournalOptions,
  countActiveLibraryFilterGroups,
  createEmptyLibraryFilterDraft,
  createLibraryFilterDraft,
  describeLibraryFilters,
  jcrQuartile,
  validateLibraryFilterDraft,
  type LibraryFilterDraft,
  type NumericFilterField,
} from "../src/components/library-filter-draft";
import {
  EMPTY_LIBRARY_FILTERS,
  applyLibraryFilters,
  type LibraryFilters,
} from "../src/components/library-filters";
import type { LibraryItem } from "../src/components/library-table";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_C = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Draft with all four raw numeric fields blank and nothing selected. */
function draft(overrides: Partial<LibraryFilterDraft> = {}): LibraryFilterDraft {
  return { ...createEmptyLibraryFilterDraft(), ...overrides };
}

/** Applied filters carrying no conditions at all. */
function applied(overrides: Partial<LibraryFilters> = {}): LibraryFilters {
  return { ...EMPTY_LIBRARY_FILTERS, ...overrides };
}

/** Three rows spanning journals/years/statuses/metrics (AND coverage). */
function fixtureItems(): LibraryItem[] {
  return [
    {
      path: "05 Literature/alpha2024/alpha2024.md",
      key: "alpha2024",
      paperId: UUID_A,
      title: "Alpha cells in the pancreas",
      firstAuthor: "Shiau Wen",
      year: 2024,
      journal: "Nature Methods",
      readingStatus: "read",
      artifacts: { pdf: true, minerU: true, figure: false },
      metrics: { cas: "中科院一区", jcr: "Q1", if: 8.1, jci: 2.3 },
    },
    {
      path: "05 Literature/beta2023/beta2023.md",
      key: "beta2023",
      paperId: UUID_B,
      title: "Beta cells in the islet",
      firstAuthor: "Islet Study Group",
      year: 2023,
      journal: "nature methods",
      readingStatus: "unread",
      artifacts: { pdf: true, minerU: false, figure: false },
      metrics: { cas: "中科院二区", jcr: "Q2", if: 4.9, jci: 1.1 },
    },
    {
      path: "05 Literature/gamma2022/gamma2022.md",
      key: "gamma2022",
      paperId: UUID_C,
      title: "Gamma oscillations in cortex",
      firstAuthor: "",
      year: 2022,
      journal: "Cell",
      readingStatus: "reading",
      artifacts: { pdf: true, minerU: true, figure: true },
      metrics: { cas: "1区", jcr: "Q3", if: 5.1, jci: 0.5 },
    },
  ];
}

function keysOf(items: LibraryItem[]): string[] {
  return items.map((item) => item.key);
}

describe("raw numeric draft fields", () => {
  it("keeps partial year input invalid but retained, and accepts a complete year", () => {
    for (const partial of ["2", "20", "200"]) {
      // One pending draft object is reused across validation, exactly as a
      // panel would: the raw text must survive validation untouched.
      const pending = draft({ yearFrom: partial });
      const result = validateLibraryFilterDraft(pending);
      expect(result.filters, partial).toBeUndefined();
      expect(result.errors.yearFrom, partial).toBeDefined();
      expect(pending.yearFrom, partial).toBe(partial);
    }
    const complete = draft({ yearFrom: "2001" });
    const result = validateLibraryFilterDraft(complete);
    expect(result.errors).toEqual({});
    expect(result.filters?.yearFrom).toBe(2001);
    expect(complete.yearFrom).toBe("2001");
  });

  it("keeps year values numeric four-digit numbers inside 1000..9999", () => {
    for (const field of ["yearFrom", "yearTo"] as const) {
      // Leading-zero shapes are four digits but not four-digit NUMBERS:
      // they would convert to 0/1/999 and could never reopen validly.
      for (const raw of ["0000", "0001", "0999"]) {
        const pending = draft({ [field]: raw });
        const result = validateLibraryFilterDraft(pending);
        expect(result.filters, `${field}:${raw}`).toBeUndefined();
        expect(result.errors[field], `${field}:${raw}`).toBeDefined();
        expect(pending[field], `${field}:${raw}`).toBe(raw);
      }
      // Boundaries are valid and inclusive.
      for (const raw of ["1000", "9999"]) {
        const result = validateLibraryFilterDraft(draft({ [field]: raw }));
        expect(result.errors, `${field}:${raw}`).toEqual({});
        expect(result.filters?.[field], `${field}:${raw}`).toBe(Number(raw));
      }
    }
  });

  it("reapplies a validated year as raw text without losing validity", () => {
    const pending = createLibraryFilterDraft(applied({ yearFrom: 1000, yearTo: 9999 }));
    expect(pending.yearFrom).toBe("1000");
    expect(pending.yearTo).toBe("9999");
    const first = validateLibraryFilterDraft(pending);
    expect(first.errors).toEqual({});
    expect(first.filters?.yearFrom).toBe(1000);
    expect(first.filters?.yearTo).toBe(9999);
    // Draft again from the applied snapshot: still valid, same values.
    const reopened = createLibraryFilterDraft(first.filters!);
    const second = validateLibraryFilterDraft(reopened);
    expect(second.errors).toEqual({});
    expect(second.filters?.yearFrom).toBe(1000);
    expect(second.filters?.yearTo).toBe(9999);
    expect(reopened.yearFrom).toBe("1000");
    expect(reopened.yearTo).toBe("9999");
  });

  it("rejects negative, non-numeric and non-finite metric text", () => {
    for (const raw of ["-1", "abc", "NaN", "Infinity", "-Infinity", "1,5", "--1", "1.2.3", "+5"]) {
      const result = validateLibraryFilterDraft(draft({ ifMin: raw }));
      expect(result.filters, raw).toBeUndefined();
      expect(result.errors.ifMin, raw).toBeDefined();
    }
  });

  it("accepts fractional non-negative metric minima without rounding them", () => {
    const result = validateLibraryFilterDraft(
      draft({ ifMin: "0.5", jciMin: "12.3456789" }),
    );
    expect(result.errors).toEqual({});
    expect(result.filters?.ifMin).toBe(0.5);
    expect(result.filters?.jciMin).toBe(12.3456789);
  });

  it("accepts in-progress decimal shapes a native number input allows", () => {
    for (const raw of [".5", "5.", "0.0", "1e3", " 7.25 "]) {
      const result = validateLibraryFilterDraft(draft({ jciMin: raw }), {});
      expect(result.errors, raw).toEqual({});
      expect(result.filters?.jciMin, raw).toBe(Number(raw.trim()));
    }
  });

  it("treats a blank metric as unset but 0 as a genuine threshold", () => {
    const blank = validateLibraryFilterDraft(draft({ ifMin: "", jciMin: "   " }));
    expect(blank.errors).toEqual({});
    expect(blank.filters?.ifMin).toBeUndefined();
    expect(blank.filters?.jciMin).toBeUndefined();
    expect(countActiveLibraryFilterGroups(blank.filters!)).toBe(0);

    const zero = validateLibraryFilterDraft(draft({ ifMin: "0", jciMin: "0" }));
    expect(zero.errors).toEqual({});
    expect(zero.filters?.ifMin).toBe(0);
    expect(zero.filters?.jciMin).toBe(0);
    expect(countActiveLibraryFilterGroups(zero.filters!)).toBe(2);
  });

  it("rejects a reversed year interval on both endpoints", () => {
    const result = validateLibraryFilterDraft(draft({ yearFrom: "2024", yearTo: "2020" }));
    expect(result.filters).toBeUndefined();
    expect(result.errors.yearFrom).toBeDefined();
    expect(result.errors.yearTo).toBeDefined();

    const equal = validateLibraryFilterDraft(draft({ yearFrom: "2024", yearTo: "2024" }));
    expect(equal.errors).toEqual({});
    expect(equal.filters?.yearFrom).toBe(2024);
    expect(equal.filters?.yearTo).toBe(2024);
  });

  it("honors native number-input badInput even when the value is sanitized to empty", () => {
    // Browsers report validity.badInput=true and value="" for unparseable
    // number input; that state must be rejected, never read as unbounded.
    const ifBad = validateLibraryFilterDraft(draft({ ifMin: "" }), { ifMin: true });
    expect(ifBad.filters).toBeUndefined();
    expect(ifBad.errors.ifMin).toBeDefined();

    const yearBad = validateLibraryFilterDraft(
      draft({ yearFrom: "", yearTo: "2020" }),
      { yearFrom: true },
    );
    expect(yearBad.filters).toBeUndefined();
    expect(yearBad.errors.yearFrom).toBeDefined();
    expect(yearBad.errors.yearTo).toBeUndefined();
    expect(countActiveLibraryFilterGroups(applied({ yearTo: 2020 }))).toBe(1);
  });

  it("reports every invalid field at once and never returns partial filters", () => {
    const result = validateLibraryFilterDraft(
      draft({ yearFrom: "20", yearTo: "abc", ifMin: "-2", jciMin: "" }),
      { jciMin: true },
    );
    expect(result.filters).toBeUndefined();
    expect(Object.keys(result.errors).sort()).toEqual([
      "ifMin",
      "jciMin",
      "yearFrom",
      "yearTo",
    ]);
  });

  it("keeps whitespace-padded valid values usable", () => {
    const result = validateLibraryFilterDraft(draft({ yearFrom: " 2019 ", ifMin: " 1.5 " }));
    expect(result.errors).toEqual({});
    expect(result.filters?.yearFrom).toBe(2019);
    expect(result.filters?.ifMin).toBe(1.5);
  });
});

describe("createLibraryFilterDraft", () => {
  it("renders applied numbers back as raw strings and clones artifacts", () => {
    const source = applied({
      yearFrom: 2019,
      yearTo: 2024,
      ifMin: 5,
      jciMin: 0.5,
      journal: "Nature",
      cas: "1区",
      jcr: "Q1",
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU"],
    });
    const created = createLibraryFilterDraft(source);
    expect(created).toEqual({
      yearFrom: "2019",
      yearTo: "2024",
      ifMin: "5",
      jciMin: "0.5",
      journal: "Nature",
      cas: "1区",
      jcr: "Q1",
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU"],
    });
    // Clone isolation in both directions.
    const fromSource = createLibraryFilterDraft(source);
    fromSource.requiredArtifacts.push("figure");
    expect(source.requiredArtifacts).toEqual(["pdf", "minerU"]);
    source.requiredArtifacts.push("figure");
    expect(fromSource.requiredArtifacts).toEqual(["pdf", "minerU", "figure"]);
    expect(created.requiredArtifacts).not.toBe(source.requiredArtifacts);
  });

  it("omits blank text selections instead of cloning empty strings", () => {
    const created = createLibraryFilterDraft(applied({ journal: "   ", cas: "", jcr: " " }));
    expect(created.journal).toBeUndefined();
    expect(created.cas).toBeUndefined();
    expect(created.jcr).toBeUndefined();
  });

  it("never propagates legacy maxima into the canonical draft", () => {
    const created = createLibraryFilterDraft(
      applied({ ifMin: 5, ifMax: 20, jciMin: 1, jciMax: 9 }) as LibraryFilters & {
        ifMax: number;
        jciMax: number;
      },
    );
    // Exactly the canonical draft fields, and no maximum field survives.
    expect(Object.keys(created).sort()).toEqual([
      "ifMin",
      "jciMin",
      "requiredArtifacts",
      "yearFrom",
      "yearTo",
    ]);
    expect("ifMax" in created).toBe(false);
    expect("jciMax" in created).toBe(false);
    expect(Object.keys(created).some((key) => key.includes("Max"))).toBe(false);
    // Round-tripping the draft also yields filters free of maxima.
    const back = validateLibraryFilterDraft(created);
    expect(back.errors).toEqual({});
    expect(Object.keys(back.filters!).sort()).toEqual([
      "ifMin",
      "jciMin",
      "requiredArtifacts",
    ]);
  });

  it("produces a fresh filters snapshot without maxima and without shared arrays", () => {
    const source = applied({
      yearFrom: 2019,
      requiredArtifacts: ["pdf"],
      ifMax: 99,
      jciMax: 99,
    } as LibraryFilters & { ifMax: number; jciMax: number });
    const result = validateLibraryFilterDraft(createLibraryFilterDraft(source));
    expect(result.filters).toBeDefined();
    expect(result.filters!.requiredArtifacts).toEqual(["pdf"]);
    expect(result.filters!.requiredArtifacts).not.toBe(source.requiredArtifacts);
    expect("ifMax" in result.filters!).toBe(false);
    expect("jciMax" in result.filters!).toBe(false);
    // Mutating the snapshot never reaches the applied filters.
    result.filters!.requiredArtifacts.push("figure");
    expect(source.requiredArtifacts).toEqual(["pdf"]);
  });

  it("round-trips an empty applied state into a blank draft", () => {
    const created = createLibraryFilterDraft(applied());
    expect(created).toEqual(createEmptyLibraryFilterDraft());
    const back = validateLibraryFilterDraft(created);
    expect(back.errors).toEqual({});
    expect(countActiveLibraryFilterGroups(back.filters!)).toBe(0);
    expect(describeLibraryFilters(back.filters!)).toEqual([]);
  });
});

describe("countActiveLibraryFilterGroups", () => {
  it("counts a year range once even with both endpoints set", () => {
    expect(countActiveLibraryFilterGroups(applied())).toBe(0);
    expect(countActiveLibraryFilterGroups(applied({ yearFrom: 2020 }))).toBe(1);
    expect(countActiveLibraryFilterGroups(applied({ yearTo: 2024 }))).toBe(1);
    expect(countActiveLibraryFilterGroups(applied({ yearFrom: 2020, yearTo: 2024 }))).toBe(1);
  });

  it("counts each minimum metric once and every other condition once", () => {
    const filters = applied({
      yearFrom: 2020,
      yearTo: 2024,
      ifMin: 5,
      jciMin: 1,
      journal: "Nature",
      cas: "1区",
      jcr: "Q1",
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU", "figure"],
    });
    // Year range 1 + IF 1 + JCI 1 + journal 1 + CAS 1 + JCR 1 + reading 1
    // + three required artifacts = 10 groups.
    expect(countActiveLibraryFilterGroups(filters)).toBe(10);
  });

  it("ignores blank text selections", () => {
    expect(
      countActiveLibraryFilterGroups(applied({ journal: "  ", cas: "", jcr: " " })),
    ).toBe(0);
  });
});

describe("describeLibraryFilters", () => {
  it("summarizes one line per active group and nothing for an empty state", () => {
    expect(describeLibraryFilters(applied())).toEqual([]);
    const filters = applied({
      yearFrom: 2020,
      yearTo: 2024,
      ifMin: 5,
      jciMin: 0.5,
      journal: "Nature Methods",
      cas: "1区",
      jcr: "Q1",
      readingStatus: "read",
      requiredArtifacts: ["pdf"],
    });
    expect(describeLibraryFilters(filters)).toEqual([
      "Year 2020–2024",
      "IF ≥ 5",
      "JCI ≥ 0.5",
      "Journal: Nature Methods",
      "CAS: 1区",
      "JCR: Q1",
      "Reading: Read",
      "Has PDF",
    ]);
    expect(describeLibraryFilters(filters)).toHaveLength(
      countActiveLibraryFilterGroups(filters),
    );
  });

  it("describes half-open year ranges", () => {
    expect(describeLibraryFilters(applied({ yearFrom: 2000 }))).toEqual(["Year from 2000"]);
    expect(describeLibraryFilters(applied({ yearTo: 2000 }))).toEqual(["Year to 2000"]);
  });
});

describe("collectJournalOptions", () => {
  it("collects trimmed, case-insensitively deduped journals from the full library", () => {
    const options = collectJournalOptions([
      { journal: "Nature Methods" },
      { journal: "  nature methods  " },
      { journal: "Cell" },
      { journal: "   " },
      { journal: undefined },
      {},
      { journal: "NATURE METHODS" },
      { journal: "Cell" },
    ]);
    expect(options).toEqual(["Nature Methods", "Cell"]);
  });

  it("is independent of any filtering and preserves first-seen order", () => {
    const items = fixtureItems();
    expect(collectJournalOptions(items)).toEqual(["Nature Methods", "Cell"]);
    // Even when filters remove rows, the supplied record set decides options.
    const filtered = applyLibraryFilters(items, applied({ journal: "Cell" }));
    expect(keysOf(filtered)).toEqual(["gamma2022"]);
    expect(collectJournalOptions(items)).toEqual(["Nature Methods", "Cell"]);
  });
});

describe("canonical CAS partition matching", () => {
  it("offers exactly the four fixed partitions", () => {
    expect([...CAS_PARTITION_CHOICES]).toEqual(["1区", "2区", "3区", "4区"]);
    expect([...JCR_QUARTILE_CHOICES]).toEqual(["Q1", "Q2", "Q3", "Q4"]);
  });

  it("maps every known spelling of rank 1..4 onto the same partition", () => {
    const spellings: Record<number, string[]> = {
      1: [
        "1",
        "1区",
        "中科院1区",
        "综合性期刊1区",
        "中科院一区",
        "中国科学院1区",
        "中科院分区1区",
        "CAS 1区",
        "医学1区",
        "生物1区",
        "医学一区",
      ],
      2: [
        "2",
        "2区",
        "中科院2区",
        "综合性期刊2区",
        "中科院二区",
        "CAS2区",
        "医学2区",
        "生物2区",
      ],
      3: ["3", "3区", "中科院3区", "综合性期刊3区", "中科院三区", "医学3区"],
      4: ["4", "4区", "中科院4区", "综合性期刊4区", "中科院四区", "生物4区"],
    };
    for (const [rank, values] of Object.entries(spellings)) {
      for (const value of values) {
        expect(casPartitionRank(value), value).toBe(Number(rank));
        expect(casPartitionRank(`${rank}区`)).toBe(Number(rank));
      }
    }
    // Chinese-numeral ranks are recognized with and without the 区 suffix.
    expect(casPartitionRank("一")).toBe(1);
    expect(casPartitionRank("二区")).toBe(2);
    expect(casPartitionRank("三")).toBe(3);
    expect(casPartitionRank("四区")).toBe(4);
  });

  it("never matches missing, unknown, misleading or ambiguous ranks", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "13区",
      "Q1",
      "5区",
      "0区",
      "中科院五区",
      "1区/2区",
      "1区、2区",
      "中科院1区top",
      "top1区",
      "一区top",
      "-1区",
      "1.5区",
      "1区2区",
    ]) {
      expect(casPartitionRank(value), String(value)).toBeUndefined();
    }
  });

  it("selects a partition through applyLibraryFilters with variant spellings", () => {
    const items = fixtureItems(); // alpha 中科院一区, beta 中科院二区, gamma 1区
    const selected = applyLibraryFilters(items, applied({ cas: "1区" }));
    expect(keysOf(selected).sort()).toEqual(["alpha2024", "gamma2022"]);
    // The selected value itself may be spelled any known way.
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "中科院1区" }))).sort()).toEqual([
      "alpha2024",
      "gamma2022",
    ]);
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "中科院一区" }))).sort()).toEqual([
      "alpha2024",
      "gamma2022",
    ]);
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "2区" })))).toEqual(["beta2023"]);
    // Unknown selection never behaves like a wildcard.
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "13区" })))).toEqual([]);
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "1区/2区" })))).toEqual([]);
    // Missing metrics stay excluded.
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "3区" })))).toEqual([]);
  });

  it("selects every subject-prefixed rank of the chosen partition in real dataset format", () => {
    // Regression: real EasyScholar CAS values are subject-prefixed
    // (`医学1区`, `生物2区`). Selecting 1区 must match ALL subjects' 1区.
    const items: LibraryItem[] = [
      { path: "a", key: "med1", paperId: UUID_A, title: "Med1", firstAuthor: "", journal: "Lancet", artifacts: { pdf: false, minerU: false, figure: false }, metrics: { cas: "医学1区", jcr: "Q1" } },
      { path: "b", key: "bio1", paperId: UUID_A, title: "Bio1", firstAuthor: "", journal: "Cell", artifacts: { pdf: false, minerU: false, figure: false }, metrics: { cas: "生物1区", jcr: "Q1" } },
      { path: "c", key: "multi1", paperId: UUID_A, title: "Multi1", firstAuthor: "", journal: "Nature", artifacts: { pdf: false, minerU: false, figure: false }, metrics: { cas: "综合性期刊1区", jcr: "Q1" } },
      { path: "d", key: "med2", paperId: UUID_A, title: "Med2", firstAuthor: "", journal: "BMJ", artifacts: { pdf: false, minerU: false, figure: false }, metrics: { cas: "医学2区", jcr: "Q2" } },
      { path: "e", key: "bio2", paperId: UUID_A, title: "Bio2", firstAuthor: "", journal: "eLife", artifacts: { pdf: false, minerU: false, figure: false }, metrics: { cas: "生物2区", jcr: "Q2" } },
    ];
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "1区" }))).sort()).toEqual([
      "bio1",
      "med1",
      "multi1",
    ]);
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "2区" }))).sort()).toEqual([
      "bio2",
      "med2",
    ]);
  });

  it("does not let a misleading raw rank match a different partition", () => {
    const items: LibraryItem[] = [
      {
        path: "p",
        key: "misleading",
        paperId: UUID_A,
        title: "Misleading",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
        metrics: { cas: "13区", jcr: "Q1" },
      },
    ];
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "1区" })))).toEqual([]);
    expect(keysOf(applyLibraryFilters(items, applied({ cas: "3区" })))).toEqual([]);
  });
});

describe("canonical JCR quartile matching", () => {
  it("matches the exact quartile with case folding and outer trim only", () => {
    expect(jcrQuartile("Q1")).toBe(1);
    expect(jcrQuartile("q1")).toBe(1);
    expect(jcrQuartile(" Q2 ")).toBe(2);
    expect(jcrQuartile(" q3 ")).toBe(3);
    expect(jcrQuartile("Q4")).toBe(4);
    // The quartile token is contiguous: internal whitespace between the
    // letter and the digit is NOT a quartile spelling.
    for (const value of ["Q 3", "Q\n3", "Q\t3", "QQ3", "Q-3", "Q1Q2", "Q0", "Q5"]) {
      expect(jcrQuartile(value), JSON.stringify(value)).toBeUndefined();
    }
    for (const value of [undefined, "", "   ", "1", "1区", "JCR Q1", "quartile 1", "中科院1区"]) {
      expect(jcrQuartile(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("selects one quartile through applyLibraryFilters", () => {
    const items = fixtureItems();
    expect(keysOf(applyLibraryFilters(items, applied({ jcr: "Q1" })))).toEqual(["alpha2024"]);
    expect(keysOf(applyLibraryFilters(items, applied({ jcr: "q2" })))).toEqual(["beta2023"]);
    expect(keysOf(applyLibraryFilters(items, applied({ jcr: " Q3 " })))).toEqual(["gamma2022"]);
    expect(keysOf(applyLibraryFilters(items, applied({ jcr: "Q4" })))).toEqual([]);
    // Internal-whitespace quartile spellings never select a known quartile.
    for (const value of ["Q 1", "Q\n2", "Q\t3", "Q 4"]) {
      expect(keysOf(applyLibraryFilters(items, applied({ jcr: value }))), value).toEqual([]);
    }
  });
});

describe("minimum metric filters at original precision", () => {
  it("excludes 4.9 and includes 5.1 for IF >= 5", () => {
    const items = fixtureItems();
    const result = validateLibraryFilterDraft(draft({ ifMin: "5" }));
    expect(result.filters?.ifMin).toBe(5);
    expect(keysOf(applyLibraryFilters(items, result.filters!))).toEqual([
      "alpha2024",
      "gamma2022",
    ]);
  });

  it("never rounds data or the threshold", () => {
    const items: LibraryItem[] = [
      {
        path: "p",
        key: "justBelow",
        paperId: UUID_A,
        title: "Just below",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
        metrics: { if: 4.9999999 },
      },
      {
        path: "p2",
        key: "justAbove",
        paperId: UUID_B,
        title: "Just above",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
        metrics: { if: 5.0000001 },
      },
      {
        path: "p3",
        key: "noMetric",
        paperId: UUID_C,
        title: "No metric",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
      },
    ];
    const filters = validateLibraryFilterDraft(draft({ ifMin: "5" })).filters!;
    expect(keysOf(applyLibraryFilters(items, filters))).toEqual(["justAbove"]);
    // A fractional threshold keeps its exact value.
    const fractional = validateLibraryFilterDraft(draft({ ifMin: "0.5" })).filters!;
    expect(fractional.ifMin).toBe(0.5);
    expect(keysOf(applyLibraryFilters(items, fractional))).toEqual([
      "justBelow",
      "justAbove",
    ]);
    // Zero is a genuine threshold, not "no condition": rows without a
    // metric are still excluded, but a real 0 metric now qualifies.
    const zero = validateLibraryFilterDraft(draft({ jciMin: "0" })).filters!;
    expect(keysOf(applyLibraryFilters(items, zero))).toEqual([]);
    const zeroItems: LibraryItem[] = [
      {
        path: "p4",
        key: "zeroJci",
        paperId: UUID_A,
        title: "Zero",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
        metrics: { jci: 0 },
      },
    ];
    expect(keysOf(applyLibraryFilters(zeroItems, zero))).toEqual(["zeroJci"]);
  });
});

describe("applyLibraryFilters AND semantics stay intact", () => {
  it("combines every condition with AND and excludes missing metadata", () => {
    const items = fixtureItems();
    const filters = validateLibraryFilterDraft(
      draft({
        yearFrom: "2022",
        yearTo: "2024",
        journal: "NATURE METHODS",
        cas: "中科院一区",
        jcr: "Q1",
        ifMin: "5",
        jciMin: "2",
      }),
    ).filters!;
    expect(filters.readingStatus).toBeUndefined();
    expect(filters.requiredArtifacts).toEqual([]);
    const withExtras: LibraryFilters = {
      ...filters,
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU"],
    };
    expect(keysOf(applyLibraryFilters(items, withExtras))).toEqual(["alpha2024"]);
  });

  it("keeps inclusive year endpoints and journal exact matching", () => {
    const items = fixtureItems();
    expect(
      keysOf(
        applyLibraryFilters(
          items,
          validateLibraryFilterDraft(draft({ yearFrom: "2023", yearTo: "2024" })).filters!,
        ),
      ),
    ).toEqual(["alpha2024", "beta2023"]);
    expect(
      keysOf(
        applyLibraryFilters(
          items,
          validateLibraryFilterDraft(draft({ journal: "nature methods" })).filters!,
        ),
      ),
    ).toEqual(["alpha2024", "beta2023"]);
    expect(
      keysOf(
        applyLibraryFilters(
          items,
          validateLibraryFilterDraft(draft({ journal: "Nature" })).filters!,
        ),
      ),
    ).toEqual([]);
  });

  it("keeps reading status and artifact requirements as AND conditions", () => {
    const items = fixtureItems();
    expect(
      keysOf(
        applyLibraryFilters(items, applied({ readingStatus: "read", requiredArtifacts: ["minerU"] })),
      ),
    ).toEqual(["alpha2024"]);
    expect(
      keysOf(
        applyLibraryFilters(items, applied({ requiredArtifacts: ["figure"] })),
      ),
    ).toEqual(["gamma2022"]);
    // Missing metadata is excluded, never treated as zero.
    const missing: LibraryItem[] = [
      {
        path: "p",
        key: "noYear",
        paperId: UUID_A,
        title: "No year",
        firstAuthor: "",
        journal: "Cell",
        artifacts: { pdf: false, minerU: false, figure: false },
      },
    ];
    expect(
      keysOf(
        applyLibraryFilters(missing, validateLibraryFilterDraft(draft({ yearTo: "2024" })).filters!),
      ),
    ).toEqual([]);
    expect(
      keysOf(
        applyLibraryFilters(missing, validateLibraryFilterDraft(draft({ ifMin: "0" })).filters!),
      ),
    ).toEqual([]);
  });
});

describe("required artifact de-duplication", () => {
  it("counts and summarizes unique artifact conditions for a duplicated list", () => {
    const duplicated = applied({
      requiredArtifacts: ["pdf", "pdf", "minerU", "figure", "pdf"],
    });
    expect(countActiveLibraryFilterGroups(duplicated)).toBe(3);
    expect(describeLibraryFilters(duplicated)).toEqual([
      "Has PDF",
      "Has MinerU",
      "Has Figure",
    ]);
  });

  it("de-duplicates the canonical draft and snapshot without mutating inputs", () => {
    const source = applied({
      requiredArtifacts: ["pdf", "pdf", "minerU", "figure", "pdf"],
    });
    const original = [...source.requiredArtifacts];

    const created = createLibraryFilterDraft(source);
    expect(created.requiredArtifacts).toEqual(["pdf", "minerU", "figure"]);
    expect(created.requiredArtifacts).not.toBe(source.requiredArtifacts);

    // A draft typed with duplicates converts to a unique snapshot too.
    const typed = draft({
      requiredArtifacts: ["pdf", "pdf", "minerU", "figure", "pdf"],
    });
    const typedOriginal = [...typed.requiredArtifacts];
    const result = validateLibraryFilterDraft(typed);
    expect(result.errors).toEqual({});
    expect(result.filters!.requiredArtifacts).toEqual(["pdf", "minerU", "figure"]);
    expect(result.filters!.requiredArtifacts).not.toBe(typed.requiredArtifacts);

    // Neither the applied source nor the draft was mutated.
    expect(source.requiredArtifacts).toEqual(original);
    expect(typed.requiredArtifacts).toEqual(typedOriginal);
  });

  it("keeps the AND predicate result unchanged for duplicated requirements", () => {
    const items = fixtureItems();
    const duplicated = applied({
      requiredArtifacts: ["pdf", "minerU", "pdf", "minerU"],
    });
    const unique = applied({ requiredArtifacts: ["pdf", "minerU"] });
    expect(keysOf(applyLibraryFilters(items, duplicated))).toEqual(
      keysOf(applyLibraryFilters(items, unique)),
    );
    expect(keysOf(applyLibraryFilters(items, duplicated))).toEqual([
      "alpha2024",
      "gamma2022",
    ]);
    expect(countActiveLibraryFilterGroups(duplicated)).toBe(2);
  });
});

describe("draft immutability", () => {
  it("never mutates the draft or the applied filters it came from", () => {
    const source = applied({
      yearFrom: 2020,
      ifMin: 5,
      requiredArtifacts: ["pdf"],
      journal: "Nature",
    });
    const snapshot = JSON.parse(JSON.stringify(source));
    const created = createLibraryFilterDraft(source);
    created.yearFrom = "1999";
    created.requiredArtifacts.push("figure");
    validateLibraryFilterDraft(created, { ifMin: true });
    expect(source).toEqual(snapshot);
    expect(source.requiredArtifacts).toEqual(["pdf"]);
  });
});

describe("frozen export surface", () => {
  it("exposes the planned helpers as functions", () => {
    const helpers: Record<string, unknown> = {
      casPartitionRank,
      jcrQuartile,
      collectJournalOptions,
      countActiveLibraryFilterGroups,
      createEmptyLibraryFilterDraft,
      createLibraryFilterDraft,
      describeLibraryFilters,
      validateLibraryFilterDraft,
    };
    for (const [name, value] of Object.entries(helpers)) {
      expect(typeof value, name).toBe("function");
    }
    // The error map is keyed by the four numeric fields only.
    const fields: NumericFilterField[] = ["yearFrom", "yearTo", "ifMin", "jciMin"];
    const result = validateLibraryFilterDraft(draft({ yearTo: "abc" }));
    expect(Object.keys(result.errors)).toEqual(["yearTo"]);
    expect(fields).toHaveLength(4);
  });
});
