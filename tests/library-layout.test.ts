/**
 * Library shell helpers: advanced-filter accounting and legacy
 * detailPaneRatio settings compatibility. The former split/narrow
 * geometry module was removed with the full-width table shell (the
 * detail surface is now the double-click drawer only).
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_LIBRARY_FILTERS,
  countActiveAdvancedFilters,
  hasActiveAdvancedFilters,
  type LibraryFilters,
} from "../src/components/library-filters";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
} from "../src/settings";

describe("advanced filter accounting", () => {
  it("counts only advanced fields, not Reading or artifact checkboxes", () => {
    const filters: LibraryFilters = {
      ...EMPTY_LIBRARY_FILTERS,
      readingStatus: "read",
      requiredArtifacts: ["pdf", "minerU"],
      yearFrom: 2020,
      journal: "Nature",
      ifMin: 5,
    };
    expect(countActiveAdvancedFilters(filters)).toBe(3);
    expect(hasActiveAdvancedFilters(filters)).toBe(true);
  });

  it("treats empty advanced state as inactive", () => {
    expect(countActiveAdvancedFilters(EMPTY_LIBRARY_FILTERS)).toBe(0);
    expect(hasActiveAdvancedFilters(EMPTY_LIBRARY_FILTERS)).toBe(false);
  });

  it("ignores blank journal/cas/jcr strings", () => {
    const filters: LibraryFilters = {
      ...EMPTY_LIBRARY_FILTERS,
      journal: "   ",
      cas: "",
    };
    expect(countActiveAdvancedFilters(filters)).toBe(0);
  });
});

describe("legacy detailPaneRatio settings compatibility", () => {
  it("leaves the default object free of detailPaneRatio (optional field)", () => {
    expect(DEFAULT_SETTINGS.detailPaneRatio).toBeUndefined();
  });

  it("round-trips a finite ratio through normalizeSettings", () => {
    const settings = normalizeSettings({ detailPaneRatio: 0.42 });
    expect(settings.detailPaneRatio).toBe(0.42);
  });

  it("drops non-finite or absurd ratios back to absent", () => {
    expect(normalizeSettings({ detailPaneRatio: "wide" }).detailPaneRatio).toBe(
      undefined,
    );
    expect(normalizeSettings({ detailPaneRatio: 2 }).detailPaneRatio).toBe(
      undefined,
    );
    expect(normalizeSettings({ detailPaneRatio: 0.01 }).detailPaneRatio).toBe(
      undefined,
    );
  });
});
