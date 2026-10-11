/**
 * library-filter-form: Pending Library Filter form widget (S2a).
 *
 * Event-contract / node-identity coverage of the standalone form. These
 * tests deliberately do NOT prove real browser focus, caret, layout or
 * native `type=number` sanitisation — they prove that:
 *  - the four numeric controls keep one stable node and the raw partial
 *    text (`2` → `20` → `200` → `2001`, `0.`, `.5`) through typing, blur
 *    and a roster refresh, and never emit a callback;
 *  - no callback fires before an explicit Apply, and Apply emits a fresh
 *    canonical snapshot at most once;
 *  - native `validity.badInput` (value sanitised to `""`) blocks Apply;
 *  - invalid / negative / incoherent-year drafts disable Apply;
 *  - Reset clears only the pending draft and Cancel carries no payload;
 *  - labels/ids are unique per instance and errors are associated with
 *    their field via `aria-describedby` + `aria-invalid`;
 *  - the journal lookup text is not itself a filter, selection is single,
 *    the choice is visibly identifiable and clearable;
 *  - a roster refresh rebuilds only the option list;
 *  - `dispose()` removes local listeners and blocks stale callbacks.
 */
import { describe, expect, it } from "vitest";

import { LibraryFilterForm } from "../src/components/library-filter-form";
import {
  createMockContainer,
  type MockEl,
  type MockInputLike,
} from "./library-filter-test-dom";

interface ApplyRecord {
  readonly filters: unknown;
  readonly artifacts: readonly string[];
}

/** Mount one form and record its callbacks. */
function mount(
  options: {
    filters?: Record<string, unknown>;
    journals?: readonly string[];
  } = {},
): {
  form: LibraryFilterForm;
  root: MockEl;
  applies: ApplyRecord[];
  cancels: number;
  find(cls: string): MockEl;
  findAll(cls: string): MockEl[];
  byTag(tag: string): MockEl[];
  input(field: string): MockEl & MockInputLike;
} {
  const container = createMockContainer();
  const applies: ApplyRecord[] = [];
  let cancels = 0;
  const form = new LibraryFilterForm({
    container: container as unknown as HTMLElement,
    filters: {
      requiredArtifacts: [],
      ...(options.filters ?? {}),
    } as never,
    journals: options.journals ?? ["Nature", "Cell", "Science"],
    onApply: (filters) =>
      applies.push({
        filters,
        artifacts: [...filters.requiredArtifacts],
      }),
    onCancel: () => {
      cancels += 1;
    },
  });
  const root = container.children[0] as MockEl;
  return {
    form,
    root,
    applies,
    get cancels() {
      return cancels;
    },
    find: (cls) => root.findByClass(cls),
    findAll: (cls) => root.findAllByClass(cls),
    byTag: (tag) => root.byTag(tag),
    input: (field) => {
      const found = root.findAll(
        (el) => el.tag === "input" && el.getAttribute("id")?.endsWith(field) === true,
      );
      if (found.length !== 1) {
        throw new Error(`expected one input for ${field}, got ${found.length}`);
      }
      return found[0] as MockEl & MockInputLike;
    },
  };
}

function type(view: ReturnType<typeof mount>, field: string, value: string): void {
  const input = view.input(field);
  input.value = value;
  input.dispatchEvent({ type: "input" });
}

function click(el: MockEl): void {
  el.dispatchEvent({ type: "click" });
}

/** Build a roster of `count` synthetic names, plus a trailing exact "Cell". */
function rosterWithTail(count: number, tail: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    names.push(`Journal ${String(i).padStart(4, "0")}`);
  }
  names.push(tail);
  return names;
}

describe("stable pending form — numeric controls", () => {
  it("keeps one node and raw partial text through continuous typing", () => {
    const view = mount();
    const node = view.input("yearFrom");
    for (const partial of ["2", "20", "200", "2001"]) {
      type(view, "yearFrom", partial);
      expect(view.input("yearFrom")).toBe(node);
      expect(node.value).toBe(partial);
      expect(view.applies).toHaveLength(0);
    }
    expect(node.value).toBe("2001");
  });

  it("survives blur, roster refresh and selection edits without remount", () => {
    const view = mount();
    const node = view.input("yearFrom");
    type(view, "yearFrom", "200");
    node.dispatchEvent({ type: "blur" });
    expect(view.input("yearFrom")).toBe(node);
    expect(node.value).toBe("200");

    view.form.setJournalOptions(["Nature", "Cell", "Science", "Lancet"]);
    expect(view.input("yearFrom")).toBe(node);
    expect(node.value).toBe("200");

    view.find("paper-notes-library-filter-form-journal-query").value = "nat";
    view
      .find("paper-notes-library-filter-form-journal-query")
      .dispatchEvent({ type: "input" });
    click(view.findAll("paper-notes-library-filter-form-journal-option")[0] as MockEl);
    expect(view.input("yearFrom")).toBe(node);
    expect(node.value).toBe("200");
    expect(view.applies).toHaveLength(0);
  });

  it("preserves decimals, trailing dots and an explicit zero", () => {
    const view = mount();
    const jci = view.input("jciMin");
    type(view, "jciMin", "0.");
    expect(jci.value).toBe("0.");
    expect(view.applies).toHaveLength(0);
    type(view, "jciMin", ".5");
    expect(jci.value).toBe(".5");
    type(view, "jciMin", "0");
    expect(jci.value).toBe("0");
    type(view, "ifMin", "5");
    expect(view.input("ifMin").value).toBe("5");
  });

  it("exposes only the four numeric inputs and no hidden maxima or sliders", () => {
    const view = mount();
    const numeric = view
      .byTag("input")
      .filter((el) => el.getAttribute("type") === "number");
    expect(numeric.map((el) => el.getAttribute("id"))).toEqual([
      `${idPrefixOf(view)}-yearFrom`,
      `${idPrefixOf(view)}-yearTo`,
      `${idPrefixOf(view)}-ifMin`,
      `${idPrefixOf(view)}-jciMin`,
    ]);
    for (const el of view.byTag("input")) {
      expect(el.getAttribute("type")).not.toBe("range");
    }
    // Only the year bounds carry a documented max; the metric minima and
    // nothing else may ever declare an upper bound or a slider.
    for (const el of numeric) {
      if (el.getAttribute("id")?.endsWith("-yearFrom") || el.getAttribute("id")?.endsWith("-yearTo")) {
        continue;
      }
      expect(el.getAttribute("max"), el.getAttribute("id") ?? "").toBeNull();
    }
  });

  it("years are four-digit step-1 integers, metric minima are open-ended", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    expect(yearFrom.getAttribute("min")).toBe("1000");
    expect(yearFrom.getAttribute("max")).toBe("9999");
    expect(yearFrom.getAttribute("step")).toBe("1");
    const ifMin = view.input("ifMin");
    expect(ifMin.getAttribute("min")).toBe("0");
    expect(ifMin.getAttribute("step")).toBe("any");
    expect(ifMin.getAttribute("max")).toBeNull();
    const jciMin = view.input("jciMin");
    expect(jciMin.getAttribute("min")).toBe("0");
    expect(jciMin.getAttribute("step")).toBe("any");
    expect(jciMin.getAttribute("max")).toBeNull();
  });
});


/** Journal option label texts (the nested name spans). */
function optionNamesOf(options: MockEl[]): string[] {
  return options
    .map((el) => el.children.find((c) => c.cls.includes("journal-option-name")))
    .map((el) => el?.textContent ?? "");
}

/** Text of the error node associated with one numeric field. */
function errorTextOf(view: { root: MockEl }, field: string): string {
  const id = `${idPrefixOf(view)}-${field}-error`;
  const el = view.root.findAll((node) => node.getAttribute("id") === id)[0];
  return el?.textContent ?? "";
}

function idPrefixOf(view: { root: MockEl }): string {
  const id = view.root.findAll(
    (el) => el.tag === "input" && el.getAttribute("id")?.endsWith("-yearFrom") === true,
  )[0]?.getAttribute("id");
  return (id ?? "").replace(/-yearFrom$/, "");
}

describe("native badInput forwarding", () => {
  it("blocks Apply while the browser sanitised the value to empty", () => {
    const view = mount();
    const ifMin = view.input("ifMin");
    // A native `type=number` input reports `.value === ""` for text it
    // cannot parse, so `validity.badInput` is the only live signal.
    ifMin.value = "";
    ifMin.validity = { badInput: true };
    ifMin.dispatchEvent({ type: "input" });
    expect(view.applies).toHaveLength(0);
    const apply = view.find("paper-notes-library-filter-form-button-primary");
    expect(apply.disabled).toBe(true);
    const errorId = `${idPrefixOf(view)}-ifMin-error`;
    const error = view.root.findAll((el) => el.getAttribute("id") === errorId)[0] as MockEl;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("non-negative");
    expect(ifMin.getAttribute("aria-invalid")).toBe("true");
    expect(ifMin.getAttribute("aria-describedby")).toBe(error.getAttribute("id"));

    // Recovering clears the guard without remounting the control.
    ifMin.validity = { badInput: false };
    type(view, "ifMin", "2");
    expect(view.input("ifMin")).toBe(ifMin);
    expect(apply.disabled).toBe(false);
    const recovered = view.root.findAll(
      (el) => el.getAttribute("id") === `${idPrefixOf(view)}-ifMin-error`,
    )[0] as MockEl;
    expect(recovered.hidden).toBe(true);
  });

  it("keeps blank (never typed) unrestricted and distinct from an explicit 0", () => {
    const blank = mount();
    type(blank, "jciMin", "5");
    type(blank, "jciMin", "");
    expect(blank.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    click(blank.find("paper-notes-library-filter-form-button-primary"));
    expect(blank.applies).toHaveLength(1);
    expect((blank.applies[0]?.filters as { jciMin?: number }).jciMin).toBeUndefined();

    const zero = mount();
    type(zero, "jciMin", "0");
    click(zero.find("paper-notes-library-filter-form-button-primary"));
    expect(zero.applies).toHaveLength(1);
    expect((zero.applies[0]?.filters as { jciMin?: number }).jciMin).toBe(0);
  });
});

describe("validation guards", () => {
  it("rejects a reversed year interval and marks both endpoints", () => {
    const view = mount();
    type(view, "yearFrom", "2001");
    type(view, "yearFrom", "2001");
    type(view, "yearTo", "1999");
    const apply = view.find("paper-notes-library-filter-form-button-primary");
    expect(apply.disabled).toBe(true);
    const errors = view.findAll("paper-notes-library-filter-form-error");
    // 4 numeric error nodes + 2 rank error nodes, all persistent.
    expect(errors).toHaveLength(6);
    expect(errors.filter((el) => el.hidden === false)).toHaveLength(2);
    expect(view.input("yearFrom").getAttribute("aria-invalid")).toBe("true");
    expect(view.input("yearTo").getAttribute("aria-invalid")).toBe("true");
    expect(view.applies).toHaveLength(0);

    // A coherent interval re-enables Apply on the same nodes.
    type(view, "yearTo", "2010");
    expect(view.input("yearTo").value).toBe("2010");
    expect(apply.disabled).toBe(false);
    expect(
      view.findAll("paper-notes-library-filter-form-error").every((el) => el.hidden),
    ).toBe(true);
  });

  it("rejects a negative metric minimum and a non-four-digit year", () => {
    const view = mount();
    type(view, "ifMin", "-1");
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      true,
    );
    expect(errorTextOf(view, "ifMin")).toContain("non-negative");
    type(view, "ifMin", "");
    type(view, "yearFrom", "999");
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      true,
    );
    expect(errorTextOf(view, "yearFrom")).toContain("four-digit");
  });

  it("keeps the raw partial 2/20/200 invalid until 2001 completes", () => {
    const view = mount();
    const node = view.input("yearFrom");
    for (const partial of ["2", "20", "200"]) {
      type(view, "yearFrom", partial);
      expect(node.value).toBe(partial);
      expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
        true,
      );
    }
    type(view, "yearFrom", "2001");
    expect(node.value).toBe("2001");
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    expect(view.applies).toHaveLength(0);
  });
});

describe("applied filters are read-only inputs", () => {
  it("renders applied values into the draft without mutating them", () => {
    const applied = {
      yearFrom: 2020,
      yearTo: 2024,
      ifMin: 5,
      jciMin: 1.5,
      cas: "中科院一区",
      jcr: "q2",
      journal: "Nature",
      readingStatus: "reading",
      requiredArtifacts: ["pdf", "figure"],
    };
    const snapshot = JSON.parse(JSON.stringify(applied));
    const view = mount({ filters: applied });
    expect(view.input("yearFrom").value).toBe("2020");
    expect(view.input("yearTo").value).toBe("2024");
    expect(view.input("ifMin").value).toBe("5");
    expect(view.input("jciMin").value).toBe("1.5");
    // Known CAS/JCR spellings display their finite option.
    const cas = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-cas")) as MockEl;
    expect(cas.value).toBe("1区");
    const jcr = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-jcr")) as MockEl;
    expect(jcr.value).toBe("Q2");
    expect(view.find("paper-notes-library-filter-form-journal-selected-name").textContent)
      .toBe("Nature");
    expect(applied).toEqual(snapshot);
    expect(view.applies).toHaveLength(0);
  });

  it("keeps every selection pending until an explicit Apply", () => {
    const view = mount();
    type(view, "yearFrom", "1999");
    click(view.findAll("paper-notes-library-filter-form-checkbox")[0] as MockEl);
    const cas = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-cas")) as MockEl;
    cas.value = "2区";
    cas.dispatchEvent({ type: "change" });
    const reading = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-reading")) as MockEl;
    reading.value = "read";
    reading.dispatchEvent({ type: "change" });
    click(view.findAll("paper-notes-library-filter-form-journal-option")[1] as MockEl);

    expect(view.applies).toHaveLength(0);
    expect(view.input("yearFrom").value).toBe("1999");
    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(1);
    const filters = view.applies[0]?.filters as {
      yearFrom?: number;
      cas?: string;
      jcr?: string;
      readingStatus?: string;
      journal?: string;
      ifMax?: number;
      jciMax?: number;
    };
    expect(filters.yearFrom).toBe(1999);
    expect(filters.cas).toBe("2区");
    expect(filters.readingStatus).toBe("read");
    expect(filters.journal).toBe("Cell");
    expect(filters.jcr).toBeUndefined();
    expect(filters.ifMax).toBeUndefined();
    expect(filters.jciMax).toBeUndefined();
  });
});

describe("journal chooser", () => {
  it("treats the lookup text as display-only, never as a filter", () => {
    const view = mount();
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "natu";
    query.dispatchEvent({ type: "input" });
    const options = view.findAll("paper-notes-library-filter-form-journal-option");
    // The option label lives in a nested span, so read the name nodes.
    expect(optionNamesOf(options)).toEqual(["Nature"]);
    expect(view.applies).toHaveLength(0);

    // The selected journal is still empty: typing is not selecting. The
    // "no journal selected" row stays visible while nothing is selected.
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-empty").hidden,
    ).toBe(false);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-name").hidden,
    ).toBe(true);
    click(view.find("paper-notes-library-filter-form-button-primary"));
    const filters = view.applies[0]?.filters as { journal?: string };
    expect(filters.journal).toBeUndefined();
  });

  it("keeps a single selection, shows it identifiably and clears it", () => {
    const view = mount();
    const first = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[0] as MockEl;
    click(first);
    let options = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(options.filter((el) => el.cls.includes("is-selected"))).toHaveLength(1);
    expect(options[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-name").textContent,
    ).toBe("Nature");

    // The option list is rebuilt on each local update, so the second option
    // must be re-queried before it can be activated.
    click(view.findAll("paper-notes-library-filter-form-journal-option")[1] as MockEl);
    options = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(options.filter((el) => el.cls.includes("is-selected"))).toHaveLength(1);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-name").textContent,
    ).toBe("Cell");

    const clearButton = view.find("paper-notes-library-filter-form-journal-clear");
    clearButton.focus();
    click(clearButton);
    options = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(options.filter((el) => el.cls.includes("is-selected"))).toHaveLength(0);
    // The Clear node is persistent: it is hidden, never destroyed.
    expect(
      view.find("paper-notes-library-filter-form-journal-clear"),
    ).toBe(clearButton);
    expect(clearButton.hidden).toBe(true);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-empty").hidden,
    ).toBe(false);
    expect(view.applies).toHaveLength(0);
  });

  it("selects a journal by keyboard without submitting the filters", () => {
    const view = mount();
    const option = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[1] as MockEl;
    // Enter/Space on a native button produce `click`; the form itself adds
    // no submit handler, so nothing can apply here.
    click(option);
    expect(view.applies).toHaveLength(0);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-name").textContent,
    ).toBe("Cell");
  });

  it("refreshes the roster without touching the lookup node or draft", () => {
    const view = mount();
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "nat";
    query.dispatchEvent({ type: "input" });
    type(view, "yearFrom", "2001");
    const yearNode = view.input("yearFrom");

    view.form.setJournalOptions(["Nature", "Nature Protocols", "Lancet", "Cell"]);
    expect(view.find("paper-notes-library-filter-form-journal-query")).toBe(query);
    expect(query.value).toBe("nat");
    const names = view
      .findAll("paper-notes-library-filter-form-journal-option-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["Nature", "Nature Protocols"]);
    expect(view.input("yearFrom")).toBe(yearNode);
    expect(yearNode.value).toBe("2001");
    expect(view.applies).toHaveLength(0);

    query.value = "";
    query.dispatchEvent({ type: "input" });
    const all = view
      .findAll("paper-notes-library-filter-form-journal-option-name")
      .map((el) => el.textContent);
    // The refreshed roster's own spelling wins for a case-variant name.
    expect(all).toEqual(["Nature", "Nature Protocols", "Lancet", "Cell"]);
  });
});

describe("Reset versus Cancel", () => {
  it("Reset clears only the pending draft and never calls onApply", () => {
    const view = mount();
    type(view, "yearFrom", "2001");
    type(view, "ifMin", "3.5");
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "nat";
    query.dispatchEvent({ type: "input" });
    click(view.findAll("paper-notes-library-filter-form-journal-option")[0] as MockEl);
    type(view, "yearTo", "1999");
    const yearNode = view.input("yearFrom");
    const queryNode = view.find("paper-notes-library-filter-form-journal-query");

    click(view.find("paper-notes-library-filter-form-button"));
    expect(view.applies).toHaveLength(0);
    expect(view.cancels).toBe(0);
    expect(yearNode.value).toBe("");
    expect(view.input("ifMin").value).toBe("");
    expect(view.input("yearTo").value).toBe("");
    expect(queryNode.value).toBe("");
    expect(query.value).toBe("");
    expect(view.input("yearFrom")).toBe(yearNode);
    expect(view.find("paper-notes-library-filter-form-journal-query")).toBe(queryNode);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-empty").hidden,
    ).toBe(false);
    // Errors are cleared too, and Apply is enabled again.
    expect(
      view.findAll("paper-notes-library-filter-form-error").every((el) => el.hidden),
    ).toBe(true);
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    const boxes = view
      .byTag("input")
      .filter((el) => el.getAttribute("type") === "checkbox");
    expect(boxes.every((el) => el.checked === false)).toBe(true);
  });

  it("Cancel emits no filter payload", () => {
    const view = mount();
    type(view, "yearFrom", "2001");
    const buttons = view
      .findAll("paper-notes-library-filter-form-button")
      .filter((el) => !el.cls.includes("button-primary"));
    expect(buttons.map((el) => el.textContent)).toEqual(["Reset", "Cancel"]);
    click(buttons[1] as MockEl);
    expect(view.cancels).toBe(1);
    expect(view.applies).toHaveLength(0);
    // The pending draft survives Cancel.
    expect(view.input("yearFrom").value).toBe("2001");
  });
});

describe("Apply payload", () => {
  it("emits a fresh canonical snapshot once per explicit activation", () => {
    const view = mount();
    type(view, "yearFrom", "2001");
    click(view.find("paper-notes-library-filter-form-button-primary"));
    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(2);
    const [first, second] = view.applies;
    expect(first?.filters).toEqual(second?.filters);
    expect(first?.filters).not.toBe(second?.filters);
    expect(first?.artifacts).not.toBe(second?.artifacts);
    expect((first?.filters as { ifMax?: number }).ifMax).toBeUndefined();
    expect((first?.filters as { jciMax?: number }).jciMax).toBeUndefined();
    expect((first?.filters as { requiredArtifacts: string[] }).requiredArtifacts).toEqual(
      [],
    );
  });

  it("guards a programmatic activation of a disabled Apply", () => {
    const view = mount();
    type(view, "yearFrom", "2001");
    type(view, "yearTo", "1999");
    const apply = view.find("paper-notes-library-filter-form-button-primary");
    expect(apply.disabled).toBe(true);
    click(apply);
    expect(view.applies).toHaveLength(0);
    // The handler revalidates and re-renders the error state.
    expect(view.findAll("paper-notes-library-filter-form-error").some((el) => !el.hidden))
      .toBe(true);
  });
});

describe("accessibility and identity", () => {
  it("associates unique labels with unique ids across instances", () => {
    const first = mount();
    const second = mount();
    const idsOf = (view: { root: MockEl }): string[] =>
      view.root
        .byTag("input")
        .map((el) => el.getAttribute("id"))
        .filter((id): id is string => typeof id === "string");
    const firstIds = idsOf(first);
    const secondIds = idsOf(second);
    // 4 numeric + 1 journal lookup + 3 artifact checkboxes, each with an id.
    expect(firstIds).toHaveLength(8);
    expect(new Set(firstIds).size).toBe(8);
    expect(new Set(secondIds).size).toBe(8);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);

    for (const view of [first, second]) {
      for (const label of view.root.byTag("label")) {
        const target = label.getAttribute("for");
        expect(target).not.toBeNull();
        expect(
          view.root.byTag("input").some((el) => el.getAttribute("id") === target) ||
            view.root.byTag("select").some((el) => el.getAttribute("id") === target),
        ).toBe(true);
      }
      const errorIds = view.root
        .findAll((el) => el.cls.includes("filter-form-error"))
        .map((el) => el.getAttribute("id"));
      expect(errorIds.every((id) => id?.endsWith("-error"))).toBe(true);
    }
  });

  it("exposes visible focus states without a focus trap", () => {
    const view = mount();
    const styles = readFormStyles();
    expect(styles).toContain("paper-notes-library-filter-form-input:focus-visible");
    expect(styles).toContain("outline");
    // Nonmodal: no tabindex trap, no aria-modal, no global key handling.
    expect(view.root.getAttribute("aria-modal")).toBeNull();
    expect(view.root.getAttribute("role")).toBe("group");
  });

  it("separates the scrollable fields from the nonshrinking footer", () => {
    const view = mount();
    expect(view.find("paper-notes-library-filter-form-scroll").tag).toBe("div");
    expect(view.find("paper-notes-library-filter-form-footer").tag).toBe("div");
    const styles = readFormStyles();
    expect(styles).toContain("paper-notes-library-filter-form-scroll");
    expect(styles).toContain("paper-notes-library-filter-form-footer");
    expect(styles).toContain("flex-shrink: 0");
  });

  it("marks an invalid rank select and its unsupported placeholder", () => {
    const styles = readFormStyles();
    expect(styles).toContain('select[aria-invalid="true"]');
    expect(styles).toContain("option[disabled]");
  });

  it("uses semantic Obsidian theme variables, not a fixed palette", () => {
    const styles = readFormStyles();
    expect(styles).toContain("var(--background-primary)");
    expect(styles).toContain("var(--text-normal)");
    expect(styles).toContain("var(--interactive-accent)");
    // No hard-coded colour palette: the only `#` occurrences are the
    // documented fallbacks for themes that omit a variable.
    const hexes = styles.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];
    expect(new Set(hexes)).toEqual(new Set(["#dc2626", "#ffffff"]));
  });
});

describe("dispose", () => {
  it("removes local listeners and blocks stale callbacks", () => {
    const view = mount();
    const yearNode = view.input("yearFrom");
    const option = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[0] as MockEl;
    const before = view.root.subtreeListenerCount();
    expect(before).toBeGreaterThan(0);

    view.form.dispose();
    expect(yearNode.listenerCount()).toBe(0);
    expect(option.listenerCount()).toBe(0);
    expect(view.root.subtreeListenerCount()).toBe(0);

    // Stale events must not reach any callback.
    type(view, "yearFrom", "2001");
    click(option);
    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(0);

    // Idempotent, and a second dispose changes nothing.
    view.form.dispose();
    expect(view.applies).toHaveLength(0);
    expect(view.root.subtreeListenerCount()).toBe(0);
  });
});

/** Read only the appended filter-form rules from src/styles.css. */
function readFormStyles(): string {
  return formStylesCache ?? (formStylesCache = loadFormStyles());
}

let formStylesCache: string | null = null;

function loadFormStyles(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const css = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  ) as string;
  const start = css.indexOf(".paper-notes-library-filter-form {");
  if (start < 0) {
    throw new Error("filter form styles not found in src/styles.css");
  }
  return css.slice(start);
}

describe("full-library reachability past the render limit", () => {
  it("exposes the exact match before truncation and can select/apply it", () => {
    // 200 OVERLAPPING names that all match "cell", then the exact "Cell":
    // without exact-match promotion the target is pushed past the limit.
    const roster: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      roster.push(`Cell Research ${i}`);
    }
    roster.push("Cell");
    const view = mount({ journals: roster });
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "cell";
    query.dispatchEvent({ type: "input" });

    const names = optionNamesOf(
      view.findAll("paper-notes-library-filter-form-journal-option"),
    );
    // 201 names match, only 200 are rendered, and the exact match is first.
    expect(names).toHaveLength(200);
    expect(names[0]).toBe("Cell");
    // One overlapping name is necessarily dropped by the limit.
    expect(names).not.toContain("Cell Research 199");
    expect(names).toContain("Cell Research 0");
    expect(view.applies).toHaveLength(0);

    const cell = view
      .findAll("paper-notes-library-filter-form-journal-option")
      .find((el) => optionNamesOf([el])[0] === "Cell") as MockEl;
    expect(cell).toBeDefined();
    click(cell);
    expect(
      view.find("paper-notes-library-filter-form-journal-selected-name").textContent,
    ).toBe("Cell");
    expect(view.applies).toHaveLength(0);

    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(1);
    const filters = view.applies[0]?.filters as { journal?: string };
    expect(filters.journal).toBe("Cell");
  });

  it("keeps duplicates and case variants deduplicated in the roster", () => {
    const view = mount({
      journals: ["Nature", "nature", " Nature ", "Cell"],
    });
    const names = optionNamesOf(
      view.findAll("paper-notes-library-filter-form-journal-option"),
    );
    expect(names).toEqual(["Nature", "Cell"]);
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "NATURE";
    query.dispatchEvent({ type: "input" });
    expect(
      optionNamesOf(view.findAll("paper-notes-library-filter-form-journal-option")),
    ).toEqual(["Nature"]);
  });

  it("reports the truncated remainder in the status line", () => {
    const view = mount({ journals: rosterWithTail(250, "Cell") });
    const status = view.find("paper-notes-library-filter-form-journal-status");
    // With no lookup the whole 251-name roster is truncated to the limit.
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("251");
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "journal";
    query.dispatchEvent({ type: "input" });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("250");
    query.value = "cell";
    query.dispatchEvent({ type: "input" });
    expect(status.hidden).toBe(true);
  });
});

describe("journal option lifetime", () => {
  it("reuses option nodes on selection and same-roster refresh", () => {
    const view = mount();
    const before = view.findAll("paper-notes-library-filter-form-journal-option");
    const clearBefore = view.find("paper-notes-library-filter-form-journal-clear");
    const nameBefore = view.find(
      "paper-notes-library-filter-form-journal-selected-name",
    );

    click(before[0] as MockEl);
    const afterSelect = view.findAll("paper-notes-library-filter-form-journal-option");
    // Same set of nodes, only their classes/aria changed in place.
    expect(afterSelect.map((el) => el === before[0] || el === before[1] || el === before[2]))
      .toEqual([true, true, true]);
    expect(view.find("paper-notes-library-filter-form-journal-clear")).toBe(clearBefore);
    expect(view.find("paper-notes-library-filter-form-journal-selected-name")).toBe(
      nameBefore,
    );

    view.form.setJournalOptions(["Nature", "Cell", "Science"]);
    const afterRefresh = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(afterRefresh[0]).toBe(before[0]);
    expect(afterRefresh[1]).toBe(before[1]);
    expect(afterRefresh[2]).toBe(before[2]);
    expect(afterRefresh[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(view.applies).toHaveLength(0);
  });

  it("keeps surviving nodes and drops removed ones across a roster change", () => {
    const view = mount({ journals: ["Nature", "Cell", "Science", "Lancet"] });
    const original = view.findAll("paper-notes-library-filter-form-journal-option");
    const nature = original[0] as MockEl;
    const cell = original[1] as MockEl;

    view.form.setJournalOptions(["Nature", "Cell", "Lancet"]);
    const after = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(nature);
    expect(after[1]).toBe(cell);
    // The removed "Science" node is detached and has no listeners left.
    expect(original[2]?.parent).toBeNull();
    expect(original[2]?.listenerCount()).toBe(0);
    expect(view.applies).toHaveLength(0);
  });

  it("reinserts a newly matched option without moving the others", () => {
    const view = mount({ journals: ["Nature", "Cell", "Science"] });
    const [nature, cell, science] = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    );
    const query = view.find("paper-notes-library-filter-form-journal-query");
    query.value = "a";
    query.dispatchEvent({ type: "input" });
    // Only "Nature" contains "a"; "Cell" and "Science" do not.
    let visible = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(nature);
    expect(cell?.parent).toBeNull();
    expect(science?.parent).toBeNull();

    query.value = "";
    query.dispatchEvent({ type: "input" });
    visible = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(visible).toHaveLength(3);
    expect(visible[0]).toBe(nature);
    expect(visible[1]).toBe(cell);
    expect(visible[2]).toBe(science);
  });

  it("hands focus to the lookup when the focused option disappears", () => {
    const view = mount({ journals: ["Nature", "Cell", "Science"] });
    const query = view.find("paper-notes-library-filter-form-journal-query");
    const nature = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[0] as MockEl;
    nature.focus();
    expect(view.root.ownerDocument.activeElement).toBe(nature);

    // Removing the focused option must deliberately hand focus to the lookup.
    view.form.setJournalOptions(["Cell", "Science"]);
    expect(view.root.ownerDocument.activeElement).toBe(query);
    expect(query.focusCalls()).toBeGreaterThan(0);
    expect(view.applies).toHaveLength(0);
  });

  it("hands focus to the lookup when Clear hides its focused button", () => {
    const view = mount();
    click(view.findAll("paper-notes-library-filter-form-journal-option")[0] as MockEl);
    const clear = view.find("paper-notes-library-filter-form-journal-clear");
    const query = view.find("paper-notes-library-filter-form-journal-query");
    clear.focus();
    expect(view.root.ownerDocument.activeElement).toBe(clear);

    click(clear);
    expect(clear.hidden).toBe(true);
    expect(view.root.ownerDocument.activeElement).toBe(query);
    expect(query.focusCalls()).toBeGreaterThan(0);
    expect(view.applies).toHaveLength(0);
  });

  it("bounds option listeners across many refreshes and disposal", () => {
    const view = mount();
    const totalListeners = (): number =>
      view.findAll("paper-notes-library-filter-form-journal-option")
        .reduce((sum, el) => sum + el.listenerCount(), 0);
    expect(totalListeners()).toBe(3);

    for (let i = 0; i < 5; i += 1) {
      const query = view.find("paper-notes-library-filter-form-journal-query");
      query.value = i % 2 === 0 ? "n" : "c";
      query.dispatchEvent({ type: "input" });
    }
    // One listener per live option, never accumulated.
    const options = view.findAll("paper-notes-library-filter-form-journal-option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.listenerCount()).toBe(1);
    }

    view.form.dispose();
    for (const option of options) {
      expect(option.listenerCount()).toBe(0);
    }
    expect(view.root.subtreeListenerCount()).toBe(0);
    expect(view.applies).toHaveLength(0);
  });
});

describe("unsupported initial CAS/JCR values", () => {
  it("shows an unknown CAS value as a nonselectable placeholder and blocks Apply", () => {
    const applied = { cas: "13区", requiredArtifacts: [] };
    const snapshot = JSON.parse(JSON.stringify(applied));
    const view = mount({ filters: applied });

    const cas = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-cas")) as MockEl;
    const options = cas.children;
    // Any + four finite choices + one disabled current-value placeholder.
    expect(options).toHaveLength(6);
    // Exactly ONE option carries the current select value, and it is the
    // disabled unsupported placeholder — not the native "Any" option.
    const matching = options.filter(
      (el) => (el as unknown as { value: string }).value === cas.value,
    );
    expect(matching).toHaveLength(1);
    const placeholder = matching[0] as MockEl;
    expect(placeholder.getAttribute("disabled")).not.toBeNull();
    expect(placeholder.textContent).toContain("13区");
    expect(cas.value).toBe("unsupported:13区");
    expect(cas.value).not.toBe("");
    // The placeholder value is disjoint from Any and the four valid choices.
    const values = options.map((el) => (el as unknown as { value: string }).value);
    expect(new Set(values).size).toBe(6);
    expect(values.filter((v) => v === cas.value)).toHaveLength(1);

    expect(cas.getAttribute("aria-invalid")).toBe("true");
    const errorId = cas.getAttribute("aria-describedby") as string;
    const error = view.root.findAll((el) => el.getAttribute("id") === errorId)[0] as MockEl;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("13区");

    // Apply is disabled AND the handler is guarded.
    const apply = view.find("paper-notes-library-filter-form-button-primary");
    expect(apply.disabled).toBe(true);
    click(apply);
    expect(view.applies).toHaveLength(0);
    expect(applied).toEqual(snapshot);
  });

  it("shows an ambiguous JCR value as unsupported and resolves on Any", () => {
    const view = mount({ filters: { jcr: "Q 1", requiredArtifacts: [] } });
    const jcr = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-jcr")) as MockEl;
    expect(jcr.children).toHaveLength(6);
    const jcrMatches = jcr.children.filter(
      (el) => (el as unknown as { value: string }).value === jcr.value,
    );
    expect(jcrMatches).toHaveLength(1);
    expect((jcrMatches[0] as MockEl).textContent).toContain("Q 1");
    expect((jcrMatches[0] as MockEl).getAttribute("disabled")).not.toBeNull();
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      true,
    );

    jcr.value = "";
    jcr.dispatchEvent({ type: "change" });
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    // The placeholder is removed once a representable choice is pending.
    expect(jcr.children).toHaveLength(5);
    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(1);
    expect((view.applies[0]?.filters as { jcr?: string }).jcr).toBeUndefined();
  });

  it("still normalises known prefixes and Chinese ranks", () => {
    const view = mount({
      filters: { cas: "中科院一区", jcr: "q2", requiredArtifacts: [] },
    });
    const cas = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-cas")) as MockEl;
    const jcr = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-jcr")) as MockEl;
    expect(cas.children).toHaveLength(5);
    expect(cas.value).toBe("1区");
    expect(jcr.children).toHaveLength(5);
    expect(jcr.value).toBe("Q2");
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    click(view.find("paper-notes-library-filter-form-button-primary"));
    const filters = view.applies[0]?.filters as { cas?: string; jcr?: string };
    expect(filters.cas).toBe("1区");
    expect(filters.jcr).toBe("Q2");
  });

  it("keeps the raw value on Cancel and clears it on Reset", () => {
    const applied = { cas: "1区/2区", requiredArtifacts: [] };
    const snapshot = JSON.parse(JSON.stringify(applied));
    const view = mount({ filters: applied });
    const cas = view
      .byTag("select")
      .find((el) => el.getAttribute("id")?.endsWith("-cas")) as MockEl;
    expect(cas.children).toHaveLength(6);

    click(
      view
        .findAll("paper-notes-library-filter-form-button")
        .filter((el) => el.textContent === "Cancel")[0] as MockEl,
    );
    expect(view.cancels).toBe(1);
    expect(view.applies).toHaveLength(0);
    // Cancel discards the draft: the placeholder is still there afterwards.
    expect(cas.children).toHaveLength(6);

    click(view.find("paper-notes-library-filter-form-button"));
    expect(cas.children).toHaveLength(5);
    expect(view.find("paper-notes-library-filter-form-button-primary").disabled).toBe(
      false,
    );
    expect(applied).toEqual(snapshot);
  });
});

describe("artifact checkbox change events", () => {
  it("edits pending artifacts through real change events only", () => {
    const view = mount();
    const boxes = view
      .byTag("input")
      .filter((el) => el.getAttribute("type") === "checkbox");
    expect(boxes).toHaveLength(3);

    // The source listens for `change`, exactly as a native checkbox emits.
    // A synthetic mock `click` does not toggle `checked` and does not fire
    // `change`, so the pending state must not move from it.
    click(boxes[0] as MockEl);
    expect(boxes[0]?.checked).toBe(false);
    expect(view.applies).toHaveLength(0);

    // Explicitly set checked and dispatch `change`, as the DOM would.
    for (const box of boxes) {
      box.checked = true;
      box.dispatchEvent({ type: "change" });
    }
    expect(view.applies).toHaveLength(0);

    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(1);
    const filters = view.applies[0]?.filters as { requiredArtifacts: string[] };
    expect(filters.requiredArtifacts).toEqual(["pdf", "minerU", "figure"]);

    // Turning every requirement back off leaves an empty payload.
    const appliedSoFar = view.applies.length;
    for (const box of boxes) {
      box.checked = false;
      box.dispatchEvent({ type: "change" });
    }
    expect(view.applies).toHaveLength(appliedSoFar);
    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(appliedSoFar + 1);
    const empty = view.applies[view.applies.length - 1]
      ?.filters as { requiredArtifacts: string[] };
    expect(empty.requiredArtifacts).toEqual([]);
  });

  it("isolates the applied array from the emitted snapshot", () => {
    const applied = { requiredArtifacts: ["pdf"] };
    const snapshot = JSON.parse(JSON.stringify(applied));
    const view = mount({ filters: applied });

    click(view.find("paper-notes-library-filter-form-button-primary"));
    expect(view.applies).toHaveLength(1);
    const first = view.applies[0]?.filters as { requiredArtifacts: string[] };
    expect(first.requiredArtifacts).toEqual(["pdf"]);
    expect(applied.requiredArtifacts).toEqual(["pdf"]);

    // Mutating the emitted snapshot must not reach the applied filters.
    first.requiredArtifacts.push("figure");
    expect(applied.requiredArtifacts).toEqual(["pdf"]);
    expect(applied).toEqual(snapshot);

    // A second Apply still starts from the untouched applied state.
    click(view.find("paper-notes-library-filter-form-button-primary"));
    const second = view.applies[1]?.filters as { requiredArtifacts: string[] };
    expect(second.requiredArtifacts).toEqual(["pdf"]);
    expect(second.requiredArtifacts).not.toBe(first.requiredArtifacts);
  });

  it("resets after a real artifact edit without touching applied filters", () => {
    const applied = { requiredArtifacts: ["figure"] };
    const view = mount({ filters: applied });
    const pdf = view
      .byTag("input")
      .find((el) => el.getAttribute("id")?.endsWith("artifact-pdf")) as MockEl;
    pdf.checked = true;
    pdf.dispatchEvent({ type: "change" });
    expect(pdf.checked).toBe(true);
    expect(view.applies).toHaveLength(0);

    click(view.find("paper-notes-library-filter-form-button"));
    expect(view.applies).toHaveLength(0);
    // Reset clears the whole pending draft, including the requirement that
    // was inherited from the applied state.
    expect(pdf.checked).toBe(false);
    const figure = view
      .byTag("input")
      .find((el) => el.getAttribute("id")?.endsWith("artifact-figure")) as MockEl;
    expect(figure.checked).toBe(false);
    // The applied filters themselves are untouched.
    expect(applied.requiredArtifacts).toEqual(["figure"]);
  });
});

describe("journal reconciliation focus contract", () => {
  it("restores focus on the SAME button after a required reorder", () => {
    const view = mount({ journals: ["Nature", "Science"] });
    const science = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[1] as MockEl;
    science.focus();
    expect(view.root.ownerDocument.activeElement).toBe(science);

    // Reordering to [Science, Nature] necessarily moves the focused node.
    view.form.setJournalOptions(["Science", "Nature"]);
    const names = view
      .findAll("paper-notes-library-filter-form-journal-option-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["Science", "Nature"]);
    // Same node, and focus was deliberately restored onto it.
    expect(view.root.ownerDocument.activeElement).toBe(science);
    expect(science.focusCalls()).toBeGreaterThan(0);
    expect(view.applies).toHaveLength(0);
  });

  it("does not move or re-focus an already focused option on middle insert", () => {
    const view = mount({ journals: ["Nature", "Science"] });
    const science = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[1] as MockEl;
    science.focus();
    const focusBefore = science.focusCalls();

    // Inserting "Cell" in the middle must not dislodge the trailing Science.
    view.form.setJournalOptions(["Nature", "Cell", "Science"]);
    const names = view
      .findAll("paper-notes-library-filter-form-journal-option-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["Nature", "Cell", "Science"]);
    // The focused option was never moved, so focus was never dropped.
    expect(view.root.ownerDocument.activeElement).toBe(science);
    expect(science.focusCalls()).toBe(focusBefore);
    expect(view.applies).toHaveLength(0);
  });

  it("does not touch focus or nodes for an unchanged roster", () => {
    const view = mount();
    const nature = view.findAll(
      "paper-notes-library-filter-form-journal-option",
    )[0] as MockEl;
    nature.focus();
    const focusBefore = nature.focusCalls();

    view.form.setJournalOptions(["Nature", "Cell", "Science"]);
    expect(view.root.ownerDocument.activeElement).toBe(nature);
    expect(nature.focusCalls()).toBe(focusBefore);
    expect(
      view.findAll("paper-notes-library-filter-form-journal-option").length,
    ).toBe(3);
    expect(view.applies).toHaveLength(0);
  });
});
