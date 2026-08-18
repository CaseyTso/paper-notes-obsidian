/**
 * Paper record types for the in-memory literature index (Task 23).
 *
 * These shapes mirror the canonical main note frontmatter (design spec
 * section 6). The plugin is a reader only: nothing here is ever written
 * back to the vault, and volatile metrics (IF/JCI/JCR/CAS/EasyScholar)
 * are deliberately absent — they are UI data, never paper metadata.
 */

export const PAPER_SCHEMA_VERSION = 1;

export interface PaperAuthor {
  family?: string;
  given?: string;
  /** Group/literal author (e.g. a consortium). */
  literal?: string;
}

export interface PaperIdentifiers {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
}

export interface PaperRecord {
  /** Vault path of the canonical main note. */
  path: string;
  /** Citation key; equals the directory and file basename. */
  key: string;
  /** Permanent machine identity (UUID), never derived from metadata. */
  paperId: string;
  title: string;
  authors: PaperAuthor[];
  itemType?: "article-journal" | "preprint";
  journal?: string;
  journalAbbreviation?: string;
  /** Canonical publication date (YYYY, YYYY-MM, or YYYY-MM-DD). */
  publicationDate?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  issn?: string[];
  language?: string;
  identifiers: PaperIdentifiers;
  /** Old citation keys kept after rename (identity aliases). */
  citationKeyAliases: string[];
  /** Title aliases (searchable text only, not reserved identity). */
  titleAliases: string[];
  abstract?: string;
}

export type IndexInvalidReason =
  | "missing_frontmatter"
  | "unsupported_schema"
  | "missing_citation_key"
  | "key_path_mismatch"
  | "missing_paper_id"
  | "invalid_paper_id"
  | "missing_title";

export interface InvalidRecord {
  path: string;
  reasons: IndexInvalidReason[];
}

/**
 * Identity conflicts force the whole index into a read-only error state
 * (design spec 17.3): destructive managed operations must be blocked
 * until the ambiguity is resolved.
 */
export type ReadOnlyError =
  | { kind: "duplicate_key"; value: string; paths: [string, string] }
  | { kind: "duplicate_alias"; value: string; paths: [string, string] }
  | { kind: "duplicate_uuid"; value: string; paths: [string, string] };
