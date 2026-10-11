/**
 * library-filter-view: REAL view wiring + REAL accepted panel/form (S3a).
 *
 * These tests exercise the actual `PaperNotesLibraryView` render path with
 * the actual accepted `LibraryFilterPanel` / `LibraryFilterForm`. The panel
 * implementation is NEVER mocked or stubbed: the view's owner contract is
 * proved against the real overlay, its real form controls and its real
 * dismissal/apply/dispose lifecycle.
 *
 * Every DOM/event primitive comes from the FROZEN, immutable helper
 * `./library-filter-test-dom` (S2a/S2b, sha256 7df5987b…), decorated by
 * `./library-filter-view-fixture` with only the seams the real view render
 * path needs. There is no second element/tree/style/window/event engine in
 * this file.
 *
 * Disclosed mock limitations — this is NOT native validation:
 *  - no real layout, geometry, computed CSS or native capture semantics;
 *    the overlay's clamped positioning is covered by the frozen S2b suite;
 *  - no native focus ring, caret, text selection or IME composition;
 *  - no native `type=number` sanitisation: `validity.badInput` is set
 *    explicitly where a test needs an unparseable value;
 *  - `pointerdown` → `click` ordering is dispatched explicitly, so gesture
 *    ORDER is modelled rather than synthesised by the host;
 *  - the frozen helper's `dispatchCaptured` walks the composed path
 *    ROOT-FIRST for both phases despite its comment, so owner-document
 *    captures use `doc.dispatch(event, "capture")` plus an explicit target
 *    `click`, which lets the tests carry a native target-first
 *    `composedPath` without rebuilding event propagation.
 *
 * The `obsidian` module itself is mocked only enough to keep the view
 * importable: its `ItemView` exposes an inert `containerEl` that the harness
 * replaces with the fixture tree before `onOpen` (the view constructor never
 * touches it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesLibraryView,
  type LibraryViewSource,
} from "../src/views/literature-library-view";
import type { PaperRecord } from "../src/types/paper";
import type { CliRunResult } from "../src/services/cli-client";
import { MetricsCache } from "../src/services/metrics-cache";
import {
  MockDocument,
  MockEl,
  MockWindow,
  ViewMockWorkspace,
  asViewEl,
  createViewDocument,
  createViewEvent,
  resetMockFocus,
  type MockPanelEvent,
  type ViewEl,
} from "./library-filter-view-fixture";

/** Dispatch a `detail: 0` click (keyboard/programmatic activation). */
function clickDetailZero(el: ViewEl): void {
  el.dispatchEvent({ type: "click", detail: 0 } as unknown as { type: string });
}

const PANEL_CLASS = "paper-notes-library-filter-panel";
const FORM_CLASS = "paper-notes-library-filter-form";
const TRIGGER_CLASS = "paper-notes-library-filter-trigger";
const COUNT_CLASS = "paper-notes-library-filter-count";
const SUMMARY_CLASS = "paper-notes-library-filter-summary";
const CLEAR_CLASS = "paper-notes-library-clear";
const DRAWER_PANEL_CLASS = "paper-notes-library-drawer-panel";
const DRAWER_CLOSE_CLASS = "paper-notes-library-drawer-close";
const SEARCH_CLASS = "paper-notes-library-search";
const TABLE_CLASS = "paper-notes-library-table";
const JOURNAL_QUERY_SUFFIX = "-journal-query";
const JOURNAL_OPTION_CLASS = `${FORM_CLASS}-journal-option`;
const APPLY_CLASS = `${FORM_CLASS}-button-primary`;
const RESET_CLASS = `${FORM_CLASS}-button`;

const NOTE_PATH = "05 Literature/nature2015/nature2015.md";
const OTHER_NOTE_PATH = "05 Literature/cell2022/cell2022.md";

// ── obsidian module mock (import-shim only) ───────────────────────────

vi.mock("obsidian", () => {
  class ItemView {
    leaf: unknown;
    app: Record<string, never> = {};
    containerEl: { empty(): void; createEl(): void; clientWidth: number };
    constructor(leaf: unknown) {
      this.leaf = leaf;
      // Inert: the harness swaps in a fixture tree before `onOpen`, and the
      // view constructor never renders through it.
      this.containerEl = {
        empty: () => {},
        createEl: () => {},
        clientWidth: 1000,
      };
    }
    open(): void {}
    async setState(): Promise<void> {}
    getState(): Record<string, unknown> {
      return {};
    }
  }

  class WorkspaceLeaf {}
  class Notice {
    constructor(public message: string) {}
  }
  class Menu {
    items: unknown[] = [];
    addItem(cb: (item: unknown) => void): this {
      const item = {
        setTitle: () => item,
        setIcon: () => item,
        setDisabled: () => item,
        onClick: () => item,
      };
      cb(item);
      this.items.push(item);
      return this;
    }
    addSeparator(): this {
      return this;
    }
    showAtMouseEvent(): void {}
    showAtPosition(): void {}
  }
  class Modal {
    constructor(public app: unknown) {}
    open(): void {}
    close(): void {}
  }

  return {
    ItemView,
    WorkspaceLeaf,
    Notice,
    Menu,
    Modal,
    setIcon: () => {},
  };
});

// ── records / source ──────────────────────────────────────────────────

function makeRecord(
  journal: string,
  year: number,
  path: string,
  key: string,
): PaperRecord {
  return {
    path,
    key,
    paperId: `550e8400-e29b-41d4-a716-${key}`,
    title: `${journal} ${year}`,
    authors: [{ family: "Doe", given: "Jane" }],
    journal,
    year,
    identifiers: { doi: `10.1000/${key}` },
    citationKeyAliases: [],
    titleAliases: [],
    abstract: "Abstract text.",
  };
}

const NATURE = makeRecord("Nature", 2015, NOTE_PATH, "nature2015");
const CELL = makeRecord("Cell", 2022, OTHER_NOTE_PATH, "cell2022");

/** Mutable record roster so tests can simulate a real source change. */
function makeSource(records: PaperRecord[]): LibraryViewSource {
  return {
    // The SAME array instance, so a test that pushes a record simulates a
    // real source change (as a vault event would) rather than a re-mount.
    getRecords: () => records,
    getInvalidRecords: () => [],
    getFrontmatter: () => undefined,
    listDirectory: () => [],
    getCards: () => [],
  };
}

// ── harness ───────────────────────────────────────────────────────────

interface Harness {
  view: PaperNotesLibraryView;
  /** Fixture document the accepted overlay mounts into. */
  doc: MockDocument;
  body: MockEl | null;
  pane: ViewEl;
  win: MockWindow | null;
  workspace: ViewMockWorkspace;
  leaf: Record<string, unknown>;
  /** Mutable record roster behind the source. */
  records: PaperRecord[];
  /** Mounted panel shell, or null when closed. */
  panel(): ViewEl | null;
  /** The mounted accepted form root. */
  form(): ViewEl;
  trigger(): ViewEl;
  /** Rendered table rows in the fixture tree. */
  rows(): ViewEl[];
  count(): ViewEl;
  summary(): ViewEl;
  search(): ViewEl;
  /** Numeric control by id suffix (real accepted form control). */
  numeric(suffix: string): ViewEl;
  journalQuery(): ViewEl;
  /** Rendered journal option names in the real accepted chooser. */
  journalOptions(): string[];
  /** Simulated native bad input for one numeric control. */
  setBadInput(suffix: string, bad: boolean): void;
  /**
   * A genuine same-pointer gesture: captured owner-document `pointerdown`
   * on the trigger, then the trigger's own `click`.
   */
  pressTrigger(): void;
  /** Dispatch a keydown at the document level. */
  key(key: string, isComposing?: boolean): MockPanelEvent;
  /** Fire the workspace active-leaf-change emitter. */
  activateLeaf(leaf: unknown): void;
  /** Total capture listeners currently on the owner document. */
  docCaptureListeners(): number;
  /** Total listeners currently on the owner window. */
  windowListeners(type: string): number;
  /**
   * Captured owner-document `pointerdown` on the trigger WITHOUT its own
   * following `click` (a gesture that never produced a click).
   */
  pressTriggerOnly(): void;
  /** Owner-private panel reference (`null` while the popup is closed). */
  ownerPanel(): unknown;
  /** Owner-private gesture registration document (`null` when detached). */
  ownerPressDocument(): unknown;
  /** Owner-private armed/consumed gesture flags. */
  ownerGesture(): { armed: boolean; consumed: boolean };
  /** Every owner document this harness ever used (asserted clean at teardown). */
  trackedDocs: MockDocument[];
  /** Every owner window this harness ever used (asserted clean at teardown). */
  trackedWindows: MockWindow[];
  /** Every workspace this harness ever hooked (asserted clean at teardown). */
  trackedWorkspaces: ViewMockWorkspace[];
  /**
   * Physically MOVE the SAME pane into a NEW owner document and adopt it,
   * registering the new document/window so teardown asserts they are clean.
   */
  adoptIntoNewDocument(): { doc: MockDocument; body: MockEl; win: MockWindow };
}

/**
 * Build a view whose container is a FIXTURE element tree attached to an
 * isolated owner document, so the real overlay mounts in that document's
 * body exactly as it would in Obsidian.
 */
/**
 * Every harness created by `mount()`, so the shared async `afterEach` can
 * close each one and assert that no owner document/window/workspace
 * resource survived — even when the test threw before its own cleanup.
 */
const mountedHarnesses: Harness[] = [];

function mount(options: { records?: PaperRecord[] } = {}): Harness {
  const { doc, body, pane } = createViewDocument();
  // A REAL owner window, so the accepted panel's viewport `resize` listener
  // is genuinely registered and its release is observable.
  const win = new MockWindow();
  doc.defaultView = win;
  const workspace = new ViewMockWorkspace();
  const trackedDocs: MockDocument[] = [doc];
  const trackedWindows: MockWindow[] = [win];
  const trackedWorkspaces: ViewMockWorkspace[] = [workspace];
  const leaf = { id: "library-leaf" };
  const records = options.records ?? [NATURE, CELL];
  const source = makeSource(records);

  const view = new PaperNotesLibraryView(
    leaf as unknown as WorkspaceLeaf,
    source,
  );

  // The view renders into `containerEl`; give it the fixture pane so the
  // real overlay geometry has a live container and the body mount is real.
  (view as unknown as { containerEl: MockEl }).containerEl = pane;
  // Expose the workspace the owner hooks, with a real emitter.
  (view as unknown as { app: { workspace: ViewMockWorkspace } }).app = {
    workspace,
  };

  const panel = (): ViewEl | null => {
    // The popup always mounts in the CURRENT owner document of the pane, so
    // a same-pane adoption is observable here too.
    const host = pane.ownerDocument.body as MockEl | null;
    if (host === null) {
      return null;
    }
    const found = host.findAllByClass(PANEL_CLASS)[0];
    return found === undefined ? null : asViewEl(found);
  };
  const form = (): ViewEl => {
    const host = pane.ownerDocument.body as MockEl | null;
    const found = host?.findAllByClass(FORM_CLASS) ?? [];
    if (found.length === 0) {
      throw new Error("accepted filter form is not mounted");
    }
    return asViewEl(found[0] as MockEl);
  };
  const trigger = (): ViewEl => asViewEl(pane.findByClass(TRIGGER_CLASS));
  const numeric = (suffix: string): ViewEl => {
    const host = pane.ownerDocument.body as MockEl | null;
    const found = (host?.findAll((el) => el.tag === "input") ?? []).filter(
      (el) => (el.getAttribute("id") ?? "").endsWith(suffix),
    );
    if (found.length !== 1) {
      throw new Error(`expected one input for ${suffix}, got ${found.length}`);
    }
    return asViewEl(found[0] as MockEl);
  };

  const harness: Harness = {
    view,
    doc,
    body,
    pane,
    win: doc.defaultView,
    workspace,
    leaf,
    records,
    panel,
    form,
    trigger,
    rows: () => {
      const table = pane.findAllByClass(TABLE_CLASS)[0];
      if (table === undefined) {
        return [];
      }
      return table
        .findAll(
          (el) => el.tag === "tr" && el.attrs.has("data-paper-notes-library-path"),
        )
        .map((el) => asViewEl(el));
    },
    count: () => asViewEl(trigger().findAllByClass(COUNT_CLASS)[0] as MockEl),
    summary: () => asViewEl(pane.findByClass(SUMMARY_CLASS)),
    search: () => asViewEl(pane.findByClass(SEARCH_CLASS)),
    numeric,
    journalQuery: () => numeric(JOURNAL_QUERY_SUFFIX),
    journalOptions: () =>
      // The frozen helper's `textContent` is a plain field with no
      // descendant aggregation, and the accepted chooser puts each name in
      // an inner `.…-journal-option-name` span, so read that span.
      form()
        .findAllByClass(JOURNAL_OPTION_CLASS)
        .map((el) => el.querySelector(`.${FORM_CLASS}-journal-option-name`)?.textContent ?? ""),
    setBadInput: (suffix, bad) => {
      numeric(suffix).validity = { badInput: bad };
    },
    pressTrigger: () => {
      const el = trigger();
      // A genuine same-pointer gesture: the captured owner-document press
      // runs first (the panel dismisses itself on capture), then the
      // trigger's own click arrives.
      doc.dispatch(
        createViewEvent({
          type: "pointerdown",
          target: el,
          composedPath: () => [el],
        }),
        "capture",
      );
      el.dispatchEvent({ type: "click", detail: 1 } as unknown as { type: string });
    },
    key: (key, isComposing = false) => {
      const event = createViewEvent({
        type: "keydown",
        key,
        isComposing,
        target: body ?? pane,
        composedPath: () => [body ?? pane],
      });
      doc.dispatch(event, "capture");
      return event;
    },
    activateLeaf: (other) => workspace.emit("active-leaf-change", other),
    docCaptureListeners: () =>
      doc.listenerCount("pointerdown", true) +
      doc.listenerCount("pointercancel", true) +
      doc.listenerCount("keydown", true) +
      doc.listenerCount("scroll", true),
    windowListeners: (type) => doc.defaultView?.listenerCount(type) ?? 0,
    pressTriggerOnly: () => {
      const el = trigger();
      doc.dispatch(
        createViewEvent({
          type: "pointerdown",
          target: el,
          composedPath: () => [el],
        }),
        "capture",
      );
    },
    ownerPanel: () => (view as unknown as { filterPanel: unknown }).filterPanel,
    ownerPressDocument: () =>
      (view as unknown as { filterPressDocument: unknown }).filterPressDocument,
    ownerGesture: () => {
      const state = view as unknown as {
        filterPointerPressArmed: boolean;
        filterPointerPressConsumed: boolean;
      };
      return {
        armed: state.filterPointerPressArmed,
        consumed: state.filterPointerPressConsumed,
      };
    },
    adoptIntoNewDocument: () => {
      const next = createViewDocument();
      const nextWin = new MockWindow();
      next.doc.defaultView = nextWin;
      const nextBody = next.body as MockEl;
      // Reparenting alone never changes `ownerDocument`, and adopting alone
      // never reparents: a genuine migration needs BOTH, in this order.
      nextBody.appendChild(pane);
      pane.adoptBy(next.doc);
      trackedDocs.push(next.doc);
      trackedWindows.push(nextWin);
      // The SAME pane is genuinely reparented into the new body AND reports
      // the new owner document while remaining connected.
      expect(nextBody.contains(pane)).toBe(true);
      expect(pane.ownerDocument).toBe(next.doc);
      expect(pane.isConnected).toBe(true);
      return { doc: next.doc, body: nextBody, win: nextWin };
    },
    trackedDocs,
    trackedWindows,
    trackedWorkspaces,
  };
  mountedHarnesses.push(harness);
  return harness;
}

/** Row count rendered by the real view. */
function rowCount(h: Harness): number {
  return h.rows().length;
}

/** Click an element inside the fixture tree. */
function click(el: MockEl): void {
  el.dispatchEvent({ type: "click" });
}

/** Type into a real accepted form control. */
function typeInto(el: MockEl, value: string): void {
  el.value = value;
  el.dispatchEvent({ type: "input" });
}

/** The real accepted Apply button. */
function applyButton(h: Harness): MockEl {
  return h.form().findAllByClass(APPLY_CLASS)[0] as MockEl;
}

/** The real accepted Reset button (footer, first plain button). */
function resetButton(h: Harness): MockEl {
  return h.form().findAllByClass(RESET_CLASS)[0] as MockEl;
}

/** Whether an HTML boolean attribute is PRESENT. */
function hasAttr(el: MockEl, name: string): boolean {
  return el.attrs.has(name);
}

afterEach(async () => {
  const failures: string[] = [];
  for (const h of mountedHarnesses) {
    try {
      // Idempotent: closing an already-closed view is a no-op, so cleanup
      // continues for every harness even when one of them throws.
      await h.view.onClose();
    } catch (error) {
      failures.push(`close: ${String(error)}`);
    }
    try {
      for (const doc of h.trackedDocs) {
        expect(doc.listenerTotal()).toBe(0);
      }
      for (const win of h.trackedWindows) {
        let total = 0;
        for (const type of [
          "resize",
          "scroll",
          "keydown",
          "pointerdown",
          "pointercancel",
        ]) {
          total += win.listenerCount(type);
        }
        expect(total).toBe(0);
      }
      for (const workspace of h.trackedWorkspaces) {
        expect(workspace.listenerCount("active-leaf-change")).toBe(0);
      }
    } catch (error) {
      failures.push(`resources: ${String(error)}`);
    }
  }
  mountedHarnesses.length = 0;
  resetMockFocus();
  vi.restoreAllMocks();
  if (failures.length > 0) {
    throw new Error(`harness teardown failed: ${failures.join(" | ")}`);
  }
});

// ── 1. visible applied badge / summary ────────────────────────────────

describe("applied badge and summary visibility", () => {
  it("removes the boolean attribute entirely when active and sets it when inactive", async () => {
    const h = mount();
    await h.view.onOpen();

    // Inactive: the attribute is PRESENT (native hidden semantics).
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(h.count().hidden).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
    expect(h.summary().hidden).toBe(true);

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));

    // Active: the attribute is ABSENT, so the applied information is
    // actually visible (no `hidden=""`, no CSS override needed).
    expect(hasAttr(h.count(), "hidden")).toBe(false);
    expect(h.count().hidden).toBe(false);
    expect(h.count().textContent).toBe("1");
    expect(hasAttr(h.summary(), "hidden")).toBe(false);
    expect(h.summary().hidden).toBe(false);
    expect(h.summary().textContent).toBe("Year from 2020");
  });

  it("keeps the badge/summary invisible while only PENDING values are typed", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    for (const raw of ["2", "20", "200", "2020"]) {
      typeInto(h.numeric("yearFrom"), raw);
      expect(hasAttr(h.count(), "hidden")).toBe(true);
      expect(hasAttr(h.summary(), "hidden")).toBe(true);
      expect(h.count().textContent).toBe("");
      expect(h.summary().textContent).toBe("");
    }
    // Discarding the pending draft changes nothing.
    h.key("Escape");
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
  });

  it("re-hides both when the applied filters are cleared", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(hasAttr(h.count(), "hidden")).toBe(false);

    click(h.pane.findByClass(CLEAR_CLASS));
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
  });

  it("renders one labelled entry and no inline primary/advanced filter bars", async () => {
    const h = mount();
    await h.view.onOpen();
    const entries = h.pane.findAllByClass(TRIGGER_CLASS);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as MockEl;
    expect(entry.getAttribute("aria-haspopup")).toBe("dialog");
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(entry.getAttribute("aria-label")).toBe("Library filters");
    expect(h.pane.findAllByClass("paper-notes-library-filters")).toHaveLength(0);
    expect(h.pane.findAllByClass("paper-notes-library-filters-advanced")).toHaveLength(0);
    expect(h.pane.findAllByClass("paper-notes-library-filter-chip")).toHaveLength(0);
    expect(h.pane.findAllByClass("paper-notes-library-reading-select")).toHaveLength(0);
  });

  it("exposes the applied summary through the trigger's accessible name", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(h.trigger().getAttribute("aria-label")).toBe(
      "Library filters, 1 active: Year from 2020",
    );
  });
});

// ── 2. trigger gestures ───────────────────────────────────────────────

describe("trigger gesture bookkeeping", () => {
  it("closes on the same captured open-trigger pointerdown WITHOUT reopening", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    expect(h.panel()).not.toBeNull();

    // A genuine same-pointer gesture on the open trigger.
    h.pressTrigger();
    expect(h.panel()).toBeNull();
    expect(h.trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on the FIRST keyboard activation after an open-trigger press was cancelled", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    expect(h.panel()).not.toBeNull();

    // Press the trigger, then CANCEL the gesture: no click is produced.
    const el = h.trigger();
    h.doc.dispatch(
      createViewEvent({
        type: "pointerdown",
        target: el,
        composedPath: () => [el],
      }),
      "capture",
    );
    // The popup dismissed on that captured press; the cancel disarms the
    // gesture so nothing is suppressed.
    h.doc.dispatch(
      createViewEvent({ type: "pointercancel", target: el, composedPath: () => [el] }),
      "capture",
    );
    expect(h.panel()).toBeNull();

    // A keyboard/programmatic activation (detail 0) must OPEN immediately.
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
    expect(h.trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens on the FIRST keyboard activation after an open-trigger drag produced no click", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    expect(h.panel()).not.toBeNull();

    // Press the trigger and drag away: the captured press dismisses the
    // popup, and no click ever reaches the trigger.
    const el = h.trigger();
    h.doc.dispatch(
      createViewEvent({
        type: "pointerdown",
        target: el,
        composedPath: () => [el],
      }),
      "capture",
    );
    // The same pointer MOVES off the trigger and releases elsewhere. No
    // second press, no cancel and no trigger click are produced: the drag
    // never becomes an activation, so the gesture is not suppressed.
    const search = h.search();
    h.doc.dispatch(
      createViewEvent({
        type: "pointermove",
        target: search,
        composedPath: () => [search],
      }),
      "capture",
    );
    h.doc.dispatch(
      createViewEvent({
        type: "pointerup",
        target: search,
        composedPath: () => [search],
      }),
      "capture",
    );
    expect(h.panel()).toBeNull();

    // The FIRST explicit detail-0 activation must OPEN.
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
    expect(h.trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("supports repeated clean pointer and keyboard toggles", async () => {
    const h = mount();
    await h.view.onOpen();

    // Pointer toggle pair.
    click(h.trigger());
    expect(h.panel()).not.toBeNull();
    h.pressTrigger();
    expect(h.panel()).toBeNull();

    // Keyboard toggle pair (each activation is a fresh detail-0 click).
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
    clickDetailZero(h.trigger());
    expect(h.panel()).toBeNull();

    // Pointer again, then keyboard again: no cross-contamination.
    click(h.trigger());
    expect(h.panel()).not.toBeNull();
    h.pressTrigger();
    expect(h.panel()).toBeNull();
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
  });

  it("treats an unrelated outside press as a plain dismissal and stays closable", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    const search = h.search();
    h.doc.dispatch(
      createViewEvent({
        type: "pointerdown",
        target: search,
        composedPath: () => [search],
      }),
      "capture",
    );
    expect(h.panel()).toBeNull();
    // The gesture was disarmed, so the next activation opens.
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
  });
});

// ── 3. document ownership ─────────────────────────────────────────────

describe("owner-document adoption", () => {
  it("silently discards the OPEN popup and its original document/window resources when a FULL render physically adopts the pane into a new document", async () => {
    const h = mount();
    await h.view.onOpen();
    // An applied filter plus a main query that must BOTH survive migration.
    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });
    // The main query ALONE still matches the single Nature row.
    expect(rowCount(h)).toBe(1);
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(h.count().textContent).toBe("1");
    // Applying `yearFrom 2020` excludes the 2015 Nature record, so the
    // applied view legitimately has NO rows left.
    expect(rowCount(h)).toBe(0);

    // A pending, UNAPPLIED draft that must be discarded.
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");
    const oldPanel = h.panel();
    const oldBody = h.body as MockEl;
    const oldDoc = h.doc;
    const oldWin = h.doc.defaultView as MockWindow;
    const oldTrigger = h.trigger();
    // Positive BEFORE controls: the connected popup really owns listeners on
    // the OLD document and the OLD window.
    expect(oldPanel).not.toBeNull();
    expect(oldPanel?.isConnected).toBe(true);
    expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(1);
    expect(oldDoc.listenerCount("pointerdown", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("pointercancel", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("keydown", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("scroll", true)).toBeGreaterThan(0);
    expect(oldWin.listenerCount("resize")).toBeGreaterThan(0);
    const oldTriggerFocusBefore = oldTrigger.focusCalls();

    // SAME pane, physically MOVED into a NEW owner document, then adopted.
    const next = h.adoptIntoNewDocument();
    h.view.refresh();

    // Silent discard: no focus on the old OR the new trigger.
    expect(oldTrigger.focusCalls()).toBe(oldTriggerFocusBefore);
    expect(h.trigger().focusCalls()).toBe(0);
    // The OLD connected popup is physically gone from the OLD body.
    expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(0);
    expect(oldPanel?.isConnected).toBe(false);
    // Owner reference cleared and the NEW body has NO popup BEFORE reopen.
    expect(h.ownerPanel()).toBeNull();
    expect(next.body.findAllByClass(PANEL_CLASS).length).toBe(0);
    // Exact zero original-document and original-window resources.
    expect(oldDoc.listenerCount("pointerdown", true)).toBe(0);
    expect(oldDoc.listenerCount("pointercancel", true)).toBe(0);
    expect(oldDoc.listenerCount("keydown", true)).toBe(0);
    expect(oldDoc.listenerCount("scroll", true)).toBe(0);
    expect(oldDoc.listenerTotal()).toBe(0);
    expect(oldWin.listenerCount("resize")).toBe(0);
    expect(oldWin.listenerCount("scroll")).toBe(0);
    // Applied filters and the main query survive; the pending draft does not.
    expect(h.count().textContent).toBe("1");
    expect(h.search().value).toBe("nature");
    expect(rowCount(h)).toBe(0);
    // FIRST new-document activation (detail 0) reopens the APPLIED 2020.
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
    expect(h.numeric("yearFrom").value).toBe("2020");
  });

  it("silently discards the OPEN popup on a LIGHTWEIGHT refreshData after a physical pane adoption", async () => {
    const h = mount();
    await h.view.onOpen();
    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");

    const oldPanel = h.panel();
    const oldBody = h.body as MockEl;
    const oldDoc = h.doc;
    const oldWin = h.doc.defaultView as MockWindow;
    const oldTrigger = h.trigger();
    expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(1);
    expect(oldPanel?.isConnected).toBe(true);
    expect(oldDoc.listenerCount("pointerdown", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("pointercancel", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("keydown", true)).toBeGreaterThan(0);
    expect(oldDoc.listenerCount("scroll", true)).toBeGreaterThan(0);
    expect(oldWin.listenerCount("resize")).toBeGreaterThan(0);
    const triggerFocusBefore = oldTrigger.focusCalls();

    const next = h.adoptIntoNewDocument();
    h.view.refreshData();

    // The lightweight path keeps the SAME trigger node and never focuses it.
    expect(h.trigger()).toBe(oldTrigger);
    expect(oldTrigger.focusCalls()).toBe(triggerFocusBefore);
    expect(h.trigger().focusCalls()).toBe(triggerFocusBefore);
    expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(0);
    expect(oldPanel?.isConnected).toBe(false);
    expect(h.ownerPanel()).toBeNull();
    expect(next.body.findAllByClass(PANEL_CLASS).length).toBe(0);
    expect(oldDoc.listenerTotal()).toBe(0);
    expect(oldWin.listenerCount("resize")).toBe(0);
    expect(oldWin.listenerCount("scroll")).toBe(0);
    expect(h.count().textContent).toBe("1");
    expect(h.search().value).toBe("nature");
    clickDetailZero(h.trigger());
    expect(h.panel()).not.toBeNull();
    expect(h.numeric("yearFrom").value).toBe("2020");
  });

  it("releases the original document AND window resources on view close", async () => {
    const h = mount();
    // The harness already attached a TRACKED owner window at mount, so the
    // accepted panel really registers its viewport listener and the window
    // stays tracked by the shared teardown.
    expect(h.doc.defaultView).not.toBeNull();
    await h.view.onOpen();
    click(h.trigger());
    const docBefore = h.docCaptureListeners();
    expect(docBefore).toBeGreaterThan(0);
    expect(h.windowListeners("resize")).toBeGreaterThan(0);

    await h.view.onClose();

    expect(h.panel()).toBeNull();
    // Document capture resources are released.
    expect(h.docCaptureListeners()).toBe(0);
    // The original window resource is released too.
    expect(h.windowListeners("resize")).toBe(0);
    // The workspace ownership listener is released too.
    expect(h.workspace.listenerCount("active-leaf-change")).toBe(0);
  });
});

// ── 3b. CLOSED popup same-pane migration matrix ───────────────────────

/**
 * CLOSED-popup same-pane migration: the popup is dismissed BEFORE the pane
 * is physically moved into a new owner document, so the owner holds only
 * its own pointerdown/pointercancel bookkeeping on the OLD document
 * (`filterPanel === null`). Migration must release exactly those resources
 * and clear the gesture, so the FIRST detail-0 activation in the new
 * document opens the APPLIED snapshot with no press/cancel workaround.
 */
async function closedMigrationScenario(
  dismiss: "escape" | "press",
  refresh: "full" | "light",
): Promise<void> {
  const h = mount();
  await h.view.onOpen();
  h.search().value = "nature";
  h.search().dispatchEvent({ type: "input" });
  click(h.trigger());
  typeInto(h.numeric("yearFrom"), "2020");
  click(applyButton(h));
  expect(h.count().textContent).toBe("1");

  click(h.trigger());
  typeInto(h.numeric("yearFrom"), "1999");
  if (dismiss === "escape") {
    h.key("Escape");
  } else {
    // Captured owner-document press on the trigger with NO following click.
    h.pressTriggerOnly();
  }
  expect(h.panel()).toBeNull();
  expect(h.ownerPanel()).toBeNull();

  const oldBody = h.body as MockEl;
  const oldDoc = h.doc;
  const oldWin = h.doc.defaultView as MockWindow;
  const oldTrigger = h.trigger();
  // The popup is already CLOSED, yet the owner's capture press/cancel
  // listeners MUST still be registered on the OLD document.
  expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(0);
  expect(oldDoc.listenerCount("pointerdown", true)).toBeGreaterThan(0);
  expect(oldDoc.listenerCount("pointercancel", true)).toBeGreaterThan(0);
  expect(oldWin.listenerCount("resize")).toBe(0);
  expect(oldWin.listenerCount("scroll")).toBe(0);
  const triggerFocusBefore = oldTrigger.focusCalls();

  const next = h.adoptIntoNewDocument();
  if (refresh === "full") {
    h.view.refresh();
  } else {
    h.view.refreshData();
  }

  // Exact zero OLD document/window resources and a CLEARED gesture BEFORE
  // any activation in the new document (no press/cancel workaround).
  expect(oldDoc.listenerCount("pointerdown", true)).toBe(0);
  expect(oldDoc.listenerCount("pointercancel", true)).toBe(0);
  expect(oldDoc.listenerCount("keydown", true)).toBe(0);
  expect(oldDoc.listenerCount("scroll", true)).toBe(0);
  expect(oldDoc.listenerTotal()).toBe(0);
  expect(oldWin.listenerCount("resize")).toBe(0);
  expect(oldWin.listenerCount("scroll")).toBe(0);
  expect(h.ownerPressDocument()).toBeNull();
  expect(h.ownerGesture()).toEqual({ armed: false, consumed: false });
  expect(h.ownerPanel()).toBeNull();
  expect(oldBody.findAllByClass(PANEL_CLASS).length).toBe(0);
  expect(next.body.findAllByClass(PANEL_CLASS).length).toBe(0);
  expect(h.count().textContent).toBe("1");
  expect(h.search().value).toBe("nature");

  // Silent migration moved no focus: the FULL refresh created a fresh,
  // never-focused trigger; the LIGHT refresh kept the original trigger.
  const currentTrigger = h.trigger();
  if (refresh === "full") {
    expect(currentTrigger).not.toBe(oldTrigger);
    expect(currentTrigger.focusCalls()).toBe(0);
  } else {
    expect(currentTrigger).toBe(oldTrigger);
    expect(currentTrigger.focusCalls()).toBe(triggerFocusBefore);
  }
  // FIRST activation in the new document: no new press/cancel workaround.
  clickDetailZero(h.trigger());
  expect(h.panel()).not.toBeNull();
  expect(h.numeric("yearFrom").value).toBe("2020");
  expect(oldTrigger.focusCalls()).toBe(triggerFocusBefore);
}

describe("CLOSED popup same-pane migration matrix", () => {
  it("releases the original resources for an Escape dismissal under a FULL refresh", async () => {
    await closedMigrationScenario("escape", "full");
  });

  it("releases the original resources for an Escape dismissal under a LIGHT refresh", async () => {
    await closedMigrationScenario("escape", "light");
  });

  it("releases the original resources for a press-without-click dismissal under a FULL refresh", async () => {
    await closedMigrationScenario("press", "full");
  });

  it("releases the original resources for a press-without-click dismissal under a LIGHT refresh", async () => {
    await closedMigrationScenario("press", "light");
  });
});

// ── 4. Clear hands focus to the live replacement trigger ──────────────

describe("toolbar Clear focus handoff", () => {
  it("discards pending silently, clears applied, renders, and focuses the NEW live trigger", async () => {
    const h = mount();
    await h.view.onOpen();

    // A real main search query plus a real applied filter, so Clear is
    // enabled and the old trigger really is detached by the render.
    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(h.count().textContent).toBe("1");

    const oldTrigger = h.trigger();
    const oldFocusBefore = oldTrigger.focusCalls();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");
    expect(h.panel()).not.toBeNull();

    click(h.pane.findByClass(CLEAR_CLASS));

    // The old trigger received NO NEW focus call from the Clear path.
    expect(oldTrigger.focusCalls()).toBe(oldFocusBefore);
    // The replacement is connected, focused, and reports no focus calls on
    // any dead node.
    const next = h.trigger();
    expect(next).not.toBe(oldTrigger);
    expect(next.isConnected).toBe(true);
    expect(h.doc.activeElement).toBe(next);
    // Applied cleared, main query preserved.
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(h.search().value).toBe("nature");
  });

  it("never focuses a dead or hidden trigger when the owner is going away", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));

    // A pending popup is discarded by a real view close. The accepted panel's
    // own close path may focus the live trigger, but the OWNER never focuses
    // anything itself and never touches a detached node.
    const live = h.trigger();
    await h.view.onClose();

    expect(h.panel()).toBeNull();
    // The owner's Clear-style handoff never ran, and the trigger that was
    // live at close time is now detached.
    expect(live.isConnected).toBe(false);
  });
});

// ── 5. pending draft, atomic apply, dismissal ─────────────────────────

describe("raw partial typing never changes applied results", () => {
  it("keeps applied results/count unchanged through 2 → 20 → 200 → 2020 until Apply", async () => {
    const h = mount();
    await h.view.onOpen();
    const before = rowCount(h);
    click(h.trigger());

    const input = h.numeric("yearFrom");
    for (const raw of ["2", "20", "200", "2020"]) {
      typeInto(input, raw);
      // The real input node is never recreated and keeps its raw text.
      expect(h.numeric("yearFrom")).toBe(input);
      expect(input.value).toBe(raw);
      expect(hasAttr(h.count(), "hidden")).toBe(true);
      expect(rowCount(h)).toBe(before);
    }

    click(applyButton(h));
    expect(rowCount(h)).toBe(1);
    expect(h.count().textContent).toBe("1");
  });

  it("refuses an invalid draft and keeps the popup open", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "20");
    expect(applyButton(h).disabled).toBe(true);
    click(applyButton(h));
    expect(h.panel()).not.toBeNull();
    expect(rowCount(h)).toBe(2);
    expect(hasAttr(h.count(), "hidden")).toBe(true);
  });

  it("rejects a native badInput value rather than reading it as unbounded", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    // The browser sanitises an unparseable `type=number` value to "" and
    // reports `validity.badInput`; the form must forward that instead of
    // reading the empty value as "unbounded".
    const input = h.numeric("yearFrom");
    input.validity = { badInput: true };
    typeInto(input, "");
    expect(applyButton(h).disabled).toBe(true);
    click(applyButton(h));
    expect(h.panel()).not.toBeNull();
    expect(rowCount(h)).toBe(2);
  });

  it("applies a complete 2001–2021 interval atomically in one group", async () => {
    const h = mount();
    await h.view.onOpen();
    const before = rowCount(h);
    expect(before).toBe(2);
    click(h.trigger());
    const from = h.numeric("yearFrom");
    const to = h.numeric("yearTo");

    // Both endpoints are typed as raw text; nothing is applied yet.
    typeInto(from, "2001");
    typeInto(to, "2021");
    expect(h.numeric("yearFrom")).toBe(from);
    expect(h.numeric("yearTo")).toBe(to);
    expect(from.value).toBe("2001");
    expect(to.value).toBe("2021");
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
    expect(rowCount(h)).toBe(before);

    const oldTrigger = h.trigger();
    click(applyButton(h));

    // ONE atomic Apply: the popup closed, exactly the Nature row, ONE interval
    // group with a readable summary, and focus on the live replacement.
    expect(h.panel()).toBeNull();
    expect(rowCount(h)).toBe(1);
    expect(h.count().textContent).toBe("1");
    expect(hasAttr(h.count(), "hidden")).toBe(false);
    expect(h.summary().textContent).toBe("Year 2001–2021");
    expect(hasAttr(h.summary(), "hidden")).toBe(false);
    expect(h.trigger()).not.toBe(oldTrigger);
    expect(h.trigger().isConnected).toBe(true);
    expect(h.doc.activeElement).toBe(h.trigger());

    // Reopening retains BOTH endpoints of the applied interval.
    click(h.trigger());
    expect(h.numeric("yearFrom").value).toBe("2001");
    expect(h.numeric("yearTo").value).toBe("2021");
  });
});

describe("Apply commits once through the real render path", () => {
  it("re-renders the table and focuses the newly created live trigger", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    const firstTrigger = h.trigger();
    typeInto(h.numeric("yearFrom"), "2010");

    const option = h
      .form()
      .findAllByClass(JOURNAL_OPTION_CLASS)
      .map((el) => asViewEl(el))
      .find((el) => el.querySelector(`.${FORM_CLASS}-journal-option-name`)?.textContent === "Nature");
    expect(option).toBeDefined();
    click(option as MockEl);

    click(applyButton(h));

    // The render replaced the trigger node; the new one is live and focused.
    expect(h.trigger()).not.toBe(firstTrigger);
    expect(h.doc.activeElement).toBe(h.trigger());
    expect(h.panel()).toBeNull();
    expect(rowCount(h)).toBe(1);
    expect(h.summary().textContent).toBe("Year from 2010 · Journal: Nature");
  });
});

describe("popup survives real rerender / refreshData", () => {
  it("keeps the same shell, numeric node, raw draft and activeElement across render()", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    const shell = h.panel();
    const input = h.numeric("yearFrom");
    typeInto(input, "200");
    input.focus();

    h.view.refresh();

    expect(h.panel()).toBe(shell);
    expect(h.numeric("yearFrom")).toBe(input);
    expect(input.value).toBe("200");
    expect(h.doc.activeElement).toBe(input);
    expect(rowCount(h)).toBe(2);
  });

  it("keeps the popup and journal lookup across refreshData", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    const shell = h.panel();
    const input = h.numeric("yearFrom");
    typeInto(input, "19");
    typeInto(h.journalQuery(), "zzz-nothing-matches");

    h.view.refreshData();

    expect(h.panel()).toBe(shell);
    expect(h.numeric("yearFrom")).toBe(input);
    expect(input.value).toBe("19");
    // The lookup text is preserved (it is never a filter).
    expect(h.journalQuery().value).toBe("zzz-nothing-matches");
  });
});

// ── 5b. drawer auto-focus vs an OPEN filter popup ─────────────────────

/**
 * The real Detail Drawer moves focus to its freshly created Close button so
 * keyboard users land inside the drawer. That automatic move must NOT run
 * while an open Library Filters popup owns focus: a real view refresh while a
 * pending draft is being edited would otherwise steal `activeElement` from the
 * popup's input. Both scenarios below run against the REAL view render path,
 * the REAL drawer and the REAL accepted panel/form — no render shortcut and
 * no explicit refocus is used as evidence.
 */
describe("drawer auto-focus defers to an open filter popup", () => {
  it("keeps the drawer Close focus when no popup is open, but never steals the popup input focus across a real view refresh", async () => {
    const h = mount();
    await h.view.onOpen();
    expect(rowCount(h)).toBe(2);

    // Positive control (popup ABSENT): the real authored detail-open route
    // opens the real drawer and moves focus to its new Close button.
    h.view.openPaperDetail(NATURE.key, NATURE.path);
    const firstPanel = asViewEl(h.pane.findByClass(DRAWER_PANEL_CLASS));
    const firstClose = asViewEl(h.pane.findByClass(DRAWER_CLOSE_CLASS));
    expect(firstPanel.isConnected).toBe(true);
    expect(firstClose.isConnected).toBe(true);
    expect(firstClose.focusCalls()).toBe(1);
    expect(h.doc.activeElement).toBe(firstClose);

    // Negative witness (popup OPEN): a real refresh rebuilds the still-open
    // drawer while the popup's pending-draft input holds focus.
    click(h.trigger());
    const shell = h.panel();
    expect(shell).not.toBeNull();
    const input = h.numeric("yearFrom");
    typeInto(input, "1999");
    input.focus();
    expect(h.doc.activeElement).toBe(input);
    const oldTrigger = h.trigger();

    // A REAL source change (as a vault event would produce), so the refresh
    // is proven to have actually re-rendered results rather than merely
    // re-focused something.
    h.records.push(
      makeRecord("eLife", 2023, "05 Literature/elife/elife.md", "elife2023"),
    );
    h.view.refresh();

    // The real refresh ran: a fresh live trigger, re-rendered rows and an
    // updated all-source journal roster.
    expect(h.trigger()).not.toBe(oldTrigger);
    expect(h.trigger().isConnected).toBe(true);
    expect(oldTrigger.isConnected).toBe(false);
    expect(rowCount(h)).toBe(3);
    expect(h.journalOptions()).toContain("eLife");

    // The open drawer really WAS rebuilt, so its Close button is a NEW node
    // that the automatic focus would have targeted ...
    const rebuiltPanel = asViewEl(h.pane.findByClass(DRAWER_PANEL_CLASS));
    const rebuiltClose = asViewEl(h.pane.findByClass(DRAWER_CLOSE_CLASS));
    expect(rebuiltPanel).not.toBe(firstPanel);
    expect(rebuiltClose).not.toBe(firstClose);
    expect(rebuiltPanel.isConnected).toBe(true);
    expect(firstClose.isConnected).toBe(false);

    // ... yet that focus was DEFERRED (no focus call at all, not a refocus),
    // and the pending popup input kept its identity, raw draft and
    // activeElement across the real refresh.
    expect(rebuiltClose.focusCalls()).toBe(0);
    expect(h.doc.activeElement).not.toBe(rebuiltClose);
    expect(h.panel()).toBe(shell);
    expect(h.numeric("yearFrom")).toBe(input);
    expect(input.value).toBe("1999");
    expect(h.doc.activeElement).toBe(input);
    // The pending draft was never committed by the refresh.
    expect(hasAttr(h.count(), "hidden")).toBe(true);
  });
});

describe("dismiss / pending Reset / immediate toolbar Clear", () => {
  it("discards a pending draft on dismissal and reopens from the applied snapshot", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(h.count().textContent).toBe("1");

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");
    h.key("Escape");
    expect(h.panel()).toBeNull();
    expect(h.count().textContent).toBe("1");
    expect(rowCount(h)).toBe(1);

    click(h.trigger());
    expect(h.numeric("yearFrom").value).toBe("2020");
  });

  it("keeps pending Reset local: applied filters and the popup stay", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");
    click(resetButton(h));

    expect(h.panel()).not.toBeNull();
    expect(h.numeric("yearFrom").value).toBe("");
    expect(h.count().textContent).toBe("1");
    expect(rowCount(h)).toBe(1);
  });

  it("toolbar Clear cancels the pending popup, clears applied and keeps the main query", async () => {
    const h = mount();
    await h.view.onOpen();
    h.search().value = "zzz-no-match";
    h.search().dispatchEvent({ type: "input" });
    expect(rowCount(h)).toBe(0);

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");

    click(h.pane.findByClass(CLEAR_CLASS));

    expect(h.panel()).toBeNull();
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
    expect(h.search().value).toBe("zzz-no-match");
    expect(rowCount(h)).toBe(0);
  });
});

// ── 6. owner lifetime ─────────────────────────────────────────────────

describe("owner lifetime", () => {
  it("discards the popup when leaving the Library page and keeps applied filters", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(rowCount(h)).toBe(1);

    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "1999");
    expect(h.panel()).not.toBeNull();

    h.view.showPage("moc");
    expect(h.panel()).toBeNull();

    h.view.showPage("library");
    expect(h.count().textContent).toBe("1");
    expect(rowCount(h)).toBe(1);
  });

  it("discards the popup when this leaf stops being the active leaf", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    expect(h.panel()).not.toBeNull();

    h.activateLeaf({ id: "some-other-leaf" });
    expect(h.panel()).toBeNull();

    h.activateLeaf(h.leaf);
    expect(h.panel()).toBeNull();
  });

  it("disposes the popup on a real view close and resets applied filters on reopen", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));
    expect(h.count().textContent).toBe("1");

    await h.view.onClose();
    expect(h.panel()).toBeNull();
    expect(h.docCaptureListeners()).toBe(0);

    await h.view.onOpen();
    expect(h.panel()).toBeNull();
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(rowCount(h)).toBe(2);
  });
});

// ── 7. all-source roster under an ACTUAL main search ──────────────────

describe("journal roster comes from ALL source records", () => {
  it("offers journals excluded by the actual main search", async () => {
    const h = mount();
    await h.view.onOpen();
    // The main search matches only the Nature row, so Cell is excluded from
    // the table but must remain selectable in the popup roster.
    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });
    expect(rowCount(h)).toBe(1);

    click(h.trigger());
    expect(h.journalOptions()).toContain("Nature");
    expect(h.journalOptions()).toContain("Cell");
  });

  it("offers a journal added to the source after the view opened", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    expect(h.journalOptions()).not.toContain("eLife");

    // A real source change (e.g. a vault event), not a re-mount.
    h.records.push(makeRecord("eLife", 2023, "05 Literature/elife/elife.md", "elife2023"));
    h.view.refreshData();

    expect(h.panel()).not.toBeNull();
    expect(h.journalOptions()).toContain("eLife");
    expect(h.journalOptions()).toContain("Nature");
    expect(h.journalOptions()).toContain("Cell");
  });

  it("keeps the shell, inputs, raw draft and activeElement across an async metrics refresh", async () => {
    const h = mount();
    await h.view.onOpen();
    // The main search matches only the Nature row, so Cell and eLife stay out
    // of the table while remaining in the all-source journal roster.
    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });
    expect(rowCount(h)).toBe(1);

    click(h.trigger());
    const shell = h.panel();
    const input = h.numeric("yearFrom");
    const lookup = h.journalQuery();
    typeInto(input, "19");
    typeInto(lookup, "nat");
    input.focus();
    const oldTrigger = h.trigger();
    expect(shell).not.toBeNull();

    // A genuine deferred OFFLINE provider: it records its real argv, signals
    // when the first call begins and awaits a separately controlled release.
    // No process, network or filesystem call is ever made.
    let releaseRun!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const runArgs: string[][] = [];
    let runCalls = 0;
    let loadCalls = 0;
    const saved: unknown[] = [];
    const cache = new MetricsCache({
      client: {
        run: async (args: string[]): Promise<CliRunResult> => {
          runCalls += 1;
          runArgs.push([...args]);
          if (runCalls === 1) {
            signalEntered();
          }
          await released;
          return {
            envelope: {
              protocol_version: 1,
              status: "success",
              data: {
                metrics: {
                  metrics: {
                    if: 5.1,
                    jci: 1,
                    cas_partition: "中科院1区",
                    jcr_partition: "Q1",
                  },
                },
              },
              warnings: [],
              errors: [],
            },
            exitCode: 0,
            stderr: "",
          };
        },
      },
      ttlDays: () => 30,
      enabled: () => true,
      load: async () => {
        loadCalls += 1;
        return undefined;
      },
      save: async (payload: unknown) => {
        saved.push(payload);
      },
      now: () => 1_800_000_000_000,
    });
    await cache.initialize();
    expect(loadCalls).toBe(1);

    // Narrow test-local binding of the REAL production cache into the view's
    // existing private seam. The production getter, async caller, render path
    // and metrics service itself are never faked or overridden.
    const owner = h.view as unknown as {
      metricsCache: MetricsCache;
      metricsResolved: boolean;
    };
    owner.metricsCache = cache;
    owner.metricsResolved = true;

    let caller: Promise<void> | undefined;
    try {
      // The ACTUAL view async caller, not a direct cache call and not a
      // synthetic render.
      caller = (h.view as unknown as { refreshAllExpired(): Promise<void> }).refreshAllExpired();
      await entered;

      // Before release: a positive provider call with the real argv, no save,
      // no cached entry and a completely unchanged popup.
      expect(runCalls).toBe(1);
      expect(runArgs).toEqual([["metrics", "query", "--journal", "Nature"]]);
      expect(saved.length).toBe(0);
      expect(cache.getEntryFor({ journal: "Nature" })).toBeUndefined();
      expect(h.panel()).toBe(shell);
      expect(h.numeric("yearFrom")).toBe(input);
      expect(input.value).toBe("19");
      expect(h.journalQuery()).toBe(lookup);
      expect(lookup.value).toBe("nat");
      expect(h.doc.activeElement).toBe(input);
      expect(h.trigger()).toBe(oldTrigger);
      expect(oldTrigger.isConnected).toBe(true);

      // A REAL source change while the caller is in flight. The cache
      // iterates the SAME array sequentially, so eLife is refreshed as the
      // promise completes — no second view refresh is issued.
      h.records.push(
        makeRecord("eLife", 2023, "05 Literature/elife/elife.md", "elife2023"),
      );
      releaseRun();
      await caller;

      // Three genuine argv calls, three in-memory saves and one load.
      expect(runCalls).toBe(3);
      expect(runArgs).toEqual([
        ["metrics", "query", "--journal", "Nature"],
        ["metrics", "query", "--journal", "Cell"],
        ["metrics", "query", "--journal", "eLife"],
      ]);
      expect(saved.length).toBe(3);
      expect(loadCalls).toBe(1);

      // The ACTUAL cached value and the ACTUAL serialized saved entries.
      const natureEntry = cache.getEntryFor({ journal: "Nature" });
      expect(natureEntry?.metrics.if).toBe(5.1);
      expect(natureEntry?.stale).toBe(false);
      const lastSaved = saved[saved.length - 1] as {
        entries: Array<{ key: string; journal?: string; metrics: { if?: number } }>;
      };
      expect(lastSaved.entries.map((entry) => entry.key)).toEqual([
        "journal:cell",
        "journal:elife",
        "journal:nature",
      ]);
      const persistedNature = lastSaved.entries.find(
        (entry) => entry.key === "journal:nature",
      );
      expect(persistedNature?.journal).toBe("nature");
      expect(persistedNature?.metrics.if).toBe(5.1);

      // The real async completion re-rendered the toolbar: a NEW, connected
      // live replacement trigger, while the popup shell, both form nodes, the
      // raw draft, the lookup text and the mock focus stay identical.
      expect(h.trigger()).not.toBe(oldTrigger);
      expect(h.trigger().isConnected).toBe(true);
      expect(oldTrigger.isConnected).toBe(false);
      expect(h.panel()).toBe(shell);
      expect(h.numeric("yearFrom")).toBe(input);
      expect(input.value).toBe("19");
      expect(h.journalQuery()).toBe(lookup);
      expect(lookup.value).toBe("nat");
      expect(h.doc.activeElement).toBe(input);

      // The pending draft never committed, and the main search plus its single
      // row survived the actual completion.
      expect(hasAttr(h.count(), "hidden")).toBe(true);
      expect(hasAttr(h.summary(), "hidden")).toBe(true);
      expect(h.search().value).toBe("nature");
      expect(h.view.getState().searchQuery).toBe("nature");
      expect(rowCount(h)).toBe(1);

      // The refreshed ALL-source roster offers the journals the main search
      // excludes.
      typeInto(lookup, "");
      expect(h.journalOptions()).toContain("Cell");
      expect(h.journalOptions()).toContain("eLife");
    } finally {
      // Always unblock the provider and await the started caller — even after
      // a failed assertion — so no asynchronous test work outlives the test.
      releaseRun();
      if (caller !== undefined) {
        await caller;
      }
    }
  });
});

// ── 8. state persistence ──────────────────────────────────────────────

describe("getState/setState drop filter persistence only", () => {
  it("omits filters entirely while retaining every other field", async () => {
    const h = mount();
    await h.view.onOpen();
    click(h.trigger());
    typeInto(h.numeric("yearFrom"), "2020");
    click(applyButton(h));

    h.search().value = "nature";
    h.search().dispatchEvent({ type: "input" });

    const state = h.view.getState();
    expect(state).toEqual({
      page: "library",
      searchQuery: "nature",
      sort: { columnId: "year", direction: "desc" },
      selectedPath: null,
      drawerOpen: false,
    });
    expect("filters" in state).toBe(false);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("ignores a legacy persisted filters payload including maxima", async () => {
    // A test-local shallow copy keeps the global NATURE/CELL records and the
    // default mount untouched while making positive row evidence possible for
    // a nonempty query.
    const kept = { ...NATURE, title: "kept Nature 2015" };
    const h = mount({ records: [kept, CELL] });
    await h.view.onOpen();
    // Both rows exist before the legacy payload is restored.
    expect(rowCount(h)).toBe(2);
    await h.view.setState(
      {
        page: "library",
        searchQuery: "kept",
        filters: {
          yearFrom: 1999,
          yearTo: 2005,
          journal: "Legacy",
          ifMin: 1,
          ifMax: 99,
          jciMin: 2,
          jciMax: 88,
          readingStatus: "read",
          requiredArtifacts: ["pdf"],
        },
        sort: { columnId: "title", direction: "asc" },
        selectedPath: null,
        drawerOpen: false,
      },
      { history: false },
    );

    const state = h.view.getState();
    // The nonempty query is retained verbatim, never blanked to satisfy row
    // counts.
    expect(state.searchQuery).toBe("kept");
    // The ACTUAL DOM search control carries the same nonempty query.
    expect(h.search().value).toBe("kept");
    expect(state.sort).toEqual({ columnId: "title", direction: "asc" });
    expect("filters" in state).toBe(false);
    // Exactly the matching record: the legacy year 1999–2005, journal
    // "Legacy", metric minima/maxima and artifact restrictions would all have
    // excluded that row if they had been restored.
    expect(rowCount(h)).toBe(1);
    expect(h.rows()[0]?.getAttribute("data-paper-notes-library-path")).toBe(NATURE.path);
    // Legacy filters never reached the applied state.
    expect(hasAttr(h.count(), "hidden")).toBe(true);
    expect(hasAttr(h.summary(), "hidden")).toBe(true);
    // Reopening shows the real empty draft, not the restored legacy payload.
    click(h.trigger());
    expect(h.numeric("yearFrom").value).toBe("");
    expect(h.numeric("yearTo").value).toBe("");
    expect(h.numeric("ifMin").value).toBe("");
    expect(h.numeric("jciMin").value).toBe("");
    expect(h.journalQuery().value).toBe("");
    const selectedName = h.form().querySelector(`.${FORM_CLASS}-journal-selected-name`);
    expect(selectedName?.textContent ?? "").toBe("");
  });
});
