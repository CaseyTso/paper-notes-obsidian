import { describe, expect, it } from "vitest";

import { buildReviewRows, REVIEW_FIELD_ORDER } from "../src/services/review-model";

describe("buildReviewRows", () => {
  it("builds rows from a create_with_confirmation plan with editable required fields", () => {
    const rows = buildReviewRows({
      action: "create_with_confirmation",
      values: {
        title: "A paper",
        authors: [{ family: "Doe", given: "Jane" }],
      },
      conflicts: [],
    });
    const byField = new Map(rows.map((row) => [row.field, row]));
    expect(byField.get("title")?.recommended).toBe("A paper");
    expect(byField.get("authors")?.recommended).toBe('{"family":"Doe","given":"Jane"}');
    // Year is required and missing -> editable.
    expect(byField.get("year")?.editable).toBe(true);
    expect(byField.get("year")?.required).toBe(true);
    // Present fields are not editable.
    expect(byField.get("title")?.editable).toBe(false);
    // Fields deliberately not captured are also hidden from review.
    expect(byField.has("item_type")).toBe(false);
    expect(byField.has("publication_date")).toBe(false);
    expect(byField.has("url")).toBe(false);
    expect(byField.has("language")).toBe(false);
    expect(byField.has("journal_abbreviation")).toBe(false);
    // Order is canonical.
    expect(rows.map((row) => row.field)).toEqual([...REVIEW_FIELD_ORDER]);
  });

  it("builds rows from an update_existing plan with proposed values only", () => {
    const rows = buildReviewRows({
      action: "update_existing",
      proposed_values: { abstract: "New abstract" },
      conflicts: [],
    });
    const byField = new Map(rows.map((row) => [row.field, row]));
    expect(byField.get("abstract")?.recommended).toBe("New abstract");
    expect(byField.get("year")?.editable).toBe(false);
  });

  it("exposes explicit conflict options without a default", () => {
    const rows = buildReviewRows({
      action: "create_with_confirmation",
      values: { title: "Web" },
      conflicts: [
        {
          field: "title",
          values: [
            ["crossref", "Official"],
            ["web_highwire", "Web"],
          ],
        },
      ],
    });
    const title = rows.find((row) => row.field === "title");
    expect(title?.conflictOptions).toEqual([
      { source: "crossref", value: "Official" },
      { source: "web_highwire", value: "Web" },
    ]);
    expect(title?.recommended).toBe("Web");
  });
});
