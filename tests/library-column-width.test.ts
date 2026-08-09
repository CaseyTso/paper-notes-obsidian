/**
 * Batch 2 (D) column-width model: default widths, drag clamping and
 * settings normalization. Pure functions only — no Obsidian, no DOM.
 */
import { describe, expect, it } from "vitest";

import {
  COLUMN_WIDTH_MIN_PX,
  COLUMN_WIDTH_SAFETY_MAX_PX,
  DEFAULT_LIBRARY_COLUMNS,
  clampColumnWidth,
  resolveColumns,
  type ColumnCustomizations,
} from "../src/components/library-table";
import { normalizeSettings } from "../src/settings";

describe("default column widths (Batch 2 D)", () => {
  it("keeps all ten columns visible in the approved order", () => {
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
    expect(DEFAULT_LIBRARY_COLUMNS.every((column) => column.visible)).toBe(true);
  });

  it("raises the defaults so dense content reads comfortably", () => {
    const widthOf = (id: string): number =>
      DEFAULT_LIBRARY_COLUMNS.find((column) => column.id === id)!.width;
    expect(widthOf("title")).toBeGreaterThanOrEqual(320);
    expect(widthOf("journal")).toBeGreaterThanOrEqual(180);
    expect(widthOf("artifacts")).toBeGreaterThanOrEqual(160);
    expect(widthOf("readingStatus")).toBeGreaterThanOrEqual(120);
    // The rest stay reasonable and positive.
    for (const column of DEFAULT_LIBRARY_COLUMNS) {
      expect(column.width).toBeGreaterThan(0);
    }
    expect(widthOf("title")).toBeGreaterThan(widthOf("firstAuthor"));
  });
});

describe("clampColumnWidth", () => {
  it("clamps below the minimum to the drag bound", () => {
    expect(clampColumnWidth(10)).toBe(COLUMN_WIDTH_MIN_PX);
    expect(clampColumnWidth(-100)).toBe(COLUMN_WIDTH_MIN_PX);
  });

  it("has no ceiling: far-wide widths (e.g. 2000+) pass through", () => {
    expect(clampColumnWidth(2000)).toBe(2000);
    expect(clampColumnWidth(2740)).toBe(2740);
    expect(clampColumnWidth(9999)).toBe(9999);
  });

  it("caps only absurd widths at the safety valve (100000)", () => {
    expect(clampColumnWidth(200000)).toBe(COLUMN_WIDTH_SAFETY_MAX_PX);
  });

  it("rounds in-range widths to whole pixels", () => {
    expect(clampColumnWidth(300)).toBe(300);
    expect(clampColumnWidth(300.6)).toBe(301);
    expect(clampColumnWidth(300.4)).toBe(300);
    expect(clampColumnWidth(COLUMN_WIDTH_MIN_PX)).toBe(COLUMN_WIDTH_MIN_PX);
    expect(clampColumnWidth(COLUMN_WIDTH_SAFETY_MAX_PX)).toBe(
      COLUMN_WIDTH_SAFETY_MAX_PX,
    );
  });

  it("treats corrupt (non-finite) input as the minimum", () => {
    expect(clampColumnWidth(Number.NaN)).toBe(COLUMN_WIDTH_MIN_PX);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(COLUMN_WIDTH_MIN_PX);
  });
});

describe("resolveColumns with width customizations", () => {
  it("applies persisted widths over the defaults per column", () => {
    const customizations: ColumnCustomizations = {
      title: { width: 500 },
      journal: { width: 220 },
    };
    const columns = resolveColumns(customizations);
    expect(columns.find((column) => column.id === "title")?.width).toBe(500);
    expect(columns.find((column) => column.id === "journal")?.width).toBe(220);
    // Untouched columns keep their (raised) defaults.
    expect(
      columns.find((column) => column.id === "artifacts")?.width,
    ).toBe(DEFAULT_LIBRARY_COLUMNS.find((column) => column.id === "artifacts")!.width);
  });
});

describe("normalizeSettings columnWidths (Batch 2 D)", () => {
  it("round-trips finite in-range widths", () => {
    const settings = normalizeSettings({
      columnWidths: { title: 400, readingStatus: 150 },
    });
    expect(settings.columnWidths).toEqual({ title: 400, readingStatus: 150 });
  });

  it("round-trips wide widths; clamps only below-min and absurd values", () => {
    const settings = normalizeSettings({
      columnWidths: { title: 5000, journal: 10, cas: 200000 },
    });
    expect(settings.columnWidths?.title).toBe(5000);
    expect(settings.columnWidths?.journal).toBe(COLUMN_WIDTH_MIN_PX);
    expect(settings.columnWidths?.cas).toBe(COLUMN_WIDTH_SAFETY_MAX_PX);
  });

  it("drops non-numeric, non-finite and unknown keys", () => {
    const settings = normalizeSettings({
      columnWidths: {
        title: "wide",
        cas: Number.NaN,
        bogus: 200,
        year: 90,
      },
    });
    expect(settings.columnWidths).toEqual({ year: 90 });
  });

  it("leaves columnWidths absent when the payload is invalid or empty", () => {
    expect(normalizeSettings({ columnWidths: "wide" }).columnWidths).toBeUndefined();
    expect(normalizeSettings({ columnWidths: { title: "wide" } }).columnWidths).toBeUndefined();
    expect(normalizeSettings({}).columnWidths).toBeUndefined();
  });

  it("never touches the other persisted keys", () => {
    const settings = normalizeSettings({
      cliPath: "/opt/paper-notes",
      metricTtlDays: 30,
      metricsCache: { keep: "me" },
      columnWidths: { if: 90 },
    });
    expect(settings.cliPath).toBe("/opt/paper-notes");
    expect(settings.columnWidths).toEqual({ if: 90 });
  });
});
