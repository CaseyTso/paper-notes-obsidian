/**
 * Pure Topic MOC membership resolution.
 *
 * Derives a lookup of citation keys to their containing Topic MOC names
 * from parsed Topic MOC index results.
 *
 * Rules:
 * - Deduplication: A citation key referenced multiple times within the same
 *   Topic MOC appears only once for that Topic MOC.
 * - Non-empty keys: Entries without a figureKey are ignored.
 * - Absence: Keys without any Topic MOC membership do not appear in the Map.
 * - Deterministic order: MOC display names per key are sorted stably
 *   via zh-CN locale comparison.
 */

import type { ParsedMoc } from "./moc-parse";

/**
 * Pure mapping from Topic MOC index results to citation-key membership.
 *
 * Returns a Map where each key is a citation key and the value is a
 * stably-sorted list of Topic MOC display titles. Keys with no Topic MOC
 * membership are omitted from the map.
 */
export function buildMocMembership(
  mocs: ReadonlyArray<ParsedMoc>,
): Map<string, string[]> {
  const keyToMocSet = new Map<string, Set<string>>();

  for (const moc of mocs) {
    const mocTitle = moc.title.trim();
    if (!mocTitle) continue;

    for (const entry of moc.entries) {
      const figureKey = entry.figureKey?.trim();
      if (!figureKey) continue;

      let set = keyToMocSet.get(figureKey);
      if (set === undefined) {
        set = new Set<string>();
        keyToMocSet.set(figureKey, set);
      }
      set.add(mocTitle);
    }
  }

  const result = new Map<string, string[]>();
  for (const [key, mocSet] of keyToMocSet.entries()) {
    const sortedTitles = Array.from(mocSet).sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    );
    result.set(key, sortedTitles);
  }

  return result;
}

/**
 * Pure mapping from Topic MOC title to note vault path.
 * Earlier MOCs take precedence in the rare event of duplicate titles.
 */
export function buildMocTitleToPathMap(
  mocs: ReadonlyArray<ParsedMoc>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const moc of mocs) {
    const title = moc.title.trim();
    if (title && !map.has(title)) {
      map.set(title, moc.path);
    }
  }
  return map;
}
