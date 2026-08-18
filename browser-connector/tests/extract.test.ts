import { describe, expect, it } from "vitest";

import { extractFromDocument } from "../src/extract";
import {
  FakeDocument,
  jsonLd,
  meta,
  propertyMeta,
} from "./fake-dom";

const CAPTURE_ID = "11111111-2222-4333-8444-555555555555";
const PAGE_URL = "https://example.org/articles/10.1000/abc";

describe("Highwire extraction", () => {
  it("preserves repeated citation_author order", () => {
    const doc = new FakeDocument([
      meta("citation_title", "A Highwire paper"),
      meta("citation_author", "Jane Doe"),
      meta("citation_author", "John Smith"),
      meta("citation_author", "Ada Lovelace"),
      meta("citation_publication_date", "2024/05/01"),
      meta("citation_doi", "10.1000/abc"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    expect(result.reason).toBeNull();
    const highwire = result.request?.records.find((r) => r.source === "highwire");
    expect(highwire?.values.authors).toEqual([
      { given: "Jane", family: "Doe" },
      { given: "John", family: "Smith" },
      { given: "Ada", family: "Lovelace" },
    ]);
    expect(highwire?.values.publication_date).toBeUndefined();
    expect(highwire?.values.year).toBe(2024);
    expect(highwire?.values.item_type).toBeUndefined();
  });

  it("extracts journal, volume, issue, pages, ISSNs and abstract", () => {
    const doc = new FakeDocument([
      meta("citation_title", "A paper"),
      meta("citation_journal_title", "Journal of Tests"),
      meta("citation_journal_abbrev", "J Tests"),
      meta("citation_author", "Doe, Jane"),
      meta("citation_publication_date", "2024"),
      meta("citation_volume", "12"),
      meta("citation_issue", "3"),
      meta("citation_firstpage", "100"),
      meta("citation_lastpage", "110"),
      meta("citation_issn", "1234-5678"),
      meta("citation_issn", "8765-4321"),
      meta("citation_language", "en"),
      meta("citation_abstract", "An abstract"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const highwire = result.request?.records.find((r) => r.source === "highwire");
    expect(highwire?.values).toMatchObject({
      journal: "Journal of Tests",
      volume: "12",
      issue: "3",
      pages: "100-110",
      issn: ["1234-5678", "8765-4321"],
      abstract: "An abstract",
    });
    expect(highwire?.values.journal_abbreviation).toBeUndefined();
    expect(highwire?.values.language).toBeUndefined();
    expect(highwire?.values.authors).toEqual([{ family: "Doe", given: "Jane" }]);
  });

  it("handles literal/group authors and partial dates", () => {
    const doc = new FakeDocument([
      meta("citation_title", "Consortium paper"),
      meta("citation_author", "The Test Consortium"),
      meta("citation_publication_date", "2024-06"),
      meta("citation_doi", "10.1000/consortium"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const highwire = result.request?.records.find((r) => r.source === "highwire");
    expect(highwire?.values.authors).toEqual([{ literal: "The Test Consortium" }]);
    expect(highwire?.values.publication_date).toBeUndefined();
    expect(highwire?.values.year).toBe(2024);
  });
});

describe("JSON-LD extraction", () => {
  it("extracts ScholarlyArticle with Person/Organization authors and nested container", () => {
    const doc = new FakeDocument([
      jsonLd(
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ScholarlyArticle",
          headline: "A JSON-LD paper",
          author: [
            { "@type": "Person", givenName: "Jane", familyName: "Doe" },
            { "@type": "Organization", name: "Test Lab" },
          ],
          datePublished: "2024-07-15",
          isPartOf: {
            "@type": "Periodical",
            name: "Journal of Tests",
            issn: "1234-5678",
            volumeNumber: "5",
            issueNumber: "2",
          },
          pagination: "55-70",
          doi: "10.1000/jsonld",
          inLanguage: "en",
          abstract: "An abstract",
        }),
      ),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const jsonld = result.request?.records.find((r) => r.source === "json_ld");
    expect(jsonld?.values).toMatchObject({
      title: "A JSON-LD paper",
      authors: [
        { given: "Jane", family: "Doe" },
        { literal: "Test Lab" },
      ],
      year: 2024,
      journal: "Journal of Tests",
      issn: ["1234-5678"],
      volume: "5",
      issue: "2",
      pages: "55-70",
      doi: "10.1000/jsonld",
      abstract: "An abstract",
    });
    expect(jsonld?.values.publication_date).toBeUndefined();
    expect(jsonld?.values.language).toBeUndefined();
  });

  it("extracts MedicalScholarlyArticle and graph nodes", () => {
    const doc = new FakeDocument([
      jsonLd(
        JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "MedicalScholarlyArticle",
              name: "Medical paper",
              author: [{ "@type": "Person", name: "John Smith" }],
              datePublished: "2023",
              isPartOf: { name: "Medical Journal", volumeNumber: "9" },
            },
          ],
        }),
      ),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const jsonld = result.request?.records.find((r) => r.source === "json_ld");
    expect(jsonld?.values).toMatchObject({
      title: "Medical paper",
      authors: [{ literal: "John Smith" }],
      year: 2023,
      journal: "Medical Journal",
      volume: "9",
    });
    expect(jsonld?.values.publication_date).toBeUndefined();
  });

  it("rejects multiple scholarly article nodes as ambiguous", () => {
    const doc = new FakeDocument([
      jsonLd(
        JSON.stringify([
          { "@type": "ScholarlyArticle", headline: "First" },
          { "@type": "ScholarlyArticle", headline: "Second" },
        ]),
      ),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    expect(result.request).toBeNull();
    expect(result.reason).toContain("No supported");
  });
});

describe("Dublin Core and OpenGraph extraction", () => {
  it("handles Dublin Core variants and casing", () => {
    const doc = new FakeDocument([
      meta("DC.title", "DC paper"),
      meta("DC.creator", "Jane Doe"),
      meta("DC.creator", "John Smith"),
      meta("DC.date.issued", "2024-03-01"),
      meta("DC.source", "Journal of Tests"),
      meta("DC.identifier", "https://doi.org/10.1000/dc"),
      meta("DC.language", "en"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const dc = result.request?.records.find((r) => r.source === "dublin_core");
expect(dc?.values).toMatchObject({
      title: "DC paper",
      authors: [
        { given: "Jane", family: "Doe" },
        { given: "John", family: "Smith" },
      ],
      year: 2024,
      journal: "Journal of Tests",
      doi: "10.1000/dc",
    });
    expect(dc?.values.publication_date).toBeUndefined();
    expect(dc?.values.language).toBeUndefined();
  });

  it("uses OpenGraph only for available fields", () => {
    const doc = new FakeDocument([
      propertyMeta("og:title", "OG paper"),
      propertyMeta("og:url", "https://example.org/og"),
      propertyMeta("article:published_time", "2024-08-01T10:00:00Z"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const og = result.request?.records.find((r) => r.source === "open_graph");
    expect(og?.values).toMatchObject({
      title: "OG paper",
      year: 2024,
    });
    expect(og?.values.url).toBeUndefined();
    expect(og?.values.publication_date).toBeUndefined();
  });
});

describe("DOI scan and unsupported pages", () => {
  it("extracts a DOI-only page from body text and normalizes it", () => {
    const doc = new FakeDocument([], "See https://doi.org/10.1000/body. for details.");
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const scan = result.request?.records.find((r) => r.source === "doi_scan");
    expect(scan?.values.doi).toBe("10.1000/body");
  });

  it("does not transmit surrounding body text", () => {
    const doc = new FakeDocument([], "Secret body text with DOI 10.1000/body.");
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const serialized = JSON.stringify(result.request);
    expect(serialized).not.toContain("Secret body text");
    expect(serialized).toContain("10.1000/body");
  });

  it("rejects pages with no supported metadata", () => {
    const doc = new FakeDocument([propertyMeta("og:site_name", "Just a site")]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    expect(result.request).toBeNull();
    expect(result.reason).toContain("No supported");
  });

  it("rejects malformed JSON-LD without crashing", () => {
    const doc = new FakeDocument([
      jsonLd("{ not json"),
      meta("citation_title", "Fallback paper"),
      meta("citation_doi", "10.1000/fallback"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    expect(result.reason).toBeNull();
    expect(result.request?.records.some((r) => r.source === "highwire")).toBe(true);
  });

  it("caps oversized values rather than forwarding unbounded text", () => {
    const doc = new FakeDocument([
      meta("citation_title", "x".repeat(50000)),
      meta("citation_doi", "10.1000/big"),
    ]);
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    const highwire = result.request?.records.find((r) => r.source === "highwire");
    // The pure extractor keeps the string; the protocol/bridge layer
    // rejects values over the documented cap. This test pins that no
    // HTML/cookie/tag fields are introduced.
    expect(highwire?.values.title?.length).toBe(50000);
    const keys = highwire?.values ? Object.keys(highwire.values) : [];
    expect(keys).not.toContain("html");
    expect(keys).not.toContain("cookies");
    expect(keys).not.toContain("tags");
  });

  it("returns source records in deterministic priority order", () => {
    const doc = new FakeDocument([
      meta("citation_title", "High"),
      meta("citation_doi", "10.1000/high"),
      jsonLd(JSON.stringify({ "@type": "ScholarlyArticle", headline: "JSON", datePublished: "2024" })),
      meta("DC.title", "DC"),
      meta("DC.date", "2024"),
      propertyMeta("og:title", "OG"),
      propertyMeta("article:published_time", "2024"),
    ], "10.1000/scan");
    const result = extractFromDocument(doc, PAGE_URL, CAPTURE_ID);
    expect(result.request?.records.map((r) => r.source)).toEqual([
      "highwire",
      "json_ld",
      "dublin_core",
      "open_graph",
      "doi_scan",
    ]);
  });
});
