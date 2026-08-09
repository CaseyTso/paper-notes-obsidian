/**
 * Read-only paper detail model (Task 24, Batch 2 A+C).
 *
 * `buildPaperDetail` derives a display-only model from a library item:
 * every value is copied into fresh strings/arrays, so mutating the detail
 * can never touch the index record. No editing, no write-back — manual
 * metadata editing happens in the main YAML (design spec §9.5).
 *
 * Batch 2 sections the drawer: bibliographic rows (`fields`), the header
 * reading-status chip, a metric badge row (`metrics`), an artifact
 * summary (`artifacts`) and the full abstract text (`abstract` — the view
 * truncates long abstracts with an Expand toggle). All sections are
 * read-only derivations; nothing here writes paper YAML.
 */

import type {
  ArtifactAvailability,
  LibraryItem,
  PaperMetrics,
  ReadingStatus,
} from "./library-table";
import { INVALID_METADATA_TITLE } from "./library-table";
import type { PaperAuthor } from "../types/paper";

export interface PaperDetailField {
  label: string;
  value: string;
}

export interface PaperDetailData {
  title: string;
  key: string;
  paperId: string;
  /** Present only for invalid-metadata rows. */
  invalid?: { reasons: string[] };
  /** Bibliographic rows (authors, year, journal, identifiers). */
  fields: PaperDetailField[];
  /** Reading status for the drawer header chip (absent when unset). */
  readingStatus?: ReadingStatus;
  /** Present metric badge rows (CAS/JCR/IF/JCI), UI-only. */
  metrics: PaperDetailField[];
  /** Artifact file presence for the attachments summary row. */
  artifacts: ArtifactAvailability;
  /** Full abstract text (view truncates >600 chars with Expand). */
  abstract?: string;
}

/** Deterministic "Family Given; Literal" rendering of the full author list. */
export function formatAuthors(authors: PaperAuthor[]): string {
  const names = authors.map((author) => {
    if (author.literal !== undefined && author.literal.length > 0) {
      return author.literal;
    }
    return [author.family, author.given].filter(Boolean).join(" ");
  });
  return names.filter((name) => name.length > 0).join("; ");
}

function stringifyMetric(
  metrics: PaperMetrics | undefined,
  key: "cas" | "jcr" | "if" | "jci",
): string | undefined {
  const value = metrics?.[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? String(value) : value;
}

const NO_ARTIFACTS: ArtifactAvailability = {
  pdf: false,
  minerU: false,
  figure: false,
};

/**
 * Derive the read-only detail panel model. All output values are fresh
 * copies; the source item is only read from.
 */
export function buildPaperDetail(item: LibraryItem): PaperDetailData {
  if (item.invalid !== undefined) {
    return {
      title: INVALID_METADATA_TITLE,
      key: item.key,
      paperId: item.paperId,
      invalid: { reasons: [...item.invalid.reasons] },
      fields: [
        { label: "Path", value: item.path },
        { label: "Diagnostics", value: item.invalid.reasons.join(", ") },
      ],
      metrics: [],
      artifacts: { ...NO_ARTIFACTS },
    };
  }
  const record = item.record!;
  const identifiers = [
    ...(record.identifiers.doi !== undefined
      ? [{ label: "DOI", value: record.identifiers.doi }]
      : []),
    ...(record.identifiers.pmid !== undefined
      ? [{ label: "PMID", value: record.identifiers.pmid }]
      : []),
    ...(record.identifiers.pmcid !== undefined
      ? [{ label: "PMCID", value: record.identifiers.pmcid }]
      : []),
    ...(record.identifiers.arxiv !== undefined
      ? [{ label: "arXiv", value: record.identifiers.arxiv }]
      : []),
  ];
  const metrics = [
    ...(stringifyMetric(item.metrics, "cas") !== undefined
      ? [{ label: "CAS", value: stringifyMetric(item.metrics, "cas") as string }]
      : []),
    ...(stringifyMetric(item.metrics, "jcr") !== undefined
      ? [{ label: "JCR", value: stringifyMetric(item.metrics, "jcr") as string }]
      : []),
    ...(stringifyMetric(item.metrics, "if") !== undefined
      ? [{ label: "IF", value: stringifyMetric(item.metrics, "if") as string }]
      : []),
    ...(stringifyMetric(item.metrics, "jci") !== undefined
      ? [{ label: "JCI", value: stringifyMetric(item.metrics, "jci") as string }]
      : []),
  ];
  const fields: PaperDetailField[] = [
    ...(record.authors.length > 0
      ? [{ label: "Authors", value: formatAuthors(record.authors) }]
      : []),
    ...(item.year !== undefined ? [{ label: "Year", value: String(item.year) }] : []),
    ...(item.journal !== undefined
      ? [{ label: "Journal", value: item.journal }]
      : []),
    ...identifiers,
  ];
  const abstract =
    record.abstract !== undefined && record.abstract.length > 0
      ? record.abstract
      : undefined;
  return {
    title: item.title,
    key: item.key,
    paperId: item.paperId,
    fields,
    readingStatus: item.readingStatus,
    metrics,
    artifacts: { ...item.artifacts },
    ...(abstract !== undefined ? { abstract } : {}),
  };
}
