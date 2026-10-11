/**
 * library-filter-panel: anchored overlay wrapper (S2b).
 *
 * Event-contract coverage around the ACCEPTED pending form — the form is
 * used for real, never stubbed. These tests do NOT prove real browser
 * focus, caret, layout, computed CSS or native capture semantics; they
 * prove that:
 *  - the overlay mounts once in the owner document body, so emptying the
 *    originating pane never removes it;
 *  - an internal pointerdown whose target is later detached/replaced stays
 *    inside (composedPath read at dispatch time) and does not dismiss;
 *  - outside pointerdown, Escape, Cancel and Close all discard with no
 *    payload and notify `onClose` exactly once;
 *  - Reset stays pending-only, an invalid Apply stays open, and a valid
 *    Apply runs the owner callback BEFORE teardown so the owner may swap
 *    the anchor and the replacement trigger receives focus;
 *  - dispose is silent, idempotent and leaves no listeners behind;
 *  - `setAnchor`/`setJournalOptions` never remount the form or the fields,
 *    so raw partial text, the lookup and the chosen journal survive;
 *  - reopening from the applied snapshot clones it, not the cancelled
 *    pending draft;
 *  - geometry stays inside the pane ∩ viewport, prefers below the anchor,
 *    clamps off-edge/narrow panes, and an internal scroll is ignored.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LibraryFilterPanel } from "../src/components/library-filter-panel";
import type { LibraryFilters } from "../src/components/library-filters";
import {
  createMockDocument,
  createMockPanelEvent,
  MockStyle,
  MockWindow,
  type MockEl,
  type MockPanelEvent,
} from "./library-filter-test-dom";

const FORM_CLASS = "paper-notes-library-filter-form";
const PANEL_CLASS = "paper-notes-library-filter-panel";
const CLOSE_CLASS = `${PANEL_CLASS}-close`;
const TITLE_CLASS = `${FORM_CLASS}-title`;
const SCROLL_CLASS = `${FORM_CLASS}-scroll`;
const FOOTER_CLASS = `${FORM_CLASS}-footer`;
const JOURNAL_QUERY_CLASS = `${FORM_CLASS}-journal-query`;
const JOURNAL_OPTION_CLASS = `${FORM_CLASS}-journal-option`;
const APPLY_CLASS = `${FORM_CLASS}-button-primary`;

const APPLIED: LibraryFilters = {
  yearFrom: 2019,
  yearTo: 2024,
  journal: "Nature",
  requiredArtifacts: ["pdf"],
};

interface Harness {
  panel: LibraryFilterPanel;
  doc: ReturnType<typeof createMockDocument>;
  body: MockEl;
  pane: MockEl;
  anchor: MockEl;
  win: MockWindow;
  applies: LibraryFilters[];
  closes: number;
  events: string[];
  find(cls: string): MockEl;
  findAll(cls: string): MockEl[];
  input(field: string): MockEl;
  pointerDown(target: MockEl, extra?: MockEl[]): void;
  /** Dispatch a keydown; returns whether a handler stopped propagation. */
  key(key: string, extra?: MockEl[]): boolean;
  /** Dispatch a composing keydown (an IME cancel). */
  keyComposing(key: string, extra?: MockEl[]): boolean;
  scroll(target: MockEl, extra?: MockEl[]): void;
  /** The most recent keydown, for propagation assertions. */
  lastKeyEvent(): MockPanelEvent | null;
}

/**
 * Build a fresh isolated owner document, attach an owner window and mount
 * one panel. Every test gets its own document, so nothing leaks between
 * cases.
 */
function mount(options: {
  journals?: readonly string[];
  filters?: LibraryFilters;
} = {}): Harness {
  const doc = createMockDocument();
  const body = doc.body as MockEl;
  const win = new MockWindow();
  doc.doc.defaultView = win;
  const pane = doc.pane;
  const anchor = pane.createDiv({ cls: "trigger" });
  const applies: LibraryFilters[] = [];
  const closes: number[] = [];
  const events: string[] = [];
  let lastEvent: MockPanelEvent | null = null;

  const panel = new LibraryFilterPanel({
    anchor: anchor as unknown as HTMLElement,
    container: pane as unknown as HTMLElement,
    filters: options.filters ?? APPLIED,
    journals: options.journals ?? ["Nature", "Cell", "Science"],
    onApply: (filters) => {
      applies.push(filters);
    },
    onClose: () => {
      closes.push(1);
    },
  });

  const root = panel.element as unknown as MockEl;
  return {
    panel,
    doc,
    body,
    pane,
    anchor,
    win,
    applies,
    get closes() {
      return closes.length;
    },
    events,
    lastKeyEvent: () => lastEvent,
    find: (cls) => root.findByClass(cls),
    findAll: (cls) => root.findAllByClass(cls),
    input: (field) => {
      const found = root.findAll(
        (el) => el.tag === "input" && el.getAttribute("id")?.endsWith(field) === true,
      );
      if (found.length !== 1) {
        throw new Error(`expected one input for ${field}, got ${found.length}`);
      }
      return found[0] as MockEl;
    },
    pointerDown: (target, extra = []) => {
      doc.doc.dispatchCaptured(
        createMockPanelEvent({
          type: "pointerdown",
          target,
          composedPath: [body, ...extra, target],
        }),
      );
    },
    key: (key, extra = []) => {
      lastEvent = createMockPanelEvent({
        type: "keydown",
        key,
        target: body,
        composedPath: [body, ...extra],
      });
      return doc.doc.dispatchCaptured(lastEvent);
    },
    keyComposing: (key, extra = []) => {
      lastEvent = createMockPanelEvent({
        type: "keydown",
        key,
        isComposing: true,
        target: body,
        composedPath: [body, ...extra],
      });
      return doc.doc.dispatchCaptured(lastEvent);
    },
    scroll: (target, extra = []) => {
      doc.doc.dispatchCaptured(
        createMockPanelEvent({
          type: "scroll",
          target,
          composedPath: [body, ...extra, target],
        }),
      );
    },
  };
}

function click(el: MockEl): void {
  el.dispatchEvent({ type: "click" });
}

function typeInto(view: Harness, field: string, value: string): void {
  const input = view.input(field);
  input.value = value;
  input.dispatchEvent({ type: "input" });
}

describe("mount", () => {
  it("mounts once in the owner document body, outside the pane subtree", () => {
    const view = mount();
    const root = view.panel.element as unknown as MockEl;
    expect(root.parent).toBe(view.body);
    // The originating pane is emptied, yet the overlay survives.
    view.pane.empty();
    expect(view.body.children).toContain(root);
    expect(view.pane.children).toHaveLength(0);
    // Exactly one overlay and one accepted form, never a remount.
    expect(view.body.children.filter((el) => el.cls.includes(PANEL_CLASS))).toHaveLength(1);
    expect(view.findAll(FORM_CLASS)).toHaveLength(1);
  });

  it("falls back to the declared container when the body is unavailable", () => {
    const doc = createMockDocument({ body: null });
    const pane = doc.pane;
    const anchor = pane.createDiv({});
    const panel = new LibraryFilterPanel({
      anchor: anchor as unknown as HTMLElement,
      container: pane as unknown as HTMLElement,
      filters: APPLIED,
      journals: [],
      onApply: () => undefined,
      onClose: () => undefined,
    });
    expect((panel.element as unknown as MockEl).parent).toBe(pane);
  });

  it("is a nonmodal dialog labelled by the visible form title", () => {
    const view = mount();
    const root = view.panel.element as unknown as MockEl;
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBeNull();
    const title = view.find(TITLE_CLASS);
    const titleId = title.getAttribute("id");
    expect(titleId).toBeTruthy();
    expect(root.getAttribute("aria-labelledby")).toBe(titleId);
    // A visible Close button exists alongside the accepted Cancel.
    expect(view.find(CLOSE_CLASS).tag).toBe("button");
    expect(view.find(CLOSE_CLASS).textContent).toBe("Close");
    expect(view.findAll(`${FORM_CLASS}-button`).some((b) => b.textContent === "Cancel")).toBe(true);
    // No focus trap: no tabindex juggling on the shell.
    expect(root.getAttribute("tabindex")).toBeNull();
  });

  it("focuses the first numeric field once on open and never again", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    expect(view.doc.doc.activeElement).toBe(yearFrom);
    expect(yearFrom.focusCalls()).toBe(1);

    view.panel.setAnchor(view.anchor as unknown as HTMLElement);
    view.panel.setJournalOptions(["Nature", "Cell", "Science", "Lancet"]);
    expect(yearFrom.focusCalls()).toBe(1);
    expect(view.doc.doc.activeElement).toBe(yearFrom);
  });
});

describe("dismissal", () => {
  it("keeps an internal pointerdown open even when its target is replaced", () => {
    const view = mount();
    const option = view.findAll(JOURNAL_OPTION_CLASS)[0] as MockEl;
    // A roster refresh detaches the old node. The press was already captured
    // against the live path, so the panel stays open.
    const path = [view.body, view.panel.element as unknown as MockEl, option];
    view.panel.setJournalOptions(["Cell", "Science"]);
    expect(option.parent).toBeNull();
    view.doc.doc.dispatchCaptured(
      createMockPanelEvent({
        type: "pointerdown",
        target: option,
        composedPath: path,
      }),
    );
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
    expect((view.panel.element as unknown as MockEl).parent).toBe(view.body);
  });

  it("keeps a live journal activation open with no payload", () => {
    const view = mount();
    view.pointerDown(view.findAll(JOURNAL_OPTION_CLASS)[0] as MockEl);
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
  });

  it("closes once on an outside pointerdown with no payload", () => {
    const view = mount();
    const outside = view.pane.createDiv({ cls: "outside" });
    view.pointerDown(outside);
    expect(view.closes).toBe(1);
    expect(view.applies).toHaveLength(0);
    expect((view.panel.element as unknown as MockEl).parent).toBeNull();
  });

  it("closes once on Escape without reaching a window bubble drawer handler", () => {
    const view = mount();
    let drawerEscapes = 0;
    view.win.addEventListener("keydown", () => {
      drawerEscapes += 1;
    });
    const suppressed = view.key("Escape");
    expect(suppressed).toBe(true);
    expect(drawerEscapes).toBe(0);
    expect(view.closes).toBe(1);
    // The default action was actually prevented, not merely ignored.
    expect(view.lastKeyEvent()?.defaultPrevented).toBe(true);
  });

  it("delivers an unsuppressed key to the owner window bubble handler", () => {
    // POSITIVE CONTROL: the same dispatcher must reach the owner window when
    // the popup does not suppress the event, otherwise every drawer
    // expectation above would be vacuously zero.
    const view = mount();
    const seen: string[] = [];
    view.win.addEventListener("keydown", (event) => {
      seen.push((event as { key?: string }).key ?? "");
    });
    const suppressed = view.key("Tab");
    expect(suppressed).toBe(false);
    expect(seen).toEqual(["Tab"]);
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
  });

  it("delivers an unsuppressed Escape once the popup is closed", () => {
    const view = mount();
    const seen: string[] = [];
    view.win.addEventListener("keydown", (event) => {
      seen.push((event as { key?: string }).key ?? "");
    });
    // Close first so no capture handler suppresses the event.
    view.panel.close();
    view.key("Escape");
    expect(seen).toEqual(["Escape"]);
  });

  it("keeps a composing Escape open, unprevented, but off the drawer", () => {
    const view = mount();
    let drawerEscapes = 0;
    view.win.addEventListener("keydown", () => {
      drawerEscapes += 1;
    });
    view.keyComposing("Escape");
    // The IME keeps its native default action and the popup stays open...
    expect(view.lastKeyEvent()?.defaultPrevented).toBeFalsy();
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
    // ...but propagation is consumed, so the unguarded root window-bubble
    // drawer handler cannot close on a composition cancel.
    expect(drawerEscapes).toBe(0);
    expect((view.panel.element as unknown as MockEl).parent).toBe(view.body);
  });

  it("does not trap or consume non-Escape keys", () => {
    const view = mount();
    const suppressed = view.key("a");
    expect(suppressed).toBe(false);
    expect(view.closes).toBe(0);
    // Arrow/Tab navigation is left entirely to the browser and the form.
    expect(view.lastKeyEvent()?.defaultPrevented).toBeFalsy();
  });

  it("closes once on the wrapper Close button and once on Cancel", () => {
    const view = mount();
    click(view.find(CLOSE_CLASS));
    expect(view.closes).toBe(1);
    expect(view.applies).toHaveLength(0);

    const second = mount();
    click(second.findAll(`${FORM_CLASS}-button`).find((b) => b.textContent === "Cancel") as MockEl);
    expect(second.closes).toBe(1);
    expect(second.applies).toHaveLength(0);
  });

  it("returns focus to the latest connected live anchor", () => {
    const view = mount();
    const replacement = view.pane.createDiv({ cls: "replacement" });
    view.panel.setAnchor(replacement as unknown as HTMLElement);
    view.key("Escape");
    expect(view.doc.doc.activeElement).toBe(replacement);
    expect(replacement.focusCalls()).toBe(1);
  });

  it("never focuses a detached anchor", () => {
    const view = mount();
    view.anchor.detach();
    expect(view.anchor.isConnected).toBe(false);
    view.key("Escape");
    expect(view.anchor.focusCalls()).toBe(0);
  });

  it("is inert after close: repeat close, stale events and stale events stay silent", () => {
    const view = mount();
    view.key("Escape");
    view.panel.close();
    view.panel.close();
    view.key("Escape");
    const outside = view.pane.createDiv({});
    view.pointerDown(outside);
    view.scroll(view.pane);
    expect(view.closes).toBe(1);
    expect(view.applies).toHaveLength(0);
  });
});

describe("pending state", () => {
  it("keeps the panel open on Reset and on an invalid Apply", () => {
    const view = mount();
    typeInto(view, "yearFrom", "2001");
    const reset = view.findAll(`${FORM_CLASS}-button`).find((b) => b.textContent === "Reset") as MockEl;
    click(reset);
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
    // Reset cleared the pending draft; the applied snapshot is untouched.
    expect(view.input("yearFrom").value).toBe("");

    typeInto(view, "yearFrom", "2001");
    typeInto(view, "yearTo", "1999");
    const apply = view.find(APPLY_CLASS);
    click(apply);
    expect(view.applies).toHaveLength(0);
    expect(view.closes).toBe(0);
    expect((view.panel.element as unknown as MockEl).parent).toBe(view.body);
    expect(view.input("yearFrom").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps raw partial text, the lookup and the journal choice across setAnchor and roster refresh", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    typeInto(view, "yearFrom", "200");
    const query = view.find(JOURNAL_QUERY_CLASS);
    query.value = "cel";
    query.dispatchEvent({ type: "input" });
    click(view.findAll(JOURNAL_OPTION_CLASS)[0] as MockEl);
    expect(view.find(`${FORM_CLASS}-journal-selected-name`).textContent).toBe("Cell");

    view.panel.setAnchor(view.pane.createDiv({}) as unknown as HTMLElement);
    view.panel.setJournalOptions(["Nature", "Cell", "Science", "Lancet"]);

    expect(view.input("yearFrom")).toBe(yearFrom);
    expect(yearFrom.value).toBe("200");
    expect(view.find(JOURNAL_QUERY_CLASS)).toBe(query);
    expect(query.value).toBe("cel");
    expect(view.find(`${FORM_CLASS}-journal-selected-name`).textContent).toBe("Cell");
    // No remount and no focus stealing.
    expect(view.findAll(FORM_CLASS)).toHaveLength(1);
    expect(query.focusCalls()).toBe(0);
  });

  it("reopens from the applied snapshot, not the cancelled pending draft", () => {
    const cancelled = mount();
    typeInto(cancelled, "yearFrom", "2001");
    click(cancelled.findAll(`${FORM_CLASS}-button`).find((b) => b.textContent === "Cancel") as MockEl);

    const reopened = mount();
    expect(reopened.input("yearFrom").value).toBe("2019");
    expect(reopened.input("yearTo").value).toBe("2024");
    expect(reopened.find(`${FORM_CLASS}-journal-selected-name`).textContent).toBe("Nature");
    // A fresh clone: mutating the reopened payload never touches the source.
    reopened.applies.length = 0;
    click(reopened.find(APPLY_CLASS));
    expect(reopened.applies).toHaveLength(1);
    expect(reopened.applies[0]).not.toBe(APPLIED);
    expect(reopened.applies[0]?.requiredArtifacts).toEqual(["pdf"]);
  });
});

describe("apply ordering", () => {
  it("runs onApply before teardown and focuses a replacement trigger built inside it", () => {
    const doc = createMockDocument();
    const win = new MockWindow();
    doc.doc.defaultView = win;
    const pane = doc.pane;
    const anchor = pane.createDiv({});
    const order: string[] = [];
    let panel: LibraryFilterPanel | null = null;
    // Observed INSIDE the callbacks, so a mutant that tears down before
    // `onApply` (or focuses before `onClose`) fails here.
    const insideApply: {
      shellConnected: boolean;
      formConnected: boolean;
      docListeners: number;
      windowListeners: number;
      yearFrom: unknown;
      payloadYear: unknown;
    } = {
      shellConnected: false,
      formConnected: false,
      docListeners: -1,
      windowListeners: -1,
      yearFrom: undefined,
      payloadYear: undefined,
    };
    const insideClose = {
      shellConnected: true,
      formConnected: true,
      docListeners: -1,
      windowListeners: -1,
      replacementFocusCalls: -1,
    };

    panel = new LibraryFilterPanel({
      anchor: anchor as unknown as HTMLElement,
      container: pane as unknown as HTMLElement,
      filters: APPLIED,
      journals: ["Nature"],
      onApply: (filters) => {
        order.push("apply");
        const shell = (panel as LibraryFilterPanel).element as unknown as MockEl;
        const form = shell.findByClass(FORM_CLASS);
        insideApply.shellConnected = shell.isConnected;
        insideApply.formConnected = form.isConnected;
        insideApply.docListeners = doc.doc.listenerTotal();
        insideApply.windowListeners = doc.doc.defaultView?.listenerCount("resize") ?? -1;
        insideApply.yearFrom = filters.yearFrom;
        insideApply.payloadYear = filters.yearFrom;

        // The owner ACTUALLY rerenders: empty the pane, drop the old trigger
        // and create a NEW connected trigger, then re-anchor onto it.
        pane.empty();
        const replacement = pane.createDiv({ cls: "replacement" });
        (panel as LibraryFilterPanel).setAnchor(replacement as unknown as HTMLElement);
        order.push("rerender");
      },
      onClose: () => {
        order.push("close");
        // `pane.empty()` above detached the subtree, so read the captured
        // nodes rather than searching the (now empty) pane.
        const shell = (panel as LibraryFilterPanel).element as unknown as MockEl;
        const form = capturedForm as MockEl;
        insideClose.shellConnected = shell.isConnected;
        insideClose.formConnected = form.isConnected;
        insideClose.docListeners = doc.doc.listenerTotal();
        insideClose.windowListeners = doc.doc.defaultView?.listenerCount("resize") ?? -1;
        insideClose.replacementFocusCalls = focusCallsOf(pane, "replacement");
      },
    });
    expect(panel).not.toBeNull();
    const capturedForm = ((panel as LibraryFilterPanel).element as unknown as MockEl)
      .findByClass(FORM_CLASS);

    click((panel as LibraryFilterPanel).element.querySelector(`.${APPLY_CLASS}`) as unknown as MockEl);

    // apply -> (owner rerender) -> teardown -> onClose -> focus return.
    expect(order).toEqual(["apply", "rerender", "close"]);

    // INSIDE onApply the shell and form were still live and owned their
    // document/window listeners.
    expect(insideApply.shellConnected).toBe(true);
    expect(insideApply.formConnected).toBe(true);
    expect(insideApply.docListeners).toBe(3);
    expect(insideApply.windowListeners).toBe(1);
    expect(insideApply.payloadYear).toBe(2019);

    // INSIDE onClose everything was already torn down and the replacement
    // had NOT yet been focused.
    expect(insideClose.shellConnected).toBe(false);
    expect(insideClose.formConnected).toBe(false);
    expect(insideClose.docListeners).toBe(0);
    expect(insideClose.windowListeners).toBe(0);
    expect(insideClose.replacementFocusCalls).toBe(0);

    // AFTER activation the replacement was focused exactly once and the old
    // (now detached) trigger never was.
    const replacement = pane.findByClass("replacement");
    expect(doc.doc.activeElement).toBe(replacement);
    expect(replacement.focusCalls()).toBe(1);
    expect(anchor.isConnected).toBe(false);
    expect(anchor.focusCalls()).toBe(0);
  });

  it("emits one payload even when the callback triggers a reentrant close", () => {
    const doc = createMockDocument();
    const pane = doc.pane;
    const anchor = pane.createDiv({});
    let closes = 0;
    let panel: LibraryFilterPanel | null = null;
    const payloads: unknown[] = [];

    panel = new LibraryFilterPanel({
      anchor: anchor as unknown as HTMLElement,
      container: pane as unknown as HTMLElement,
      filters: APPLIED,
      journals: [],
      onApply: (filters) => {
        payloads.push(filters);
        (panel as LibraryFilterPanel).close();
      },
      onClose: () => {
        closes += 1;
      },
    });
    click((panel as LibraryFilterPanel).element.querySelector(`.${APPLY_CLASS}`) as unknown as MockEl);
    expect(payloads).toHaveLength(1);
    expect(closes).toBe(1);
  });

  it("still tears down when the owner callback throws", () => {
    const doc = createMockDocument();
    const pane = doc.pane;
    const anchor = pane.createDiv({});
    let panel: LibraryFilterPanel | null = null;
    panel = new LibraryFilterPanel({
      anchor: anchor as unknown as HTMLElement,
      container: pane as unknown as HTMLElement,
      filters: APPLIED,
      journals: [],
      onApply: () => {
        throw new Error("owner rerender failed");
      },
      onClose: () => undefined,
    });
    const root = (panel as LibraryFilterPanel).element as unknown as MockEl;
    const before = root.subtreeListenerCount();
    expect(before).toBeGreaterThan(0);
    expect(() =>
      click(root.querySelector(`.${APPLY_CLASS}`) as MockEl),
    ).toThrow("owner rerender failed");
    // No listener leak, no duplicate signal.
    expect(root.subtreeListenerCount()).toBe(0);
    expect(root.isConnected).toBe(false);
  });
});

describe("dispose", () => {
  it("is silent, idempotent and leaves no wrapper listeners", () => {
    const view = mount();
    const root = view.panel.element as unknown as MockEl;
    const form = root.findByClass(FORM_CLASS);
    const yearFrom = view.input("yearFrom");
    expect(yearFrom.listenerCount()).toBeGreaterThan(0);

    view.panel.dispose();
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
    // No focus move: the owner view may be dead.
    expect(view.doc.doc.activeElement).toBe(yearFrom);
    expect(root.isConnected).toBe(false);
    expect(form.subtreeListenerCount()).toBe(0);

    view.panel.dispose();
    expect(view.closes).toBe(0);

    // Stale events stay inert.
    view.pointerDown(view.pane.createDiv({}));
    view.key("Escape");
    view.scroll(view.pane);
    expect(view.closes).toBe(0);
    expect(view.applies).toHaveLength(0);
    expect(view.doc.doc.activeElement).toBe(yearFrom);
  });

  it("drops the document and window listeners it registered", () => {
    const view = mount();
    const before = view.body.subtreeListenerCount();
    expect(before).toBeGreaterThan(0);
    // Three captured document listeners plus one window resize listener.
    expect(view.doc.doc.listenerTotal()).toBe(3);
    expect(view.win.listenerCount("resize")).toBe(1);
    view.panel.dispose();
    expect(view.doc.doc.listenerTotal()).toBe(0);
    expect(view.win.listenerCount("resize")).toBe(0);
  });

  it("a reentrant dispose inside apply wins silently", () => {
    const doc = createMockDocument();
    const pane = doc.pane;
    const anchor = pane.createDiv({});
    let closes = 0;
    let panel: LibraryFilterPanel | null = null;
    panel = new LibraryFilterPanel({
      anchor: anchor as unknown as HTMLElement,
      container: pane as unknown as HTMLElement,
      filters: APPLIED,
      journals: [],
      onApply: () => {
        (panel as LibraryFilterPanel).dispose();
      },
      onClose: () => {
        closes += 1;
      },
    });
    click((panel as LibraryFilterPanel).element.querySelector(`.${APPLY_CLASS}`) as unknown as MockEl);
    expect(closes).toBe(0);
    expect((panel as LibraryFilterPanel).element.isConnected).toBe(false);
  });
});

/** Recorded `focus()` calls on the first descendant carrying `cls`. */
function focusCallsOf(host: MockEl, cls: string): number {
  return host.findByClass(cls).focusCalls();
}

/** The overlay shell's inline style bag. */
const style = (view: Harness): MockStyle =>
  (view.panel.element as unknown as MockEl).style;

/** Read one geometry property as a number (px stripped). */
const px = (view: Harness, name: string): number =>
  Number.parseFloat(style(view).getPropertyValue(name) ?? "");

/** Apply a pane/anchor rect pair and re-sync the geometry. */
function setRects(view: Harness, pane: MockEl, anchor: MockEl, rects: {
  pane: { top: number; left: number; right: number; bottom: number };
  anchor?: { top: number; left: number; right: number; bottom: number };
}): void {
  pane.rect = rects.pane;
  anchor.rect = rects.anchor ?? rects.pane;
  view.panel.setAnchor(anchor as unknown as HTMLElement);
}

describe("geometry", () => {

  it("stays inside the pane ∩ viewport and prefers below the anchor", () => {
    const view = mount();
    // A tall owner viewport so the below-preferred branch is reachable.
    view.win.innerHeight = 1000;
    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 1000 },
      anchor: { top: 300, left: 240, right: 320, bottom: 330 },
    });
    const left = px(view, "left");
    const top = px(view, "top");
    const width = px(view, "width");
    const height = px(view, "height");
    expect(width).toBe(360);
    expect(height).toBe(560);
    expect(left).toBe(240);
    expect(top).toBe(338); // anchor.bottom + margin
    // Inside the pane and inside the viewport.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(1200);
    expect(top + height).toBeLessThanOrEqual(1000);
    expect(left + width).toBeLessThanOrEqual(view.win.innerWidth);
  });

  it("prefers above when nothing fits below", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 700 },
      anchor: { top: 600, left: 100, right: 180, bottom: 640 },
    });
    expect(px(view, "top")).toBe(600 - 8 - 560);
    expect(px(view, "top")).toBeGreaterThanOrEqual(0);
  });

  it("clamps a narrow pane and an off-edge anchor without a minimum overflow", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 40, left: 1180, right: 1200, bottom: 760 },
      anchor: { top: 60, left: 1170, right: 1200, bottom: 90 },
    });
    const left = px(view, "left");
    const width = px(view, "width");
    // The pane is only 20px wide; the panel never exceeds it.
    expect(width).toBeLessThanOrEqual(20 - 16);
    expect(left).toBeGreaterThanOrEqual(1180);
    expect(left + width).toBeLessThanOrEqual(1200);
    expect(px(view, "max-width")).toBe(width);
    expect(px(view, "max-height")).toBe(px(view, "height"));
  });

  it("clamps a tiny-height pane with a bounded overlap instead of spilling", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 300, left: 0, right: 1200, bottom: 380 },
      anchor: { top: 340, left: 100, right: 180, bottom: 360 },
    });
    const top = px(view, "top");
    const height = px(view, "height");
    expect(height).toBe(80 - 16);
    expect(top).toBeGreaterThanOrEqual(300);
    expect(top + height).toBeLessThanOrEqual(380);
  });

  it("never mutates fields, the draft or the DOM while repositioning", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    typeInto(view, "yearFrom", "200");
    const optionCount = view.findAll(JOURNAL_OPTION_CLASS).length;
    setRects(view, view.pane, view.anchor, {
      pane: { top: 10, left: 10, right: 900, bottom: 500 },
      anchor: { top: 20, left: 40, right: 120, bottom: 60 },
    });
    expect(view.input("yearFrom")).toBe(yearFrom);
    expect(yearFrom.value).toBe("200");
    expect(view.findAll(JOURNAL_OPTION_CLASS)).toHaveLength(optionCount);
    expect(view.applies).toHaveLength(0);
    // The scroller is not unbound/re-expanded: no remount, same nodes.
    expect(view.find(SCROLL_CLASS).tag).toBe("div");
    expect(view.find(FOOTER_CLASS).tag).toBe("div");
  });

  it("ignores an internal scroll and repositions on an external one", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 100, left: 0, right: 1200, bottom: 700 },
      anchor: { top: 300, left: 240, right: 320, bottom: 330 },
    });
    const before = new Map(style(view).entries());
    // A scroll originating inside the overlay must not move it.
    view.scroll(view.find(SCROLL_CLASS), [view.panel.element as unknown as MockEl]);
    expect(new Map(style(view).entries())).toEqual(before);

    // An external pane scroll does reposition.
    view.pane.rect = { top: 60, left: 0, right: 1200, bottom: 660 };
    view.scroll(view.pane);
    expect(style(view).getPropertyValue("top") ?? "").not.toBe(before.get("top") ?? "");
  });

  it("repositions on an owner window resize", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 100, left: 0, right: 1200, bottom: 700 },
      anchor: { top: 300, left: 240, right: 320, bottom: 330 },
    });
    view.win.innerWidth = 500;
    view.win.dispatchEvent("resize");
    expect(px(view, "width")).toBeLessThanOrEqual(500);
  });
});

describe("short-height recovery", () => {
  const shellClass = (view: Harness): string =>
    (view.panel.element as unknown as MockEl).cls;

  it("enters whole-shell scroll mode for the existing 80px pane case", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 80 },
      anchor: { top: 20, left: 100, right: 180, bottom: 40 },
    });
    // The available cap is 80 - 16 = 64px, far below the chrome budget.
    expect(px(view, "height")).toBe(64);
    expect(shellClass(view).split(/\s+/)).toContain("is-short-height");
    // Still bounded by the pane and viewport, never an overflowing minimum.
    expect(px(view, "height")).toBeLessThanOrEqual(80);
    expect(px(view, "max-height")).toBe(64);
    // Nothing is remounted and nothing is focused by the mode switch.
    expect(view.findAll(FORM_CLASS)).toHaveLength(1);
    expect(view.applies).toHaveLength(0);
  });

  it("recovers to the normal bounded flex mode when height returns", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    const query = view.find(JOURNAL_QUERY_CLASS);

    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 80 },
      anchor: { top: 20, left: 100, right: 180, bottom: 40 },
    });
    expect(shellClass(view).split(/\s+/)).toContain("is-short-height");

    view.win.innerHeight = 1000;
    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 1000 },
      anchor: { top: 20, left: 100, right: 180, bottom: 40 },
    });
    expect(shellClass(view).split(/\s+/)).not.toContain("is-short-height");
    expect(px(view, "height")).toBe(560);

    // The mode switch never remounts a control, resets the raw draft or
    // steals focus.
    expect(view.input("yearFrom")).toBe(yearFrom);
    expect(view.find(JOURNAL_QUERY_CLASS)).toBe(query);
    expect(view.doc.doc.activeElement).toBe(yearFrom);
  });

  it("keeps stable nodes and draft across repeated mode switches", () => {
    const view = mount();
    const yearFrom = view.input("yearFrom");
    typeInto(view, "yearFrom", "200");
    const query = view.find(JOURNAL_QUERY_CLASS);
    query.value = "nat";
    query.dispatchEvent({ type: "input" });
    click(view.findAll(JOURNAL_OPTION_CLASS)[0] as MockEl);

    for (const bottom of [80, 1000, 90, 1200]) {
      view.win.innerHeight = Math.max(800, bottom);
      setRects(view, view.pane, view.anchor, {
        pane: { top: 0, left: 0, right: 1200, bottom },
        anchor: { top: 20, left: 100, right: 180, bottom: 40 },
      });
    }
    expect(view.input("yearFrom")).toBe(yearFrom);
    expect(yearFrom.value).toBe("200");
    expect(view.find(JOURNAL_QUERY_CLASS)).toBe(query);
    expect(query.value).toBe("nat");
    expect(view.find(`${FORM_CLASS}-journal-selected-name`).textContent).toBe("Nature");
    expect(view.applies).toHaveLength(0);
  });

  it("ignores internal shell and field scrolling while in short mode", () => {
    const view = mount();
    setRects(view, view.pane, view.anchor, {
      pane: { top: 0, left: 0, right: 1200, bottom: 80 },
      anchor: { top: 20, left: 100, right: 180, bottom: 40 },
    });
    const before = new Map(style(view).entries());
    // The shell itself scrolls in short mode; that must not reposition it.
    view.scroll(view.panel.element as unknown as MockEl);
    expect(new Map(style(view).entries())).toEqual(before);
    // Nor does the internal field scroller.
    view.scroll(view.find(SCROLL_CLASS), [view.panel.element as unknown as MockEl]);
    expect(new Map(style(view).entries())).toEqual(before);
  });

  it("actually provides whole-shell bounded overflow in the source CSS", () => {
    // Arithmetic/class assertions are mock evidence only; the suffix must
    // genuinely provide a bounded whole-shell scroller and natural inner
    // flow, otherwise the footer would still leak outside the shell.
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const suffix = css.slice(89126);
    const block = (selector: string): string => {
      const start = suffix.indexOf(selector);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      const open = suffix.indexOf("{", start);
      const close = suffix.indexOf("}", open);
      return suffix.slice(open, close);
    };
    const shell = block(".paper-notes-library-filter-panel.is-short-height {");
    expect(shell).toContain("overflow-y: auto");
    expect(shell).toContain("overscroll-behavior: contain");
    const form = block(
      ".paper-notes-library-filter-panel.is-short-height\n  > .paper-notes-library-filter-form {",
    );
    // Natural content height: no forced flex share and no inner cap.
    expect(form).toContain("flex: 0 0 auto");
    expect(form).toContain("max-height: none");
    const scroller = block(
      ".paper-notes-library-filter-panel.is-short-height\n  > .paper-notes-library-filter-form\n  > .paper-notes-library-filter-form-scroll {",
    );
    expect(scroller).toContain("flex: 0 0 auto");
    expect(scroller).toContain("overflow-y: visible");
    const footer = block(
      ".paper-notes-library-filter-panel.is-short-height\n  > .paper-notes-library-filter-form\n  > .paper-notes-library-filter-form-footer {",
    );
    expect(footer).toContain("flex-shrink: 0");
    // The normal chain is retained unchanged for ordinary heights.
    expect(suffix).toContain("container-type: inline-size");
  });
});

describe("resources", () => {
  it("registers and then drops every wrapper listener", () => {
    const view = mount();
    expect(view.win.listenerCount("resize")).toBe(1);
    // One captured pointerdown, keydown and scroll on the owner document.
    for (const type of ["pointerdown", "keydown", "scroll"]) {
      expect(view.doc.doc.listenerCount(type, true)).toBe(1);
    }
    expect(view.doc.doc.listenerTotal()).toBe(3);
    view.panel.close();
    expect(view.doc.doc.listenerTotal()).toBe(0);
    expect(view.win.listenerCount("resize")).toBe(0);
  });
});
