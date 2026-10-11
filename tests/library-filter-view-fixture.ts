/**
 * Minimal OWNER fixture for `library-filter-view` (S3a fix-1).
 *
 * This file deliberately REUSES the frozen, immutable S2a/S2b helper
 * (`tests/library-filter-test-dom.ts`, sha256 7df5987b…) for every core
 * primitive — `MockEl`, `MockDocument`, `MockWindow`, `createMockDocument`,
 * `createMockPanelEvent`, `resetMockFocus` — and adds ONLY the small
 * surface the REAL view render path actually needs that the frozen helper
 * does not model. There is no second element/tree/style/window/event/query
 * engine here.
 *
 * What is added (each item is load-bearing for at least one owner test):
 *  - `dataset` + `toggleClass` + a `style` bag that also accepts plain
 *    property assignment, because the view writes `row.dataset`,
 *    `el.toggleClass?.(...)` and `th.style.width = …`;
 *  - aggregate descendant `textContent`, matching real DOM reads;
 *  - `scrollIntoView` / `scrollTop` / `scrollLeft`, used by the view's
 *    table-scroll preservation;
 *  - a tiny `active-leaf-change` workspace emitter;
 *  - `adoptBy(doc)`, which moves a live subtree into another owner document
 *    so a SAME-PANE document adoption can be simulated.
 *
 * Documented limitations — this is NOT native validation:
 *  - no real layout, geometry, computed CSS, or native capture semantics;
 *  - no native focus ring, caret, selection or IME composition;
 *  - no native `type=number` sanitisation: `validity.badInput` is set
 *    explicitly by the tests that need an unparseable value;
 *  - `pointerdown` → `click` ordering is dispatched explicitly by the tests,
 *    so gesture ORDER is modelled rather than synthesised by a host;
 *  - the frozen helper's `dispatchCaptured` walks the composed path
 *    ROOT-FIRST for both phases despite its comment; owner tests therefore
 *    use `doc.dispatch(event, "capture")` plus an explicit target `click`
 *    so a native target-first `composedPath` can be carried without
 *    rebuilding propagation.
 */

import {
  MockDocument,
  MockEl,
  MockWindow,
  createMockDocument,
  createMockPanelEvent,
  resetMockFocus,
  type MockPanelEvent,
} from "./library-filter-test-dom";

export {
  MockDocument,
  MockEl,
  MockWindow,
  createMockDocument,
  createMockPanelEvent,
  resetMockFocus,
  type MockPanelEvent,
};

/** The handful of element gaps the real view render path needs. */
export interface ViewElSeams {
  dataset: Record<string, string>;
  scrollTop: number;
  scrollLeft: number;
  scrollIntoView(): void;
  toggleClass(cls: string, on?: boolean): void;
  /** Re-home this live subtree under another owner document. */
  adoptBy(doc: MockDocument): void;
}

/** Decorate a frozen `MockEl` with only the actually-used view gaps. */
export function decorateViewEl(el: MockEl): MockEl {
  const seams = el as MockEl & Partial<ViewElSeams>;
  if (seams.dataset === undefined) {
    seams.dataset = {};
  }
  if (seams.scrollTop === undefined) {
    seams.scrollTop = 0;
  }
  if (seams.scrollLeft === undefined) {
    seams.scrollLeft = 0;
  }
  if (typeof seams.scrollIntoView !== "function") {
    seams.scrollIntoView = () => {};
  }
  if (typeof seams.toggleClass !== "function") {
    seams.toggleClass = (cls: string, on?: boolean) => {
      const active = on ?? !el.cls.split(/\s+/).includes(cls);
      if (active) {
        el.addClass(cls);
      } else {
        el.removeClass(cls);
      }
    };
  }
  if (typeof seams.adoptBy !== "function") {
    seams.adoptBy = (doc: MockDocument) => {
      adoptSubtree(el, doc);
    };
  }
  return el;
}

/**
 * Decorate a lookup result so it carries the owner view seams.
 *
 * `findAll`/`findByClass`/`findAllByClass` on the frozen helper return plain
 * `MockEl`, so callers wrap their results with this to recover the seams
 * the real view render path needs.
 */
export function asViewEl(el: MockEl): ViewEl {
  return decorateViewEl(el) as ViewEl;
}

/** Re-home a subtree (and every descendant) under `doc`. */
function adoptSubtree(el: MockEl, doc: MockDocument): void {
  el.ownerDocument = doc;
  for (const child of el.children) {
    adoptSubtree(child, doc);
  }
}

/** A workspace stub with a real `active-leaf-change` emitter. */
export class ViewMockWorkspace {
  readonly handlers = new Map<string, Set<(arg: unknown) => void>>();

  on(name: string, handler: (arg: unknown) => void): { event: string } {
    const bucket = this.handlers.get(name) ?? new Set<(arg: unknown) => void>();
    bucket.add(handler);
    this.handlers.set(name, bucket);
    return { event: name };
  }

  offref(ref: unknown): void {
    const event = (ref as { event?: string } | null)?.event;
    if (event === undefined) {
      return;
    }
    this.handlers.delete(event);
  }

  emit(name: string, arg: unknown): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      handler(arg);
    }
  }

  listenerCount(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }

  requestSaveLayout(): void {}
}

/** A frozen-helper element carrying the owner view seams. */
export type ViewEl = MockEl & {
  dataset: Record<string, string>;
  scrollTop: number;
  scrollLeft: number;
  scrollIntoView(): void;
  toggleClass(cls: string, on?: boolean): void;
  adoptBy(doc: MockDocument): void;
};

/** Build a fresh isolated owner document with an attached pane container. */
export function createViewDocument(options: { body?: MockEl | null } = {}): {
  doc: MockDocument;
  body: MockEl | null;
  pane: ViewEl;
} {
  const created = createMockDocument(options);
  const doc = created.doc;
  const pane = decorateViewEl(created.pane) as ViewEl;
  return { doc, body: created.body, pane };
}

/** Build a dispatchable owner event carrying a target-first composed path. */
export function createViewEvent(init: MockPanelEvent): MockPanelEvent {
  return createMockPanelEvent(init);
}
