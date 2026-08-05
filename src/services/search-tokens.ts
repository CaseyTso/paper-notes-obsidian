/**
 * Shared multi-word query semantics (Gate D R5 repair).
 *
 * A query is split on whitespace into tokens; a record matches when every
 * token appears in the searchable text (token AND). Empty tokens from
 * consecutive whitespace are ignored, single-token queries behave exactly
 * like the previous whole-phrase substring match, and matching stays
 * case-insensitive. This module is the single definition of the token-AND
 * rule used by every search surface (library index default search, MinerU
 * full-text search, the library view search box and the citation picker).
 */

/** Split a trimmed, lower-cased query into non-empty whitespace tokens. */
export function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** True when every token appears in `text` (token AND). */
export function matchesAllTokens(text: string, tokens: string[]): boolean {
  return tokens.every((token) => text.includes(token));
}
