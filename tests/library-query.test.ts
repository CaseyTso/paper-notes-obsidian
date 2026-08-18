/**
 * Library query/model tests (Task 24).
 *
 * These cover the pure, vault-free query model behind the Literature Library
 * view: column configuration (defaults + custom visibility/order/width),
 * item assembly (reading status, artifact availability, injected volatile
 * metrics), stable sorting, text search, filters (single + combined),
 * invalid-metadata rows, and read-only detail derivation.
 *
 * DOM rendering is deliberately not exercised here — the model is the
 * contract the view renders against. Metrics are UI-layer data: they are
 * injected per paper id and never touch the paper record.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIBRARY_COLUMNS,
  artifactStatusOf,
  buildLibraryItems,
  firstAuthorOf,
  formatColumnValue,
  readingStatusOf,
  resolveColumns,
  searchLibraryItems,
  sortLibraryItems,
  type ColumnCustomizations,
  type LibraryItem,
  type PaperMetrics,
} from "../src/components/library-table";
import { EMPTY_LIBRARY_FILTERS, applyLibraryFilters } from "../src/components/library-filters";
import { buildPaperDetail, formatAuthors } from "../src/components/paper-detail";
import type { InvalidRecord, PaperRecord } from "../src/types/paper";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_C = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function makeRecord(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    path: "05 Literature/alpha2024/alpha2024.md",
    key: "alpha2024",
    paperId: UUID_A,
    title: "Alpha cells in the pancreas",
    authors: [
      { family: "Shiau", given: "Wen" },
      { literal: "Global Consortium" },
    ],
    journal: "Nature Methods",
    journalAbbreviation: "Nat Methods",
    publicationDate: "2024-01-15",
    year: 2024,
    volume: "10",
    issue: "2",
    pages: "1-9",
    url: "https://doi.org/10.1000/alpha",
    issn: ["1234-5678"],
    language: "en",
    itemType: "article-journal",
    identifiers: { doi: "10.1000/alpha", pmid: "12345" },
    citationKeyAliases: ["alpha-old-key"],
    titleAliases: ["Alpha cells"],
    abstract: "Alpha abstract text.",
    ...overrides,
  };
}

const METRICS_A = { cas: "中科院一区", jcr: "Q1", if: 8.1, jci: 2.3 };
const METRICS_B = { cas: "中科院二区", jcr: "Q2", if: 4.0, jci: 1.1 };

/** Default build options with a per-path frontmatter + per-paper metrics. */
function buildOptions(
  overrides: {
    frontmatter?: (path: string) => Record<string, unknown> | undefined;
    listDirectory?: (dir: string) => string[];
    metrics?: (paperId: string) => PaperMetrics | undefined;
  } = {},
) {
  return {
    frontmatter: (path: string) => {
      if (overrides.frontmatter !== undefined) {
        return overrides.frontmatter(path);
      }
      return path === "05 Literature/alpha2024/alpha2024.md"
        ? { reading_status: "read" }
        : undefined;
    },
    listDirectory: (dir: string) => {
      if (overrides.listDirectory !== undefined) {
        return overrides.listDirectory(dir);
      }
      return dir === "05 Literature/alpha2024"
        ? ["alpha2024.pdf", "minerUmd_alpha2024.md"]
        : [];
    },
    metrics: (paperId: string) => {
      if (overrides.metrics !== undefined) {
        return overrides.metrics(paperId);
      }
      return paperId === UUID_A ? METRICS_A : undefined;
    },
  };
}

/** Three records spanning journals/years/statuses for filter tests. */
function fixtureItems(): LibraryItem[] {
  const records: PaperRecord[] = [
    makeRecord(),
    makeRecord({
      path: "05 Literature/beta2023/beta2023.md",
      key: "beta2023",
      paperId: UUID_B,
      title: "Beta cells in the islet",
      authors: [{ literal: "Islet Study Group" }],
      journal: "nature methods",
      year: 2023,
      identifiers: { arxiv: "2301.12345" },
      citationKeyAliases: [],
      titleAliases: [],
      abstract: "Beta abstract.",
    }),
    makeRecord({
      path: "05 Literature/gamma2022/gamma2022.md",
      key: "gamma2022",
      paperId: UUID_C,
      title: "Gamma oscillations in cortex",
      journal: "Cell",
      year: 2022,
      authors: [],
      identifiers: {},
      citationKeyAliases: [],
      titleAliases: [],
      abstract: "",
    }),
  ];
  return buildLibraryItems(records, [], {
    frontmatter: (path) => {
      if (path.includes("alpha2024")) {
        return { reading_status: "read" };
      }
      if (path.includes("beta2023")) {
        return { reading_status: "unread" };
      }
      return { reading_status: "reading" };
    },
    listDirectory: (dir) => {
      if (dir.includes("alpha2024")) {
        return ["alpha2024.pdf", "minerUmd_alpha2024.md"];
      }
      if (dir.includes("beta2023")) {
        return ["beta2023.pdf"];
      }
      return [
        "gamma2022.pdf",
        "minerUmd_gamma2022.md",
        "Figure解读_gamma2022.md",
      ];
    },
    metrics: (paperId) =>
      paperId === UUID_A ? METRICS_A : paperId === UUID_B ? METRICS_B : undefined,
  });
}

describe("default library columns", () => {
  it("defines the ten approved columns in the default order", () => {
    expect(DEFAULT_LIBRARY_COLUMNS.map((column) => column.id)).toEqual([
      "title",
      "firstAuthor",
      "year",
      "journal",
      "cas",
      "jcr",
      "if",
      "jci",
      "artifacts",
      "readingStatus",
    ]);
    expect(DEFAULT_LIBRARY_COLUMNS.map((column) => column.label)).toEqual([
      "Title",
      "First author",
      "Year",
      "Journal",
      "CAS",
      "JCR",
      "IF",
      "JCI",
      "PDF/MinerU/Figure",
      "Reading status",
    ]);
  });

  it("defaults every column to visible with a positive width", () => {
    for (const column of DEFAULT_LIBRARY_COLUMNS) {
      expect(column.visible).toBe(true);
      expect(column.width).toBeGreaterThan(0);
    }
  });
});

describe("resolveColumns", () => {
  it("keeps the defaults when no customization is given", () => {
    expect(resolveColumns({})).toEqual(DEFAULT_LIBRARY_COLUMNS);
  });

  it("hides customized columns without disturbing the rest", () => {
    const columns = resolveColumns({ cas: { visible: false } });
    expect(columns.map((column) => column.id)).not.toContain("cas");
    expect(columns.map((column) => column.id)).toHaveLength(9);
    expect(columns[0].id).toBe("title");
  });

  it("applies custom order deterministically", () => {
    const customizations: ColumnCustomizations = {
      title: { order: 1 },
      year: { order: 0 },
    };
    const columns = resolveColumns(customizations);
    expect(columns.slice(0, 2).map((column) => column.id)).toEqual([
      "year",
      "title",
    ]);
    // Unordered columns keep their default relative order after ordered ones.
    expect(columns.slice(2).map((column) => column.id)).toEqual([
      "firstAuthor",
      "journal",
      "cas",
      "jcr",
      "if",
      "jci",
      "artifacts",
      "readingStatus",
    ]);
  });

  it("applies custom width to the target column only", () => {
    const columns = resolveColumns({ if: { width: 90 } });
    expect(columns.find((column) => column.id === "if")?.width).toBe(90);
    expect(columns.find((column) => column.id === "jci")?.width).toBe(
      DEFAULT_LIBRARY_COLUMNS.find((column) => column.id === "jci")?.width,
    );
  });
});

describe("buildLibraryItems", () => {
  it("builds one item per record with derived display fields", () => {
    const record = makeRecord();
    const [item] = buildLibraryItems([record], [], buildOptions());
    expect(item.title).toBe("Alpha cells in the pancreas");
    expect(item.firstAuthor).toBe("Shiau Wen");
    expect(item.year).toBe(2024);
    expect(item.journal).toBe("Nature Methods");
    expect(item.artifacts).toEqual({ pdf: true, minerU: true, figure: false });
  });

  it("derives the reading status from frontmatter", () => {
    const [read] = buildLibraryItems([makeRecord()], [], {
      frontmatter: () => ({ reading_status: "read" }),
    });
    const [unknown] = buildLibraryItems([makeRecord()], [], {
      frontmatter: () => ({ reading_status: "some-other-state" }),
    });
    expect(read.readingStatus).toBe("read");
    expect(unknown.readingStatus).toBeUndefined();
  });

  it("injects volatile metrics per paper id without touching the record", () => {
    const record = makeRecord();
    const [item] = buildLibraryItems([makeRecord()], [], {
      metrics: () => METRICS_A,
    });
    expect(item.metrics).toEqual(METRICS_A);
    // The record type has no metrics field at all — metrics are UI data only.
    expect("metrics" in item.record!).toBe(false);
    expect("metrics" in record).toBe(false);
  });

  it("keeps invalid records visible as invalid metadata rows", () => {
    const invalid: InvalidRecord[] = [
      {
        path: "05 Literature/broken/broken.md",
        reasons: ["missing_title", "missing_paper_id"],
      },
    ];
    const items = buildLibraryItems([makeRecord()], invalid, buildOptions());
    const item = items[1]; // invalid rows follow the valid records
    expect(item.title).toBe("Invalid metadata");
    expect(item.invalid?.reasons).toEqual([
      "missing_title",
      "missing_paper_id",
    ]);
    expect(item.key).toBe("broken");
  });

  it("never shares mutable state with the source records", () => {
    const record = makeRecord();
    const [item] = buildLibraryItems([record], [], buildOptions());
    item.record!.title = "mutated in the view";
    item.record!.authors.push({ family: "Ghost" });
    expect(record.title).toBe("Alpha cells in the pancreas");
    expect(record.authors).toHaveLength(2);
    expect(item.title).toBe("Alpha cells in the pancreas");
  });
});

describe("firstAuthorOf and readingStatusOf helpers", () => {
  it("formats structured and literal first authors", () => {
    expect(firstAuthorOf(makeRecord())).toBe("Shiau Wen");
    expect(
      firstAuthorOf(
        makeRecord({ authors: [{ literal: "Global Consortium" }] }),
      ),
    ).toBe("Global Consortium");
    expect(firstAuthorOf(makeRecord({ authors: [] }))).toBe("");
  });

  it("reads only the approved reading-status vocabulary from frontmatter", () => {
    expect(readingStatusOf({ reading_status: "unread" })).toBe("unread");
    expect(readingStatusOf({ reading_status: "reading" })).toBe("reading");
    expect(readingStatusOf({ reading_status: "read" })).toBe("read");
    expect(readingStatusOf({ reading_status: "archived" })).toBeUndefined();
    expect(readingStatusOf(undefined)).toBeUndefined();
  });

  it("detects artifact availability from directory listing basenames", () => {
    const key = "alpha2024";
    expect(
      artifactStatusOf(key, [
        "alpha2024.pdf",
        "minerUmd_alpha2024.md",
        "Figure解读_alpha2024.md",
      ]),
    ).toEqual({ pdf: true, minerU: true, figure: true });
    expect(artifactStatusOf(key, ["notes.md", "attachments"])).toEqual({
      pdf: false,
      minerU: false,
      figure: false,
    });
    expect(artifactStatusOf(key, ["beta2024.pdf"])).toEqual({
      pdf: false,
      minerU: false,
      figure: false,
    });
  });
});

describe("searchLibraryItems", () => {
  it("matches title, authors, journal, year, identifiers, key, aliases and abstract", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    const items = [item];
    const find = (query: string) => searchLibraryItems(items, query);
    expect(find("pancreas")).toHaveLength(1); // title
    expect(find("Shiau")).toHaveLength(1); // author family
    expect(find("Global Consortium")).toHaveLength(1); // literal author
    expect(find("nature methods")).toHaveLength(1); // journal
    expect(find("2024")).toHaveLength(1); // year
    expect(find("10.1000/alpha")).toHaveLength(1); // DOI
    expect(find("12345")).toHaveLength(1); // PMID
    expect(find("alpha2024")).toHaveLength(1); // citation key
    expect(find("alpha-old-key")).toHaveLength(1); // alias
    expect(find("alpha abstract")).toHaveLength(1); // abstract
  });

  it("is case-insensitive and trims the query", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    expect(searchLibraryItems([item], "  ALPHA CELLS ")).toHaveLength(1);
  });

  it("matches multi-word queries by token AND when tokens are scattered", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    // "pancreas" (title) and "abstract" (abstract) never appear contiguously.
    expect(searchLibraryItems([item], "pancreas abstract")).toHaveLength(1);
    // Consecutive spaces produce no empty tokens.
    expect(searchLibraryItems([item], "pancreas   abstract")).toHaveLength(1);
    // Mixed case stays case-insensitive.
    expect(searchLibraryItems([item], "PANCREAS Abstract")).toHaveLength(1);
  });

  it("does not match multi-word queries that miss any token", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    expect(searchLibraryItems([item], "pancreas missing")).toHaveLength(0);
    expect(searchLibraryItems([item], "missing abstract")).toHaveLength(0);
  });

  it("returns everything for empty/whitespace queries and nothing on a miss", () => {
    const items = fixtureItems();
    expect(searchLibraryItems(items, "")).toHaveLength(3);
    expect(searchLibraryItems(items, "   ")).toHaveLength(3);
    expect(searchLibraryItems(items, "zzzz-not-there")).toHaveLength(0);
  });

  it("makes invalid rows findable by path and keeps them out of normal matches", () => {
    const invalid: InvalidRecord[] = [
      {
        path: "05 Literature/broken/broken.md",
        reasons: ["missing_title"],
      },
    ];
    const items = buildLibraryItems([makeRecord()], invalid, buildOptions());
    expect(searchLibraryItems(items, "pancreas")).toHaveLength(1);
    expect(searchLibraryItems(items, "broken")).toHaveLength(1);
  });
});

describe("sortLibraryItems", () => {
  it("sorts by year ascending and descending with missing years last", () => {
    const items = fixtureItems(); // 2024, 2023, 2022
    const asc = sortLibraryItems(items, { columnId: "year", direction: "asc" });
    expect(asc.map((item) => item.year)).toEqual([2022, 2023, 2024]);
    const desc = sortLibraryItems(items, {
      columnId: "year",
      direction: "desc",
    });
    expect(desc.map((item) => item.year)).toEqual([2024, 2023, 2022]);
    const withMissing = buildLibraryItems(
      [makeRecord({ year: undefined }), makeRecord({ year: 2000 })],
      [],
    );
    const missing = sortLibraryItems(withMissing, {
      columnId: "year",
      direction: "asc",
    });
    expect(missing[0].year).toBe(2000);
    expect(missing[1].year).toBeUndefined();
  });

  it("sorts by title case-insensitively", () => {
    const [upper, lower, mixed] = buildLibraryItems(
      [
        makeRecord({ title: "Alpha" }),
        makeRecord({ title: "beta" }),
        makeRecord({ title: "Gamma" }),
      ],
      [],
    );
    expect(
      sortLibraryItems([upper, lower, mixed], {
        columnId: "title",
        direction: "asc",
      }).map((item) => item.title),
    ).toEqual(["Alpha", "beta", "Gamma"]);
  });

  it("sorts numeric metric columns with missing values last", () => {
    const [a, b, c] = buildLibraryItems(
      [
        makeRecord({ paperId: UUID_A }),
        makeRecord({ paperId: UUID_B }),
        makeRecord({ paperId: UUID_C }),
      ],
      [],
      {
        metrics: (paperId) =>
          paperId === UUID_A
            ? METRICS_A
            : paperId === UUID_B
              ? METRICS_B
              : undefined,
      },
    );
    const desc = sortLibraryItems([a, b, c], {
      columnId: "if",
      direction: "desc",
    });
    expect(desc.map((item) => item.metrics?.if)).toEqual([8.1, 4.0, undefined]);
    const asc = sortLibraryItems([a, b, c], {
      columnId: "jci",
      direction: "asc",
    });
    expect(asc.map((item) => item.metrics?.jci)).toEqual([1.1, 2.3, undefined]);
  });

  it("is stable: equal keys preserve input order in both directions", () => {
    const records = [
      makeRecord({ year: 2023, title: "Zeta first" }),
      makeRecord({ year: 2023, title: "Alpha second" }),
    ];
    const items = buildLibraryItems(records, []);
    const asc = sortLibraryItems(items, { columnId: "year", direction: "asc" });
    expect(asc.map((item) => item.title)).toEqual([
      "Zeta first",
      "Alpha second",
    ]);
    const desc = sortLibraryItems(items, {
      columnId: "year",
      direction: "desc",
    });
    expect(desc.map((item) => item.title)).toEqual([
      "Zeta first",
      "Alpha second",
    ]);
  });

  it("returns a new array without mutating the input", () => {
    const items = fixtureItems();
    const before = items.map((item) => item.key);
    const sorted = sortLibraryItems(items, {
      columnId: "title",
      direction: "asc",
    });
    expect(sorted).not.toBe(items);
    expect(items.map((item) => item.key)).toEqual(before);
  });
});

describe("formatColumnValue", () => {
  it("formats every column deterministically", () => {
    const [item] = buildLibraryItems([makeRecord()], [], {
      frontmatter: () => ({ reading_status: "reading" }),
      listDirectory: () => [
        "alpha2024.pdf",
        "minerUmd_alpha2024.md",
        "Figure解读_alpha2024.md",
      ],
      metrics: () => METRICS_A,
    });
    expect(formatColumnValue(item, "title")).toBe("Alpha cells in the pancreas");
    expect(formatColumnValue(item, "firstAuthor")).toBe("Shiau Wen");
    expect(formatColumnValue(item, "year")).toBe("2024");
    expect(formatColumnValue(item, "journal")).toBe("Nature Methods");
    expect(formatColumnValue(item, "cas")).toBe("中科院一区");
    expect(formatColumnValue(item, "jcr")).toBe("Q1");
    expect(formatColumnValue(item, "if")).toBe("8.1");
    expect(formatColumnValue(item, "jci")).toBe("2.3");
    expect(formatColumnValue(item, "artifacts")).toBe("PDF · MinerU · Figure");
    expect(formatColumnValue(item, "readingStatus")).toBe("reading");
  });

  it("renders missing values as empty strings", () => {
    const [item] = buildLibraryItems(
      [makeRecord({ journal: undefined, year: undefined })],
      [],
    );
    expect(formatColumnValue(item, "journal")).toBe("");
    expect(formatColumnValue(item, "year")).toBe("");
    expect(formatColumnValue(item, "cas")).toBe("");
    expect(formatColumnValue(item, "if")).toBe("");
    expect(formatColumnValue(item, "artifacts")).toBe("");
    expect(formatColumnValue(item, "readingStatus")).toBe("");
  });
});

describe("applyLibraryFilters", () => {
  it("applies an inclusive year range", () => {
    const items = fixtureItems(); // 2024, 2023, 2022
    const filtered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      yearFrom: 2023,
      yearTo: 2024,
    });
    expect(filtered.map((item) => item.year)).toEqual([2024, 2023]);
  });

  it("filters journal case-insensitively as an exact match", () => {
    const items = fixtureItems();
    const filtered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      journal: "NATURE METHODS",
    });
    expect(filtered.map((item) => item.key)).toEqual(["alpha2024", "beta2023"]);
  });

  it("filters by CAS partition and JCR quartile", () => {
    const items = fixtureItems();
    const cas = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      cas: "中科院一区",
    });
    expect(cas.map((item) => item.key)).toEqual(["alpha2024"]);
    const jcr = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      jcr: "q2",
    });
    expect(jcr.map((item) => item.key)).toEqual(["beta2023"]);
  });

  it("filters by IF and JCI ranges", () => {
    const items = fixtureItems();
    const ifFiltered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      ifMin: 5,
      ifMax: 10,
    });
    expect(ifFiltered.map((item) => item.key)).toEqual(["alpha2024"]);
    const jciFiltered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      jciMin: 0.5,
      jciMax: 1.5,
    });
    expect(jciFiltered.map((item) => item.key)).toEqual(["beta2023"]);
  });

  it("filters by reading status", () => {
    const items = fixtureItems();
    const read = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      readingStatus: "read",
    });
    expect(read.map((item) => item.key)).toEqual(["alpha2024"]);
  });

  it("filters by required artifact availability", () => {
    const items = fixtureItems();
    const pdf = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      requiredArtifacts: ["pdf"],
    });
    expect(pdf).toHaveLength(3);
    const figure = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      requiredArtifacts: ["figure"],
    });
    expect(figure.map((item) => item.key)).toEqual(["gamma2022"]);
    const minerU = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      requiredArtifacts: ["minerU", "pdf"],
    });
    // alpha2024 (pdf+minerU) and gamma2022 (pdf+minerU+figure) both qualify;
    // beta2023 has only a PDF.
    expect(minerU.map((item) => item.key)).toEqual(["alpha2024", "gamma2022"]);
  });

  it("combines filters with AND semantics", () => {
    const items = fixtureItems();
    const filtered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      yearFrom: 2022,
      yearTo: 2024,
      journal: "NATURE METHODS",
      cas: "中科院一区",
      jcr: "Q1",
      ifMin: 5,
      ifMax: 10,
      jciMin: 2,
      jciMax: 3,
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU"],
    });
    expect(filtered.map((item) => item.key)).toEqual(["alpha2024"]);
  });

  it("passes everything through when no filter is set", () => {
    const items = fixtureItems();
    expect(applyLibraryFilters(items, EMPTY_LIBRARY_FILTERS)).toHaveLength(3);
  });

  it("excludes invalid rows when filters require metadata they lack", () => {
    const invalid: InvalidRecord[] = [
      {
        path: "05 Literature/broken/broken.md",
        reasons: ["missing_title"],
      },
    ];
    const items = buildLibraryItems([makeRecord()], invalid, buildOptions());
    const all = applyLibraryFilters(items, EMPTY_LIBRARY_FILTERS);
    expect(all).toHaveLength(2);
    const yearFiltered = applyLibraryFilters(items, {
      ...EMPTY_LIBRARY_FILTERS,
      yearFrom: 2024,
      yearTo: 2024,
    });
    expect(yearFiltered.map((item) => item.key)).toEqual(["alpha2024"]);
  });
});

describe("buildPaperDetail", () => {
  it("derives a complete read-only detail model", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    const detail = buildPaperDetail(item);
    expect(detail.title).toBe("Alpha cells in the pancreas");
    expect(detail.key).toBe("alpha2024");
    expect(detail.paperId).toBe(UUID_A);
    expect(detail.invalid).toBeUndefined();
    const field = (label: string) =>
      detail.fields.find((candidate) => candidate.label === label)?.value;
    expect(field("Authors")).toBe("Shiau Wen; Global Consortium");
    expect(field("Year")).toBe("2024");
    expect(field("Journal")).toBe("Nature Methods");
    expect(field("Volume")).toBe("10");
    expect(field("Issue")).toBe("2");
    expect(field("Pages")).toBe("1-9");
    expect(field("ISSN")).toBe("1234-5678");
    expect(field("DOI")).toBe("10.1000/alpha");
    expect(field("PMID")).toBe("12345");
    // Fields deliberately not captured are hidden from the drawer too.
    for (const hidden of ["Type", "Date", "Journal abbreviation", "URL", "Language"]) {
      expect(field(hidden)).toBeUndefined();
    }
    // Batch 2 (A+C): reading status, artifacts, metrics and the abstract
    // are sectioned fields, not flat bibliographic rows.
    expect(field("Reading status")).toBeUndefined();
    expect(field("PDF/MinerU/Figure")).toBeUndefined();
    expect(field("CAS")).toBeUndefined();
    expect(field("Abstract")).toBeUndefined();
    expect(detail.readingStatus).toBe("read");
    expect(detail.artifacts).toEqual({ pdf: true, minerU: true, figure: false });
    expect(detail.metrics).toEqual([
      { label: "CAS", value: "中科院一区" },
      { label: "JCR", value: "Q1" },
      { label: "IF", value: "8.1" },
      { label: "JCI", value: "2.3" },
    ]);
    expect(detail.abstract).toBe("Alpha abstract text.");
  });

  it("omits absent sections from the detail model", () => {
    const [item] = buildLibraryItems(
      [makeRecord({ abstract: "", identifiers: {} })],
      [],
      buildOptions({
        frontmatter: () => undefined,
        listDirectory: () => [],
        metrics: () => undefined,
      }),
    );
    const detail = buildPaperDetail(item);
    expect(detail.readingStatus).toBeUndefined();
    expect(detail.metrics).toEqual([]);
    expect(detail.abstract).toBeUndefined();
    expect(detail.fields.map((f) => f.label)).not.toContain("Abstract");
    expect(detail.artifacts).toEqual({ pdf: false, minerU: false, figure: false });
  });

  it("is read-only: mutating the detail never touches the source item", () => {
    const [item] = buildLibraryItems([makeRecord()], [], buildOptions());
    const detail = buildPaperDetail(item);
    detail.title = "mutated";
    detail.fields[0].value = "mutated";
    const again = buildPaperDetail(item);
    expect(again.title).toBe("Alpha cells in the pancreas");
    expect(item.record!.title).toBe("Alpha cells in the pancreas");
    expect(again.fields[0].value).not.toBe("mutated");
  });

  it("exposes diagnostics for invalid metadata rows", () => {
    const invalid: InvalidRecord[] = [
      {
        path: "05 Literature/broken/broken.md",
        reasons: ["missing_title", "missing_citation_key"],
      },
    ];
    const [item] = buildLibraryItems([], invalid, buildOptions());
    const detail = buildPaperDetail(item);
    expect(detail.title).toBe("Invalid metadata");
    expect(detail.invalid?.reasons).toEqual([
      "missing_title",
      "missing_citation_key",
    ]);
  });

  it("formats mixed structured and literal author lists deterministically", () => {
    expect(
      formatAuthors([
        { family: "Shiau", given: "Wen" },
        { literal: "Global Consortium" },
        { family: "Smith" },
      ]),
    ).toBe("Shiau Wen; Global Consortium; Smith");
    expect(formatAuthors([])).toBe("");
  });
});
