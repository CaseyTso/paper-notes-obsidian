/**
 * Standards-based extraction from one current journal-article/preprint
 * page.
 *
 * The extractor is pure DOM → WebCaptureRequest. It reads only
 * allowlisted bibliographic evidence:
 * - Highwire `citation_*` meta tags,
 * - JSON-LD `ScholarlyArticle` / `MedicalScholarlyArticle`,
 * - Dublin Core meta tags,
 * - OpenGraph article metadata,
 * - a DOI scan of the page (only the identifier is transmitted).
 *
 * It never reads cookies, raw HTML, body text, website tags/keywords,
 * PDFs, paths, or arbitrary page data.
 */

import {
  WEB_CAPTURE_SCHEMA_VERSION,
  type CapturedAuthor,
  type CapturedBibliography,
  type WebCaptureRequest,
  type WebCaptureSource,
} from "./protocol";

/** Minimal DOM surface used by the pure extractor (testable in Node). */
export interface MinimalElement {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export interface MinimalDocument {
  querySelectorAll(selectors: string): Iterable<MinimalElement>;
  querySelector(selectors: string): MinimalElement | null;
  body?: { innerText?: string };
}

export interface ExtractionResult {
  request: WebCaptureRequest | null;
  reason: string | null;
}

const HIGHWIRE_SELECTOR = 'meta[name^="citation_"]';
const DC_SELECTOR = 'meta[name^="DC."], meta[name^="dc."], meta[property^="DC."]';
const OG_SELECTOR = 'meta[property^="og:"], meta[property^="article:"]';
const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';

const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"']+/g;

function metaContent(doc: MinimalDocument, selector: string): string[] {
  const values: string[] = [];
  for (const element of doc.querySelectorAll(selector)) {
    const content = element.getAttribute("content");
    if (content !== null && content.trim().length > 0) {
      values.push(content.trim());
    }
  }
  return values;
}

function metaNameValue(doc: MinimalDocument, names: string[]): string[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const out: string[] = [];
  for (const element of doc.querySelectorAll("meta")) {
    const name = (element.getAttribute("name") ?? element.getAttribute("property") ?? "").toLowerCase();
    if (wanted.has(name)) {
      const content = element.getAttribute("content");
      if (content !== null && content.trim().length > 0) {
        out.push(content.trim());
      }
    }
  }
  return out;
}

function normalizeDate(value: string): string | null {
  const text = value.trim().replace(/\s+/g, "");
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  const match = iso ?? text.match(/^(\d{4})(?:[/-](\d{1,2})(?:[/-](\d{1,2}))?)?$/);
  if (!match) {
    return null;
  }
  const year = match[1];
  const month = match[2] ? match[2].padStart(2, "0") : undefined;
  const day = match[3] ? match[3].padStart(2, "0") : undefined;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) {
    return null;
  }
  if (day !== undefined && (Number(day) < 1 || Number(day) > 31)) {
    return null;
  }
  return day !== undefined ? `${year}-${month}-${day}` : month !== undefined ? `${year}-${month}` : year;
}

const GROUP_AUTHOR_HINTS =
  /\b(the|consortium|group|team|collaboration|committee|study|network|initiative|project|working\s+group)\b/i;

function parseAuthorName(value: string): CapturedAuthor {
  const text = value.trim();
  if (text.length === 0) {
    return { literal: text };
  }
  if (text.includes(",")) {
    const [familyPart, givenPart] = text.split(",", 2);
    const family = familyPart.trim();
    const given = (givenPart ?? "").trim();
    if (family.length > 0) {
      return given.length > 0 ? { family, given } : { family };
    }
  }
  const parts = text.split(/\s+/);
  if (parts.length === 1) {
    return { literal: text };
  }
  // Group/consortium authors are literal names, not split into
  // given/family. Heuristic: an explicit group hint or a very long
  // name without a comma is treated as a literal.
  if (parts.length > 4 || GROUP_AUTHOR_HINTS.test(text)) {
    return { literal: text };
  }
  const family = parts[parts.length - 1];
  const given = parts.slice(0, -1).join(" ");
  return { family, given };
}

function normalizeIssn(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toUpperCase();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function extractHighwire(doc: MinimalDocument): CapturedBibliography | null {
  const all = Array.from(doc.querySelectorAll(HIGHWIRE_SELECTOR));
  if (all.length === 0) {
    return null;
  }
  const values: CapturedBibliography = {};
  const titleValues = metaContent(doc, 'meta[name="citation_title"]');
  if (titleValues.length > 1) {
    // Multiple distinct article titles on one page: ambiguous.
    return null;
  }
  if (titleValues.length === 1) {
    values.title = titleValues[0];
  }
  const authors = metaContent(doc, 'meta[name="citation_author"]');
  if (authors.length > 0) {
    values.authors = authors.map(parseAuthorName);
  }
  const journalValues = metaContent(doc, 'meta[name="citation_journal_title"]');
  if (journalValues.length > 0) {
    values.journal = journalValues[0];
  }
  const dateValues = metaContent(doc, 'meta[name="citation_publication_date"]');
  const date = dateValues.length > 0 ? normalizeDate(dateValues[0]) : null;
  if (date !== null) {
    values.year = Number(date.slice(0, 4));
  } else {
    const yearValues = metaContent(doc, 'meta[name="citation_date"]');
    if (yearValues.length > 0) {
      const normalized = normalizeDate(yearValues[0]);
      if (normalized !== null) {
        values.year = Number(normalized.slice(0, 4));
      }
    }
  }
  const volume = metaContent(doc, 'meta[name="citation_volume"]');
  if (volume.length > 0) {
    values.volume = volume[0];
  }
  const issue = metaContent(doc, 'meta[name="citation_issue"]');
  if (issue.length > 0) {
    values.issue = issue[0];
  }
  const first = metaContent(doc, 'meta[name="citation_firstpage"]');
  const last = metaContent(doc, 'meta[name="citation_lastpage"]');
  if (first.length > 0 && last.length > 0) {
    values.pages = `${first[0]}-${last[0]}`;
  } else if (first.length > 0) {
    values.pages = first[0];
  }
  const doi = metaContent(doc, 'meta[name="citation_doi"]');
  if (doi.length > 0) {
    values.doi = doi[0];
  }
  const pmid = metaContent(doc, 'meta[name="citation_pmid"]');
  if (pmid.length > 0) {
    values.pmid = pmid[0];
  }
  const pmcid = metaContent(doc, 'meta[name="citation_pmcid"]');
  if (pmcid.length > 0) {
    values.pmcid = pmcid[0];
  }
  const arxiv = metaContent(doc, 'meta[name="citation_arxiv_id"]');
  if (arxiv.length > 0) {
    values.arxiv = arxiv[0];
  }
  const issn = normalizeIssn(metaContent(doc, 'meta[name="citation_issn"]'));
  if (issn.length > 0) {
    values.issn = issn;
  }
  const abstract = metaContent(doc, 'meta[name="citation_abstract"]');
  if (abstract.length > 0) {
    values.abstract = abstract[0];
  }
  return Object.keys(values).length > 1 ? values : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isArticleNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some(
    (t) =>
      t === "ScholarlyArticle" ||
      t === "MedicalScholarlyArticle" ||
      t === "Article",
  );
}

function identifierFromJsonLd(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        return item;
      }
      const record = asRecord(item);
      if (record && typeof record["@id"] === "string") {
        return record["@id"];
      }
      if (record && typeof record.value === "string") {
        return record.value;
      }
    }
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["@id"] === "string") {
      return record["@id"];
    }
    if (typeof record.value === "string") {
      return record.value;
    }
  }
  return undefined;
}

function extractJsonLd(doc: MinimalDocument): CapturedBibliography | null {
  const scripts = Array.from(doc.querySelectorAll(JSON_LD_SELECTOR));
  if (scripts.length === 0) {
    return null;
  }
  const articles: Array<Record<string, unknown>> = [];
  for (const script of scripts) {
    const raw = script.textContent ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else {
      const record = asRecord(parsed);
      if (record) {
        if (Array.isArray(record["@graph"])) {
          candidates.push(...(record["@graph"] as unknown[]));
        } else {
          candidates.push(record);
        }
      }
    }
    for (const candidate of candidates) {
      const record = asRecord(candidate);
      if (record && isArticleNode(record)) {
        articles.push(record);
      }
    }
  }
  if (articles.length === 0) {
    return null;
  }
  if (articles.length > 1) {
    // Search-result / multi-item pages are ambiguous for V1.
    return null;
  }
  const node = articles[0];
  const values: CapturedBibliography = {};
  const title =
    typeof node.headline === "string"
      ? node.headline
      : typeof node.name === "string"
        ? node.name
        : typeof node.title === "string"
          ? node.title
          : undefined;
  if (title !== undefined && title.trim().length > 0) {
    values.title = title.trim();
  }
  const authorValue = node.author;
  if (authorValue !== undefined) {
    const authors: CapturedAuthor[] = [];
    const list = Array.isArray(authorValue) ? authorValue : [authorValue];
    for (const item of list) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }
      const name =
        typeof record.name === "string"
          ? record.name
          : undefined;
      const family =
        typeof record.familyName === "string"
          ? record.familyName
          : undefined;
      const given =
        typeof record.givenName === "string"
          ? record.givenName
          : undefined;
      if (family !== undefined || given !== undefined) {
        const author: CapturedAuthor = {};
        if (family !== undefined) {
          author.family = family;
        }
        if (given !== undefined) {
          author.given = given;
        }
        authors.push(author);
      } else if (name !== undefined && name.trim().length > 0) {
        authors.push({ literal: name.trim() });
      }
    }
    if (authors.length > 0) {
      values.authors = authors;
    }
  }
  const partOf = asRecord(node.isPartOf);
  if (partOf) {
    if (typeof partOf.name === "string" && partOf.name.trim().length > 0) {
      values.journal = partOf.name.trim();
    }
    const issn = partOf.issn;
    if (issn !== undefined) {
      const issnList = Array.isArray(issn) ? issn : [issn];
      const normalized = normalizeIssn(
        issnList.filter((item): item is string => typeof item === "string"),
      );
      if (normalized.length > 0) {
        values.issn = normalized;
      }
    }
    if (typeof partOf.volumeNumber === "string" && partOf.volumeNumber.trim().length > 0) {
      values.volume = partOf.volumeNumber.trim();
    }
    if (typeof partOf.issueNumber === "string" && partOf.issueNumber.trim().length > 0) {
      values.issue = partOf.issueNumber.trim();
    }
  }
  if (values.volume === undefined && typeof node.volumeNumber === "string") {
    values.volume = node.volumeNumber;
  }
  if (values.issue === undefined && typeof node.issueNumber === "string") {
    values.issue = node.issueNumber;
  }
  if (typeof node.pagination === "string" && node.pagination.trim().length > 0) {
    values.pages = node.pagination.trim();
  } else if (
    typeof node.pageStart === "string" &&
    typeof node.pageEnd === "string"
  ) {
    values.pages = `${node.pageStart}-${node.pageEnd}`;
  } else if (typeof node.pageStart === "string") {
    values.pages = node.pageStart;
  }
  const dateValue = typeof node.datePublished === "string" ? node.datePublished : undefined;
  const normalizedDate = dateValue !== undefined ? normalizeDate(dateValue) : null;
  if (normalizedDate !== null) {
    values.year = Number(normalizedDate.slice(0, 4));
  }
  const doi = identifierFromJsonLd(node, "doi") ?? identifierFromJsonLd(node, "identifier");
  if (doi !== undefined && doi.trim().length > 0) {
    values.doi = doi.trim();
  }
  const abstractValue = node.abstract;
  if (typeof abstractValue === "string" && abstractValue.trim().length > 0) {
    values.abstract = abstractValue.trim();
  } else if (
    Array.isArray(abstractValue) &&
    abstractValue.length > 0 &&
    typeof abstractValue[0] === "string"
  ) {
    values.abstract = (abstractValue[0] as string).trim();
  }
  return Object.keys(values).length > 1 ? values : null;
}

function extractDublinCore(doc: MinimalDocument): CapturedBibliography | null {
  const elements = Array.from(doc.querySelectorAll(DC_SELECTOR));
  if (elements.length === 0) {
    return null;
  }
  const values: CapturedBibliography = {};
  const titles = metaNameValue(doc, ["DC.title", "dc.title"]);
  if (titles.length > 0) {
    values.title = titles[0];
  }
  const creators = metaNameValue(doc, ["DC.creator", "dc.creator"]);
  if (creators.length > 0) {
    values.authors = creators.map(parseAuthorName);
  }
  const dates = metaNameValue(doc, ["DC.date", "dc.date", "DC.date.issued", "dc.date.issued"]);
  if (dates.length > 0) {
    const date = normalizeDate(dates[0]);
    if (date !== null) {
      values.year = Number(date.slice(0, 4));
    }
  }
  const sources = metaNameValue(doc, ["DC.source", "dc.source"]);
  if (sources.length > 0) {
    values.journal = sources[0];
  }
  const identifiers = metaNameValue(doc, ["DC.identifier", "dc.identifier"]);
  for (const identifier of identifiers) {
    const doiMatch = identifier.match(DOI_RE);
    if (doiMatch !== null) {
      values.doi = doiMatch[0];
      break;
    }
  }
  return Object.keys(values).length > 1 ? values : null;
}

function extractOpenGraph(doc: MinimalDocument): CapturedBibliography | null {
  const elements = Array.from(doc.querySelectorAll(OG_SELECTOR));
  if (elements.length === 0) {
    return null;
  }
  const values: CapturedBibliography = {};
  const titles = metaNameValue(doc, ["og:title"]);
  if (titles.length > 0) {
    values.title = titles[0];
  }
  const published = metaNameValue(doc, ["article:published_time"]);
  if (published.length > 0) {
    const date = normalizeDate(published[0]);
    if (date !== null) {
      values.year = Number(date.slice(0, 4));
    }
  }
  if (Object.keys(values).length === 0) {
    return null;
  }
  return values;
}

function extractDoiScan(doc: MinimalDocument): CapturedBibliography | null {
  const candidates: string[] = [];
  for (const element of doc.querySelectorAll("meta")) {
    for (const attr of ["content", "name", "property"]) {
      const value = element.getAttribute(attr);
      if (value !== null) {
        const matches = value.match(DOI_RE);
        if (matches !== null) {
          candidates.push(...matches);
        }
      }
    }
  }
  if (doc.body?.innerText) {
    const matches = doc.body.innerText.match(DOI_RE);
    if (matches !== null) {
      candidates.push(...matches);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const values: CapturedBibliography = {};
  for (const candidate of candidates) {
    const normalized = candidate.replace(/[.,;:!?]+$/, "").toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      values.doi = normalized;
      break;
    }
  }
  return Object.keys(values).length > 0 ? values : null;
}

function recordFor(source: WebCaptureSource, values: CapturedBibliography | null) {
  return values === null ? null : { source, values };
}

/**
 * Extract one Web Capture from a supported single paper page.
 *
 * Returns `{ request, reason }`; when the page is unsupported/ambiguous
 * the request is `null` and `reason` explains concisely.
 */
export function extractFromDocument(
  doc: MinimalDocument,
  pageUrl: string,
  captureId: string,
): ExtractionResult {
  const records: Array<{ source: WebCaptureSource; values: CapturedBibliography }> = [];

  const highwire = recordFor("highwire", extractHighwire(doc));
  const jsonLd = recordFor("json_ld", extractJsonLd(doc));
  const dublinCore = recordFor("dublin_core", extractDublinCore(doc));
  const openGraph = recordFor("open_graph", extractOpenGraph(doc));
  const doiScan = recordFor("doi_scan", extractDoiScan(doc));

  for (const record of [highwire, jsonLd, dublinCore, openGraph, doiScan]) {
    if (record !== null) {
      records.push(record);
    }
  }

  if (records.length === 0) {
    return { request: null, reason: "No supported bibliographic metadata found on this page." };
  }

  // V1 is single-paper only: ambiguous multi-item pages must not create
  // a capture. Highwire duplicate title and JSON-LD multi-article are
  // already rejected above; a title-less JSON-LD plus a different
  // Highwire title is left to the core's conflict handling.
  return {
    request: {
      schema_version: WEB_CAPTURE_SCHEMA_VERSION,
      capture_id: captureId,
      page_url: pageUrl,
      records,
    },
    reason: null,
  };
}

if (typeof document !== "undefined") {
  const globalRef = globalThis as Record<string, unknown>;
  if (globalRef.__paperNotesExtract === undefined) {
    Object.defineProperty(globalRef, "__paperNotesExtract", {
      value: extractFromDocument,
    });
  }
}
