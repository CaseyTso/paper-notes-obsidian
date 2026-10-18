/**
 * Anchored Library Filter overlay (plan v1, stage S2b).
 *
 * A small nonmodal wrapper around the accepted pending
 * {@link LibraryFilterForm}. It owns mounting, positioning and dismissal
 * only — validation, control state and the journal chooser stay frozen in
 * the form and are never reimplemented here.
 *
 * Lifecycle (frozen for the S3 owner):
 * - mount once into `anchor.ownerDocument.body`, falling back to the
 *   declared pane container only when no body is available. The overlay
 *   therefore lives OUTSIDE the originating pane subtree, so the owner may
 *   empty or rerender its pane without disturbing the open panel;
 * - `close()` discards the pending draft, tears everything down, notifies
 *   `onClose` exactly once and returns focus to the latest connected live
 *   anchor;
 * - `dispose()` is the silent variant for a dead owner view/navigation: no
 *   `onClose`, no focus move. The owner clears its own reference;
 * - a valid Apply runs the owner callback BEFORE teardown, so the owner may
 *   rerender and call `setAnchor` with a new trigger; the normal close then
 *   focuses that live trigger.
 *
 * Geometry is synchronous and bounded: the panel is clamped to the
 * intersection of the pane rect and the owner viewport with a small margin,
 * prefers the space below the anchor, falls back to above, and finally to a
 * bounded overlap rather than pushing the footer off-pane. No intrinsic
 * content measurement, no timers, no observers, no DOM rebuild while the
 * user edits.
 */

import { LibraryFilterForm } from "./library-filter-form";
import type { LibraryFilters } from "../shared/library-filters";

/** Root class of the overlay shell (append-only CSS namespace). */
const PANEL_CLASS = "paper-notes-library-filter-panel";
/** Class of the visible form title the dialog is labelled by. */
const TITLE_CLASS = "paper-notes-library-filter-form-title";
/** Id suffix of the first numeric control (year from). */
const FIRST_NUMERIC_SUFFIX = "-yearFrom";

/** Gap kept between the panel and the pane/anchor edges. */
const MARGIN = 8;
/** Compact maximum overlay width / height (defaults, never a minimum). */
const MAX_WIDTH = 360;
const MAX_HEIGHT = 560;
/**
 * Available height below which the fixed shell chrome (padding, border,
 * header, form padding and the nonshrinking footer) can no longer fit
 * comfortably. Below this budget the shell itself scrolls and the inner
 * form flows at its natural content height, so no field collapses to an
 * inaccessible zero height and the footer stays reachable.
 *
 * A conservative CONSTANT budget: there is deliberately no intrinsic
 * measuring machinery and no re-expansion while the user edits.
 */
const SHORT_HEIGHT_BUDGET = 200;
/** Class applied to the shell while the short-height fallback is active. */
const SHORT_CLASS = "is-short-height";

/** Axis-aligned box in viewport coordinates. */
interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Construction options for {@link LibraryFilterPanel}. */
export interface LibraryFilterPanelOptions {
  /** Stable trigger the overlay is anchored to and returns focus to. */
  anchor: HTMLElement;
  /** Originating pane: bounds source and fallback mount host. */
  container: HTMLElement;
  /** Applied Library Filters the pending draft starts from. */
  filters: LibraryFilters;
  /** Whole-library journal roster. */
  journals: readonly string[];
  /** Called once with a fresh validated snapshot on explicit Apply. */
  onApply(filters: LibraryFilters): void;
  /** Called exactly once when the overlay closes for any reason. */
  onClose(): void;
}

export class LibraryFilterPanel {
  /** Overlay root element (mounted in the owner document body). */
  readonly element: HTMLElement;

  private readonly options: LibraryFilterPanelOptions;
  /** Owner document of the anchor (inherited by every node we create). */
  private readonly doc: Document;
  /** Owner window of the anchor, when one exists. */
  private readonly win: Window | null;
  /** Originating pane element, used for bounds only. */
  private readonly pane: HTMLElement;
  private readonly form: LibraryFilterForm;
  private readonly teardown: Array<() => void> = [];

  /** Latest trigger; updated by `setAnchor`, never by geometry. */
  private anchor: HTMLElement;
  private closed = false;
  private disposed = false;
  /** Reentrancy guard around the owner Apply callback. */
  private applying = false;
  /** Whether the short-height whole-shell scroll fallback is active. */
  private shortHeight = false;

  constructor(options: LibraryFilterPanelOptions) {
    this.options = options;
    this.anchor = options.anchor;
    this.pane = options.container;
    this.doc = options.anchor.ownerDocument;
    this.win = this.doc.defaultView;

    const host = this.mountHost();
    this.element = host.createDiv({ cls: PANEL_CLASS });
    this.element.setAttribute("role", "dialog");

    const header = this.element.createDiv({ cls: `${PANEL_CLASS}-header` });
    const closeButton = header.createEl("button", {
      cls: `${PANEL_CLASS}-close`,
      attr: { type: "button", "aria-label": "Close library filters" },
      text: "Close",
    });
    this.listen(closeButton, "click", () => this.close());

    this.form = new LibraryFilterForm({
      container: this.element,
      filters: options.filters,
      journals: options.journals,
      onApply: (filters) => this.handleApply(filters),
      onCancel: () => this.close(),
    });
    this.labelByFormTitle();

    // Outside dismissal and Escape are captured on the owner document, so
    // they run before any ancestor (window) bubble handler such as the
    // library detail drawer's Escape shortcut.
    this.listen(this.doc, "pointerdown", this.handlePointerDown, true);
    this.listen(this.doc, "keydown", this.handleKeyDown, true);
    // External pane scroll repositions; the overlay's own scroller does not.
    this.listen(this.doc, "scroll", this.handleScroll, true);
    if (this.win !== null) {
      this.listen(this.win, "resize", this.handleViewportChange);
    }

    this.syncPosition();
    // Explicit open may move focus once; nothing below ever steals it.
    this.focusFirstNumeric();
  }

  /** Replace the trigger and the derived geometry only. */
  setAnchor(anchor: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    this.anchor = anchor;
    if (!this.closed) {
      this.syncPosition();
    }
  }

  /** Delegate to the accepted form: pending state and focus are preserved. */
  setJournalOptions(journals: readonly string[]): void {
    if (this.disposed || this.closed) {
      return;
    }
    this.form.setJournalOptions(journals);
  }

  /**
   * Discard the pending draft and dismiss: teardown, one `onClose`, then
   * focus back on the latest connected live anchor. Inert once closed.
   */
  close(): void {
    if (this.closed || this.disposed) {
      return;
    }
    this.closed = true;
    this.tearDown();
    this.options.onClose();
    this.returnFocus();
  }

  /**
   * Silent owner cleanup for a dead view or navigation: no `onClose` and no
   * focus move, because the anchor may already be gone. Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.closed = true;
    this.tearDown();
  }

  // ── apply ───────────────────────────────────────────────────────────

  /**
   * The owner runs BEFORE any teardown, so it may rerender the pane and
   * call `setAnchor` with the new trigger. Teardown then happens in a
   * `finally`, so a throwing callback cannot leak listeners, and a
   * reentrant `dispose`/`close` wins without a duplicate signal.
   */
  private handleApply(filters: LibraryFilters): void {
    if (this.closed || this.disposed || this.applying) {
      return;
    }
    this.applying = true;
    try {
      this.options.onApply(filters);
    } finally {
      this.applying = false;
      this.close();
    }
  }

  // ── dismissal ───────────────────────────────────────────────────────

  /**
   * Outside pointer press. `composedPath()` is read at dispatch time, so an
   * internal activation whose target is replaced by a re-render still counts
   * as inside. A detached target that never belonged to the overlay is
   * outside, and the containment fallback covers hosts without
   * `composedPath`.
   */
  private handlePointerDown = (event: Event): void => {
    if (this.closed || this.disposed) {
      return;
    }
    const path = pathOf(event);
    const inside =
      path.length > 0
        ? path.includes(this.element) || this.containsTarget(event)
        : this.containsTarget(event);
    if (!inside) {
      this.close();
    }
  };

  /**
   * Escape is captured and stopped, so the existing window BUBBLE detail
   * drawer shortcut never sees it.
   *
   * Ordinary Escape prevents the default action and closes. A COMPOSING
   * Escape (an IME mid-composition cancel) keeps the popup open and leaves
   * the native IME default action untouched, but still consumes
   * propagation: the root window-bubble drawer handler has no composition
   * guard, so cancelling a composition must never dismiss it. Only Escape
   * is handled; every other key propagates untouched and no key is trapped.
   */
  private handleKeyDown = (event: Event): void => {
    if (this.closed || this.disposed) {
      return;
    }
    const key = (event as KeyboardEvent).key;
    if (key !== "Escape") {
      return;
    }
    // Consume propagation in both cases BEFORE the composing check, so a
    // composition cancel can never reach the window bubble handler.
    event.stopImmediatePropagation();
    event.stopPropagation();
    if ((event as KeyboardEvent).isComposing === true) {
      // Deliberately NO preventDefault: the IME owns the default action.
      return;
    }
    event.preventDefault();
    this.close();
  };

  /** External scroll repositions; the overlay's own scroller is ignored. */
  private handleScroll = (event: Event): void => {
    if (this.closed || this.disposed) {
      return;
    }
    if (pathOf(event).includes(this.element)) {
      return;
    }
    this.syncPosition();
  };

  private handleViewportChange = (): void => {
    if (this.closed || this.disposed) {
      return;
    }
    this.syncPosition();
  };

  // ── teardown / focus ────────────────────────────────────────────────

  /** Drop every wrapper listener, dispose the form and detach the shell. */
  private tearDown(): void {
    for (const off of this.teardown.splice(0)) {
      off();
    }
    this.form.dispose();
    this.element.remove();
  }

  /** Focus the latest live anchor; never a detached or dead trigger. */
  private returnFocus(): void {
    if (this.disposed) {
      return;
    }
    if (!isAttached(this.anchor)) {
      return;
    }
    this.anchor.focus();
  }

  /** Move focus to the first numeric control, at most once per open. */
  private focusFirstNumeric(): void {
    const inputs = this.form.element.querySelectorAll("input");
    const first = Array.from(inputs).find(
      (input) => (input.getAttribute("id") ?? "").endsWith(FIRST_NUMERIC_SUFFIX),
    );
    if (first !== undefined) {
      (first as HTMLElement).focus();
    }
  }

  /** Point the dialog at the visible form title. */
  private labelByFormTitle(): void {
    const title = this.form.element.querySelector(`.${TITLE_CLASS}`);
    const titleId = title?.getAttribute("id");
    if (typeof titleId === "string" && titleId.length > 0) {
      this.element.setAttribute("aria-labelledby", titleId);
    }
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    capture = false,
  ): void {
    target.addEventListener(type, handler, capture);
    this.teardown.push(() => target.removeEventListener(type, handler, capture));
  }

  // ── mounting / geometry ─────────────────────────────────────────────

  /** Body mount, with the declared pane container as the only fallback. */
  private mountHost(): HTMLElement {
    const body = this.doc.body;
    return body ?? this.pane;
  }

  /** Synchronous bounded placement; never touches fields or focus. */
  private syncPosition(): void {
    if (this.closed || this.disposed) {
      return;
    }
    const box = this.computeBox();
    // `setProperty` works on a real CSSStyleDeclaration and on the mock
    // style bag alike; plain assignment would not.
    const style = this.element.style;
    style.setProperty("left", `${box.left}px`);
    style.setProperty("top", `${box.top}px`);
    style.setProperty("width", `${box.right - box.left}px`);
    style.setProperty("height", `${box.bottom - box.top}px`);
    style.setProperty("max-width", `${box.right - box.left}px`);
    style.setProperty("max-height", `${box.bottom - box.top}px`);
    this.applyHeightMode(box.bottom - box.top);
  }

  /**
   * Switch the whole-shell scroll fallback only when the capacity CLASS
   * changes. The mode is a pure class toggle: no control is remounted, no
   * focus moves, no raw draft/selection is reset and no scrollTop is
   * disturbed.
   */
  private applyHeightMode(availableHeight: number): void {
    const short = availableHeight < SHORT_HEIGHT_BUDGET;
    if (short === this.shortHeight) {
      return;
    }
    this.shortHeight = short;
    // `addClass`/`removeClass` exist on Obsidian's HTMLElement and on the
    // test mock; the class list itself is the only thing that changes.
    if (short) {
      this.element.addClass(SHORT_CLASS);
    } else {
      this.element.removeClass(SHORT_CLASS);
    }
  }

  private computeBox(): Box {
    const view = this.viewportBox();
    const pane = rectOf(this.pane);
    const paneUsable = pane.right > pane.left && pane.bottom > pane.top;
    const available = paneUsable ? intersect(view, pane) : view;
    const anchor = isAttached(this.anchor) ? rectOf(this.anchor) : available;

    const width = Math.min(
      MAX_WIDTH,
      Math.max(0, available.right - available.left - 2 * MARGIN),
    );
    const height = Math.min(
      MAX_HEIGHT,
      Math.max(0, available.bottom - available.top - 2 * MARGIN),
    );
    const left = clamp(
      anchor.left,
      available.left,
      Math.max(available.left, available.right - width),
    );

    const below = anchor.bottom + MARGIN;
    const above = anchor.top - MARGIN - height;
    let top: number;
    if (below + height <= available.bottom) {
      top = below;
    } else if (above >= available.top) {
      top = above;
    } else {
      // Neither side fits: a bounded overlap beats an off-pane footer.
      top = clamp(
        anchor.top,
        available.top,
        Math.max(available.top, available.bottom - height),
      );
    }
    return { top, left, right: left + width, bottom: top + height };
  }

  private viewportBox(): Box {
    const win = this.win;
    if (win === null) {
      return rectOf(this.pane);
    }
    return {
      top: 0,
      left: 0,
      right: win.innerWidth,
      bottom: win.innerHeight,
    };
  }

  private containsTarget(event: Event): boolean {
    const target = event.target;
    if (target === null || target === undefined) {
      return false;
    }
    return this.element.contains(target as Node);
  }
}

/** Composed path at dispatch time; empty when the host cannot provide one. */
function pathOf(event: Event): unknown[] {
  if (typeof event.composedPath !== "function") {
    return [];
  }
  return event.composedPath() as unknown[];
}

function rectOf(el: HTMLElement): Box {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
}

function intersect(a: Box, b: Box): Box {
  return {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Real `isConnected` when present, parent attachment otherwise. */
function isAttached(el: HTMLElement): boolean {
  return typeof el.isConnected === "boolean"
    ? el.isConnected
    : el.parentNode !== null;
}
