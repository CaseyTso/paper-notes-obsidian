import { describe, expect, it } from "vitest";

import {
  LibraryIndex,
  SearchCancelledError,
  VaultFileNotFoundError,
  canonicalKeyOf,
} from "../src/services/library-index";
import type { LiteratureVaultAdapter } from "../src/services/library-index";
import { PAPER_SCHEMA_VERSION } from "../src/types/paper";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const ROOT = "05 Literature";

function makeFrontmatter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: PAPER_SCHEMA_VERSION,
    paper_id: UUID_A,
    citation_key: "alpha2024",
    item_type: "article-journal",
    title: "Alpha cells in the pancreas",
    authors: [{ family: "Shiau", given: "Wen" }],
    journal: "Nature Methods",
    publication_date: "2024-01-15",
    year: 2024,
    doi: "10.1000/alpha",
    pmid: "12345",
    abstract: "Alpha abstract text.",
    ...overrides,
  };
}

class FakeVault implements LiteratureVaultAdapter {
  frontmatter = new Map<string, Record<string, unknown> | undefined>();
  contents = new Map<string, string>();
  readCalls: string[] = [];

  readText: (path: string, signal?: AbortSignal) => Promise<string> = (
    path,
    signal,
  ) => {
    this.readCalls.push(path);
    if (!this.contents.has(path)) {
      return Promise.reject(new VaultFileNotFoundError(path));
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SearchCancelledError());
        return;
      }
      signal?.addEventListener("abort", () => reject(new SearchCancelledError()), {
        once: true,
      });
      resolve(this.contents.get(path) as string);
    });
  };

  listMarkdownFiles(): string[] {
    return [...this.frontmatter.keys()];
  }

  getFrontmatter(path: string): Record<string, unknown> | undefined {
    return this.frontmatter.get(path);
  }

  add(path: string, fm?: Record<string, unknown> | undefined): void {
    this.frontmatter.set(path, fm);
  }

  addContent(path: string, content: string): void {
    this.contents.set(path, content);
  }
}

describe("canonicalKeyOf", () => {
  it("accepts only 05 Literature/<key>/<key>.md", () => {
    expect(canonicalKeyOf(ROOT, `${ROOT}/alpha2024/alpha2024.md`)).toBe(
      "alpha2024",
    );
    // Derived notes and sibling files are never canonical.
    expect(
      canonicalKeyOf(ROOT, `${ROOT}/alpha2024/minerUmd_alpha2024.md`),
    ).toBeNull();
    expect(
      canonicalKeyOf(ROOT, `${ROOT}/alpha2024/Figure解读_alpha2024.md`),
    ).toBeNull();
    expect(canonicalKeyOf(ROOT, `${ROOT}/alpha2024/notes.md`)).toBeNull();
    // Files directly under the root or nested deeper are not canonical.
    expect(canonicalKeyOf(ROOT, `${ROOT}/alpha2024.md`)).toBeNull();
    expect(canonicalKeyOf(ROOT, `${ROOT}/a/b/alpha2024.md`)).toBeNull();
    // Outside the root, and prefix look-alikes, are not canonical.
    expect(canonicalKeyOf(ROOT, `01 Inbox/alpha2024/alpha2024.md`)).toBeNull();
    expect(canonicalKeyOf(ROOT, `${ROOT}2/alpha2024/alpha2024.md`)).toBeNull();
  });

  it("tolerates a trailing slash on the root", () => {
    expect(canonicalKeyOf(`${ROOT}/`, `${ROOT}/alpha2024/alpha2024.md`)).toBe(
      "alpha2024",
    );
  });
});

describe("LibraryIndex scan", () => {
  it("indexes only canonical main notes under the literature root", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    vault.add(`${ROOT}/alpha2024/minerUmd_alpha2024.md`, {
      title: "minerUmd_alpha2024",
    });
    vault.add(`${ROOT}/alpha2024/Figure解读_alpha2024.md`, {
      title: "Figure解读_alpha2024",
    });
    vault.add(`${ROOT}/alpha2024/draft.md`, makeFrontmatter());
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta cell signaling",
      }),
    );
    vault.add(`${ROOT}/orphan.md`, makeFrontmatter());
    vault.add(`01 Inbox/gamma/gamma.md`, makeFrontmatter());

    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    expect(
      index
        .getRecords()
        .map((r) => r.path)
        .sort(),
    ).toEqual([`${ROOT}/alpha2024/alpha2024.md`, `${ROOT}/beta2023/beta2023.md`]);
    expect(index.getInvalidRecords()).toEqual([]);
  });

  it("respects a custom literature root", () => {
    const vault = new FakeVault();
    vault.add("Papers/alpha2024/alpha2024.md", makeFrontmatter());
    const index = new LibraryIndex(vault, "Papers");
    index.scanAll();
    expect(index.getRecords()).toHaveLength(1);
    expect(index.getRecords()[0].path).toBe("Papers/alpha2024/alpha2024.md");
  });

  it("indexes title, authors, journal, year, identifiers, key, aliases and abstract", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({
        authors: [
          { family: "Shiau", given: "Wen" },
          { literal: "The Beta Consortium" },
          "Plain String Author",
        ],
        citation_key_aliases: ["old-alpha", "alpha-legacy"],
        aliases: ["Pancreatic alpha atlas"],
        journal: "Nature Methods",
        year: 2024,
        doi: "10.1000/alpha",
        pmid: 12345,
        pmcid: "PMC123456",
        arxiv: "2401.00123",
        abstract: "Alpha abstract text.",
      }),
    );

    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    const record = index.getRecords()[0];
    expect(record.key).toBe("alpha2024");
    expect(record.path).toBe(`${ROOT}/alpha2024/alpha2024.md`);
    expect(record.paperId).toBe(UUID_A);
    expect(record.title).toBe("Alpha cells in the pancreas");
    expect(record.journal).toBe("Nature Methods");
    expect(record.year).toBe(2024);
    expect(record.authors).toEqual([
      { family: "Shiau", given: "Wen" },
      { literal: "The Beta Consortium" },
      { literal: "Plain String Author" },
    ]);
    expect(record.identifiers).toEqual({
      doi: "10.1000/alpha",
      pmid: "12345",
      pmcid: "PMC123456",
      arxiv: "2401.00123",
    });
    expect(record.citationKeyAliases).toEqual(["old-alpha", "alpha-legacy"]);
    expect(record.titleAliases).toEqual(["Pancreatic alpha atlas"]);
    expect(record.abstract).toBe("Alpha abstract text.");
  });

  it("normalizes string years and tolerates missing optional fields", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
        year: "2023",
        journal: "",
        abstract: "",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    const record = index.getRecords()[0];
    expect(record.year).toBe(2023);
    expect(record.journal).toBeUndefined();
    expect(record.abstract).toBeUndefined();
    expect(record.identifiers).toEqual({ doi: "10.1000/alpha", pmid: "12345" });
  });

  it("rescan replaces previous state instead of accumulating", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
      }),
    );
    index.scanAll();
    expect(index.getRecords()).toHaveLength(2);
  });

  it("reads the full canonical bibliography fields", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/full2024/full2024.md`,
      makeFrontmatter({
        citation_key: "full2024",
        item_type: "preprint",
        journal_abbreviation: "J Tests",
        publication_date: "2024-05-01",
        volume: "12",
        issue: "3",
        pages: "100-110",
        url: "https://doi.org/10.1000/full",
        issn: ["1234-5678", "8765-4321"],
        language: "en",
        arxiv: "2401.00001",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    const record = index.getRecords()[0];
    expect(record.itemType).toBe("preprint");
    expect(record.journalAbbreviation).toBe("J Tests");
    expect(record.publicationDate).toBe("2024-05-01");
    expect(record.volume).toBe("12");
    expect(record.issue).toBe("3");
    expect(record.pages).toBe("100-110");
    expect(record.url).toBe("https://doi.org/10.1000/full");
    expect(record.issn).toEqual(["1234-5678", "8765-4321"]);
    expect(record.language).toBe("en");
    expect(record.identifiers.arxiv).toBe("2401.00001");
  });

  it("cleans inline HTML tags and entities from titles for display", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/sup2024/sup2024.md`,
      makeFrontmatter({
        citation_key: "sup2024",
        title: "P16<sup>+</sup> Cells Drive Adverse Remodeling",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    const record = index.getRecords()[0];
    expect(record.title).toBe("P16+ Cells Drive Adverse Remodeling");
    // The stored frontmatter is never modified.
    expect(vault.frontmatter.get(`${ROOT}/sup2024/sup2024.md`)?.title).toBe(
      "P16<sup>+</sup> Cells Drive Adverse Remodeling",
    );
  });
});

describe("invalid records", () => {
  function indexWith(
    path: string,
    fm: Record<string, unknown> | undefined,
  ): LibraryIndex {
    const vault = new FakeVault();
    vault.add(path, fm);
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    return index;
  }

  it("keeps notes without frontmatter in the invalid collection", () => {
    const index = indexWith(`${ROOT}/alpha2024/alpha2024.md`, undefined);
    expect(index.getRecords()).toHaveLength(0);
    expect(index.getInvalidRecords()).toEqual([
      {
        path: `${ROOT}/alpha2024/alpha2024.md`,
        reasons: ["missing_frontmatter"],
      },
    ]);
  });

  it("rejects unsupported and missing schema versions", () => {
    const unsupported = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ schema_version: 2 }),
    );
    expect(unsupported.getInvalidRecords()[0].reasons).toEqual([
      "unsupported_schema",
    ]);
    const missing = indexWith(`${ROOT}/beta2023/beta2023.md`, {
      paper_id: UUID_A,
      citation_key: "beta2023",
      title: "Beta",
    });
    expect(missing.getInvalidRecords()[0].reasons).toEqual([
      "unsupported_schema",
    ]);
  });

  it("rejects missing citation keys and key-path mismatches", () => {
    const missing = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ citation_key: "" }),
    );
    expect(missing.getInvalidRecords()[0].reasons).toEqual([
      "missing_citation_key",
    ]);
    const mismatch = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ citation_key: "someOtherKey" }),
    );
    expect(mismatch.getInvalidRecords()[0].reasons).toEqual([
      "key_path_mismatch",
    ]);
  });

  it("rejects missing and non-UUID paper ids", () => {
    const missing = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ paper_id: "" }),
    );
    expect(missing.getInvalidRecords()[0].reasons).toEqual([
      "missing_paper_id",
    ]);
    const bad = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ paper_id: "not-a-uuid" }),
    );
    expect(bad.getInvalidRecords()[0].reasons).toEqual(["invalid_paper_id"]);
  });

  it("rejects missing titles", () => {
    const index = indexWith(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ title: "" }),
    );
    expect(index.getInvalidRecords()[0].reasons).toEqual(["missing_title"]);
  });

  it("accumulates all identity/schema problems as field-level reasons", () => {
    const index = indexWith(`${ROOT}/alpha2024/alpha2024.md`, {});
    expect(index.getInvalidRecords()[0].reasons.sort()).toEqual([
      "missing_citation_key",
      "missing_paper_id",
      "missing_title",
      "unsupported_schema",
    ]);
  });

  it("keeps valid notes indexed while siblings are invalid", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    vault.add(`${ROOT}/beta2023/beta2023.md`, undefined);
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    expect(index.getRecords()).toHaveLength(1);
    expect(index.getInvalidRecords()).toHaveLength(1);
  });
});

describe("incremental vault events", () => {
  it("indexes a newly created canonical note", () => {
    const vault = new FakeVault();
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    expect(index.getRecords()).toHaveLength(0);

    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    index.handleVaultEvent("create", `${ROOT}/alpha2024/alpha2024.md`);

    expect(index.getRecords()).toHaveLength(1);
    expect(index.getRecordByKey("alpha2024")?.title).toBe(
      "Alpha cells in the pancreas",
    );
  });

  it("ignores creation of non-canonical files", () => {
    const vault = new FakeVault();
    const index = new LibraryIndex(vault, ROOT);
    vault.add(`${ROOT}/alpha2024/minerUmd_alpha2024.md`, { title: "x" });
    index.handleVaultEvent("create", `${ROOT}/alpha2024/minerUmd_alpha2024.md`);
    expect(index.getRecords()).toHaveLength(0);
    expect(index.getInvalidRecords()).toHaveLength(0);
  });

  it("updates the record on modify", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ title: "Renamed title" }),
    );
    index.handleVaultEvent("modify", `${ROOT}/alpha2024/alpha2024.md`);

    expect(index.getRecordByKey("alpha2024")?.title).toBe("Renamed title");
  });

  it("drops the record on delete", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    index.handleVaultEvent("delete", `${ROOT}/alpha2024/alpha2024.md`);

    expect(index.getRecords()).toHaveLength(0);
  });

  it("re-indexes renamed canonical notes under their new key", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    vault.add(
      `${ROOT}/beta2024/beta2024.md`,
      makeFrontmatter({ citation_key: "beta2024" }),
    );
    index.handleVaultEvent(
      "rename",
      `${ROOT}/beta2024/beta2024.md`,
      `${ROOT}/alpha2024/alpha2024.md`,
    );

    expect(index.getRecords()).toHaveLength(1);
    expect(index.getRecordByKey("beta2024")).toBeDefined();
    expect(index.getRecordByKey("alpha2024")).toBeUndefined();
  });

  it("removes the record when a canonical note is renamed away from the root", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    vault.add(`01 Inbox/alpha2024.md`, makeFrontmatter());
    index.handleVaultEvent(
      "rename",
      `01 Inbox/alpha2024.md`,
      `${ROOT}/alpha2024/alpha2024.md`,
    );

    expect(index.getRecords()).toHaveLength(0);
  });

  it("moves a note between the invalid and valid collections", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, { title: "no schema" });
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    expect(index.getInvalidRecords()).toHaveLength(1);

    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    index.handleVaultEvent("modify", `${ROOT}/alpha2024/alpha2024.md`);
    expect(index.getInvalidRecords()).toHaveLength(0);
    expect(index.getRecords()).toHaveLength(1);

    vault.add(`${ROOT}/alpha2024/alpha2024.md`, undefined);
    index.handleVaultEvent("modify", `${ROOT}/alpha2024/alpha2024.md`);
    expect(index.getRecords()).toHaveLength(0);
    expect(index.getInvalidRecords()).toHaveLength(1);
  });
});

describe("identity conflicts force a read-only error state", () => {
  function paperAt(
    key: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return makeFrontmatter({ citation_key: key, ...overrides });
  }

  function twoPapers(
    aFm: Record<string, unknown>,
    bFm: Record<string, unknown>,
  ): LibraryIndex {
    const vault = new FakeVault();
    vault.add(`${ROOT}/a/a.md`, aFm);
    vault.add(`${ROOT}/b/b.md`, bFm);
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    return index;
  }

  it("flags duplicate paper UUIDs", () => {
    const index = twoPapers(paperAt("a"), paperAt("b"));
    expect(index.isReadOnly()).toBe(true);
    expect(index.getReadOnlyError()).toEqual({
      kind: "duplicate_uuid",
      value: UUID_A,
      paths: [`${ROOT}/a/a.md`, `${ROOT}/b/b.md`],
    });
  });

  it("flags duplicate citation aliases", () => {
    const index = twoPapers(
      paperAt("a", { citation_key_aliases: ["old-key"] }),
      paperAt("b", { paper_id: UUID_B, citation_key_aliases: ["old-key"] }),
    );
    expect(index.getReadOnlyError()).toEqual({
      kind: "duplicate_alias",
      value: "old-key",
      paths: [`${ROOT}/a/a.md`, `${ROOT}/b/b.md`],
    });
  });

  it("flags an alias colliding with another record's current key, key declared first", () => {
    const index = twoPapers(
      paperAt("a"),
      paperAt("b", { paper_id: UUID_B, citation_key_aliases: ["a"] }),
    );
    expect(index.getReadOnlyError()).toEqual({
      kind: "duplicate_alias",
      value: "a",
      paths: [`${ROOT}/a/a.md`, `${ROOT}/b/b.md`],
    });
  });

  it("flags an alias colliding with another record's current key, alias declared first", () => {
    const index = twoPapers(
      paperAt("a", { citation_key_aliases: ["b"] }),
      paperAt("b", { paper_id: UUID_B }),
    );
    expect(index.getReadOnlyError()).toEqual({
      kind: "duplicate_alias",
      value: "b",
      paths: [`${ROOT}/b/b.md`, `${ROOT}/a/a.md`],
    });
  });

  it("flags duplicate citation keys declared by a mismatched note", () => {
    const index = twoPapers(paperAt("a"), makeFrontmatter({ citation_key: "a" }));
    // b/b.md declares the citation key "a" at a different path: it is
    // invalid (key_path_mismatch) but its declared identity still collides
    // with the current key of a/a.md.
    expect(index.getReadOnlyError()).toEqual({
      kind: "duplicate_key",
      value: "a",
      paths: [`${ROOT}/a/a.md`, `${ROOT}/b/b.md`],
    });
    expect(index.getInvalidRecords().map((r) => r.path)).toEqual([
      `${ROOT}/b/b.md`,
    ]);
  });

  it("does not treat a note aliasing its own key as a conflict", () => {
    const index = twoPapers(
      paperAt("a", { citation_key_aliases: ["a"] }),
      paperAt("b", { paper_id: UUID_B }),
    );
    expect(index.isReadOnly()).toBe(false);
    expect(index.getReadOnlyError()).toBeNull();
  });

  it("keeps a healthy library free of the read-only error state", () => {
    const index = twoPapers(paperAt("a"), paperAt("b", { paper_id: UUID_B }));
    expect(index.isReadOnly()).toBe(false);
  });

  it("clears the read-only error state when the conflicting note is deleted", () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/a/a.md`, paperAt("a"));
    vault.add(`${ROOT}/b/b.md`, paperAt("b"));
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    expect(index.isReadOnly()).toBe(true);

    index.handleVaultEvent("delete", `${ROOT}/b/b.md`);

    expect(index.isReadOnly()).toBe(false);
    expect(index.getReadOnlyError()).toBeNull();
    expect(index.getRecords()).toHaveLength(1);
  });
});

describe("metrics are never read from paper YAML", () => {
  it("keeps the note valid and exposes no metric fields", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({
        impact_factor: 12.3,
        jcr_quartile: "Q1",
        cas_partition: "1",
        jci: 2.5,
        easyscholar_cache: { sciif: "10", sciif5: "9" },
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    expect(index.getRecords()).toHaveLength(1);
    const serialized = JSON.stringify(index.getRecords()[0]);
    expect(serialized).not.toContain("impact_factor");
    expect(serialized).not.toContain("jcr_quartile");
    expect(serialized).not.toContain("cas_partition");
    expect(serialized).not.toContain("easyscholar_cache");
    expect(serialized).not.toContain("jci");
  });
});

describe("search", () => {
  function twoPaperIndex(): {
    vault: FakeVault;
    index: LibraryIndex;
  } {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({
        citation_key_aliases: ["old-alpha"],
        aliases: ["Pancreatic alpha atlas"],
      }),
    );
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta cell signaling",
        authors: [{ family: "Zhang", given: "Li" }],
        journal: "Cell Reports",
        year: 2023,
        doi: "10.1001/beta",
        pmid: "67890",
        abstract: "Beta abstract text.",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    return { vault, index };
  }

  it("matches title, authors, journal, year, identifiers, key, aliases and abstract", () => {
    const { index } = twoPaperIndex();
    expect(index.search("Alpha cells")).toHaveLength(1);
    expect(index.search("shiau")).toHaveLength(1);
    expect(index.search("Wen")).toHaveLength(1);
    expect(index.search("nature methods")).toHaveLength(1);
    expect(index.search("2024")).toHaveLength(1);
    expect(index.search("2023")).toHaveLength(1);
    expect(index.search("10.1000/alpha")).toHaveLength(1);
    expect(index.search("12345")).toHaveLength(1);
    expect(index.search("10.1001/beta")).toHaveLength(1);
    expect(index.search("beta2023")).toHaveLength(1);
    expect(index.search("old-alpha")).toHaveLength(1);
    expect(index.search("Pancreatic alpha atlas")).toHaveLength(1);
    expect(index.search("abstract")).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    const { index } = twoPaperIndex();
    expect(index.search("ALPHA CELLS")).toHaveLength(1);
    expect(index.search("ZHANG")).toHaveLength(1);
  });

  it("matches multi-word queries by token AND when tokens are scattered", () => {
    const { index } = twoPaperIndex();
    // "alpha" (title/abstract) and "text" (abstract) never appear contiguously.
    expect(index.search("alpha text").map((r) => r.key)).toEqual(["alpha2024"]);
    // "signaling" (title) and "reports" (journal) are scattered within beta2023.
    expect(index.search("signaling reports").map((r) => r.key)).toEqual([
      "beta2023",
    ]);
  });

  it("does not match multi-word queries that miss any token", () => {
    const { index } = twoPaperIndex();
    expect(index.search("alpha missing")).toHaveLength(0);
    expect(index.search("missing reports")).toHaveLength(0);
  });

  it("ignores consecutive-space empty tokens and keeps single-token behavior", () => {
    const { index } = twoPaperIndex();
    expect(index.search("alpha   text").map((r) => r.key)).toEqual([
      "alpha2024",
    ]);
    expect(index.search("  alpha  ").map((r) => r.key)).toEqual(["alpha2024"]);
    expect(index.search("signaling").map((r) => r.key)).toEqual(["beta2023"]);
  });

  it("keeps multi-word matching case-insensitive", () => {
    const { index } = twoPaperIndex();
    expect(index.search("ALPHA TEXT").map((r) => r.key)).toEqual(["alpha2024"]);
    expect(index.search("SIGNALING Reports").map((r) => r.key)).toEqual([
      "beta2023",
    ]);
  });

  it("matches hyphenated and plural variants through per-token substrings (Gate D)", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/gamma2022/gamma2022.md`,
      makeFrontmatter({
        citation_key: "gamma2022",
        paper_id: "9f9d0d1a-2a2b-3c3c-4d4d-5e5e5e5e5e5e",
        title: "Gene-expression programs define tumor states",
        abstract: "Programs of gene expression control cell identity.",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();
    // The contiguous phrase "gene expression program" never occurs (the
    // title is hyphenated, the abstract separates "programs" and
    // "expression"), but every token does -> Gate D case hits.
    expect(index.search("gene expression program").map((r) => r.key)).toEqual([
      "gamma2022",
    ]);
  });

  it("returns all records for an empty query in scan order", () => {
    const { index } = twoPaperIndex();
    expect(index.search("").map((r) => r.key)).toEqual([
      "alpha2024",
      "beta2023",
    ]);
    expect(index.search("   ")).toHaveLength(2);
  });

  it("returns copies so callers cannot mutate the index", () => {
    const { index } = twoPaperIndex();
    const [record] = index.search("alpha");
    record.title = "HACKED";
    record.authors.length = 0;
    expect(index.getRecordByKey("alpha2024")?.title).toBe(
      "Alpha cells in the pancreas",
    );
    expect(index.getRecordByKey("alpha2024")?.authors).toHaveLength(1);
  });

  it("never reads MinerU full text for default searches", () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "secret needle buried in MinerU prose",
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    expect(index.search("needle")).toHaveLength(0);
    expect(vault.readCalls).toHaveLength(0);
  });
});

describe("explicit full-text search", () => {
  it("reads MinerU on demand and matches its content", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
        abstract: "",
      }),
    );
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "The Needle hides in MinerU prose here.",
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    const results = await index.searchFullText("needle");
    expect(results.map((r) => r.key)).toEqual(["alpha2024"]);
    expect(vault.readCalls).toEqual([
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      `${ROOT}/beta2023/minerUmd_beta2023.md`,
    ]);
  });

  it("matches multi-word queries in MinerU content by token AND", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
        abstract: "",
      }),
    );
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "Gene-expression programs in the tumor microenvironment.",
    );
    vault.addContent(
      `${ROOT}/beta2023/minerUmd_beta2023.md`,
      "No matching content here.",
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    // "gene expression program" never appears contiguously in the MinerU
    // prose (hyphenated "gene-expression", plural "programs"), but every
    // token does -> token AND hits.
    const results = await index.searchFullText("gene expression program");
    expect(results.map((r) => r.key)).toEqual(["alpha2024"]);
  });

  it("does not match full-text multi-word queries missing any token", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "Gene-expression programs in the tumor microenvironment.",
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    await expect(
      index.searchFullText("gene expression missing"),
    ).resolves.toEqual([]);
    expect(vault.readCalls).toEqual([
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
    ]);
  });

  it("skips MinerU reads for records already matched by default fields", async () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "alpha",
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    const results = await index.searchFullText("alpha");
    expect(results.map((r) => r.key)).toEqual(["alpha2024"]);
    expect(vault.readCalls).toHaveLength(0);
  });

  it("tolerates missing MinerU files", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    await expect(index.searchFullText("needle")).resolves.toEqual([]);
    expect(vault.readCalls).toEqual([`${ROOT}/alpha2024/minerUmd_alpha2024.md`]);
  });

  it("returns all records for an empty query without reading MinerU", async () => {
    const vault = new FakeVault();
    vault.add(`${ROOT}/alpha2024/alpha2024.md`, makeFrontmatter());
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
      }),
    );
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    await expect(index.searchFullText("")).resolves.toHaveLength(2);
    expect(vault.readCalls).toHaveLength(0);
  });

  it("rejects immediately when aborted before reading", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.addContent(`${ROOT}/alpha2024/minerUmd_alpha2024.md`, "needle");
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    const controller = new AbortController();
    controller.abort();
    await expect(
      index.searchFullText("needle", { signal: controller.signal }),
    ).rejects.toThrow(SearchCancelledError);
    expect(vault.readCalls).toHaveLength(0);
  });

  it("stops reading further MinerU files once aborted mid-search", async () => {
    const vault = new FakeVault();
    vault.add(
      `${ROOT}/alpha2024/alpha2024.md`,
      makeFrontmatter({ abstract: "" }),
    );
    vault.add(
      `${ROOT}/beta2023/beta2023.md`,
      makeFrontmatter({
        citation_key: "beta2023",
        paper_id: UUID_B,
        title: "Beta",
        abstract: "",
      }),
    );
    vault.addContent(
      `${ROOT}/alpha2024/minerUmd_alpha2024.md`,
      "needle one",
    );
    vault.addContent(`${ROOT}/beta2023/minerUmd_beta2023.md`, "needle two");
    vault.readText = (path, signal) => {
      vault.readCalls.push(path);
      if (!vault.contents.has(path)) {
        return Promise.reject(new VaultFileNotFoundError(path));
      }
      // The first read never settles; the test aborts while it is in flight.
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new SearchCancelledError());
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new SearchCancelledError()),
          { once: true },
        );
      });
    };
    const index = new LibraryIndex(vault, ROOT);
    index.scanAll();

    const controller = new AbortController();
    const promise = index.searchFullText("needle", {
      signal: controller.signal,
    });
    // The first MinerU read has already started synchronously.
    expect(vault.readCalls).toHaveLength(1);

    controller.abort();
    await expect(promise).rejects.toThrow(SearchCancelledError);
    expect(vault.readCalls).toHaveLength(1);
  });
});
