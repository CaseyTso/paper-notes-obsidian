/**
 * Minimal faithful DOM helper for `library-filter-form` tests (S2a).
 *
 * A tiny, purpose-built stand-in for the Obsidian `HTMLElement` surface the
 * form actually uses: `createEl`/`createDiv`, `empty`, `addClass`,
 * `removeClass`, `setAttribute`/`getAttribute`/`removeAttribute`,
 * `addEventListener`/`removeEventListener`/`dispatchEvent` and the `value`
 * / `checked` / `disabled` / `hidden` / `validity` control properties.
 *
 * Deliberately NOT a browser engine: there is no real focus, caret,
 * selection, layout, native `type=number` sanitisation or key→click
 * synthesis. Tests assert event contracts, node identity and state only.
 */

/** The subset of a native `ValidityState` the form reads. */
export interface MockValidity {
  badInput: boolean;
}

/** The subset of a native input element the form reads. */
export interface MockInputLike {
  value: string;
  checked?: boolean;
  validity?: MockValidity;
}

export interface MockElOptions {
  cls?: string;
  text?: string;
  value?: string;
  type?: string;
  attr?: Record<string, string | number | boolean | null>;
}

/** Options a `createEl` call may carry (subset of Obsidian's `DomElementInfo`). */
export type MockDomElementInfo = MockElOptions;

export class MockEl {
  readonly tag: string;
  cls = "";
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  children: MockEl[] = [];
  parent: MockEl | null = null;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly attrs = new Map<string, string>();
  /** Only meaningful for `input` elements: mirrors the native API. */
  validity: MockValidity = { badInput: false };
  /** Number of times `focus()` was called on this element. */
  private focusLog = 0;
  /** Records dispatched event types (used to assert local listener cleanup). */
  readonly received: string[] = [];
  /** Simulated inline style bag the S2b overlay writes geometry into. */
  readonly style = new MockStyle();
  /** Simulated layout rect in viewport coordinates (S2b geometry seam). */
  rect = { top: 0, left: 0, right: 0, bottom: 0 };
  /** Whether the node currently sits in the owner document tree. */
  connected = false;

  /** Native-equivalent `isConnected`, driven by `attach()`. */
  get isConnected(): boolean {
    return this.connected;
  }

  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number } {
    return { ...this.rect };
  }

  /** Attach this element (and its subtree) to the owner document tree. */
  attach(): void {
    this.connected = true;
    for (const child of this.children) {
      child.attach();
    }
  }

  /** Detach this element (and its subtree) from the owner document tree. */
  detach(): void {
    this.connected = false;
    for (const child of this.children) {
      child.detach();
    }
  }
  /**
   * Simulated owner document: only `activeElement`, `createElement` and the
   * parent link the form actually reads. Clearly a simulation, NOT a proof of
   * real browser focus.
   *
   * Reassignable by the S2b document fixture so an isolated owner document
   * can be handed to freshly created elements.
   */
  ownerDocument: MockDocument;

  constructor(tag: string, doc?: MockDocument) {
    this.tag = tag;
    this.ownerDocument = doc ?? sharedDocument;
    sharedDocument.register(this);
    if (tag === "input" || tag === "select") {
      this.value = "";
    }
  }

  // ── tree operations used by the journal reconciliation ─────────────

  get firstChild(): MockEl | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): MockEl | null {
    const parent = this.parent;
    if (parent === null) {
      return null;
    }
    const index = parent.children.indexOf(this);
    return parent.children[index + 1] ?? null;
  }

  get parentNode(): MockEl | null {
    return this.parent;
  }

  appendChild(child: MockEl): MockEl {
    if (child.parent !== null) {
      child.parent.children = child.parent.children.filter((c) => c !== child);
    }
    child.parent = this;
    this.children.push(child);
    if (this.connected) {
      child.attach();
    }
    simulateMoveFocusLoss(child);
    return child;
  }

  insertBefore(child: MockEl, reference: MockEl | null): MockEl {
    // A node already in the requested position is a no-op and must not
    // disturb focus.
    if (child.parent === this && child === reference) {
      return child;
    }
    if (child.parent !== null) {
      child.parent.children = child.parent.children.filter((c) => c !== child);
    }
    if (reference === null) {
      this.children.push(child);
    } else {
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }
    child.parent = this;
    if (this.connected) {
      child.attach();
    }
    simulateMoveFocusLoss(child);
    return child;
  }

  createElement(tag: string): MockEl {
    return new MockEl(tag, this.ownerDocument);
  }

  /** Simulated focus: records the element as the document active element. */
  focus(): void {
    this.focusLog += 1;
    this.ownerDocument.activeElement = this;
  }

  /** Recorded `focus()` calls (used to assert the deliberate handoff). */
  focusCalls(): number {
    return this.focusLog;
  }

  // ── Obsidian element helpers ───────────────────────────────────────

  addClass(cls: string): void {
    for (const token of cls.split(/\s+/).filter(Boolean)) {
      if (!this.cls.split(/\s+/).includes(token)) {
        this.cls = this.cls.length > 0 ? `${this.cls} ${token}` : token;
      }
    }
  }

  removeClass(cls: string): void {
    this.cls = this.cls
      .split(/\s+/)
      .filter((token) => token.length > 0 && token !== cls)
      .join(" ");
  }

  empty(): void {
    // Detaching is truthful here: an emptied subtree is no longer connected,
    // so `isConnected`/`isAttached` reads agree with the tree.
    for (const child of this.children) {
      child.detach();
    }
    this.children = [];
  }
  /** Detach from the mock parent (used by `dispose()`). */
  remove(): void {
    const parent = this.parent;
    if (parent === null) {
      return;
    }
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = null;
    this.detach();
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  createEl(tag: string, options: MockElOptions = {}): MockEl {
    // Inherit the owner document, so a subtree built under a fresh document
    // keeps reporting that document (the S2b overlay reads `activeElement`
    // and mounts through `ownerDocument.body`).
    const child = new MockEl(tag, this.ownerDocument);
    if (options.cls !== undefined) {
      child.addClass(options.cls);
    }
    if (options.text !== undefined) {
      child.textContent = options.text;
    }
    if (options.value !== undefined) {
      child.value = String(options.value);
    }
    if (options.type !== undefined) {
      child.attrs.set("type", options.type);
    }
    if (options.attr !== undefined) {
      for (const [key, value] of Object.entries(options.attr)) {
        child.attrs.set(key, value === null || value === undefined ? "" : String(value));
      }
    }
    child.parent = this;
    this.children.push(child);
    // A child created under an attached host is itself attached.
    if (this.connected) {
      child.attach();
    }
    return child;
  }

  createDiv(options: MockElOptions = {}): MockEl {
    return this.createEl("div", options);
  }

  createSpan(options: MockElOptions = {}): MockEl {
    return this.createEl("span", options);
  }

  // ── attributes ─────────────────────────────────────────────────────

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "hidden") {
      this.hidden = true;
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "hidden") {
      this.hidden = false;
    }
  }

  // ── events ─────────────────────────────────────────────────────────

  /** Total number of registered listeners on this element. */  listenerCount(): number {
    let total = 0;
    for (const bucket of this.listeners.values()) {
      total += bucket.size;
    }
    return total;
  }

  /** Listeners on this element and every descendant (cleanup evidence). */
  subtreeListenerCount(): number {
    let total = this.listenerCount();
    for (const child of this.children) {
      total += child.subtreeListenerCount();
    }
    return total;
  }

  // ── queries used by the tests ──────────────────────────────────────

  findAll(predicate: (el: MockEl) => boolean): MockEl[] {
    const found: MockEl[] = [];
    const walk = (el: MockEl): void => {
      for (const child of el.children) {
        if (predicate(child)) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  findByClass(cls: string): MockEl {
    const found = this.findAll((el) => el.cls.split(/\s+/).includes(cls));
    if (found.length === 0) {
      throw new Error(`mock element not found: ${cls}`);
    }
    return found[0] as MockEl;
  }

  findAllByClass(cls: string): MockEl[] {
    return this.findAll((el) => el.cls.split(/\s+/).includes(cls));
  }

  byTag(tag: string): MockEl[] {
    return this.findAll((el) => el.tag === tag);
  }

  text(): string {
    return this.findAll((el) => el.tag === "span")
      .map((el) => el.textContent)
      .join(" ");
  }

  /** First element (self included) matching a single class selector. */
  querySelector(selector: string): MockEl | null {
    const cls = selector.startsWith(".") ? selector.slice(1) : selector;
    const matches = (el: MockEl): boolean =>
      el.cls.split(/\s+/).includes(cls);
    if (matches(this)) {
      return this;
    }
    return this.findAll(matches)[0] ?? null;
  }

  /**
   * `querySelectorAll` for the single-selector forms the S2b seam uses:
   * `input` (tag) or `.class`. Combined selectors are not needed.
   */
  querySelectorAll(selector: string): MockEl[] {
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return this.findAll((el) => el.cls.split(/\s+/).includes(cls));
    }
    return this.findAll((el) => el.tag === selector);
  }

  /** Whether `node` is this element or a descendant (mock subset). */
  contains(node: MockEl | null): boolean {
    if (node === null) {
      return false;
    }
    if (node === this) {
      return true;
    }
    return this.children.some((child) => child.contains(node));
  }

  // ── capture-aware events (S2b seam) ────────────────────────────────

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    capture = false,
  ): void {
    const key = capture ? `${type}__capture` : type;
    const bucket = this.listeners.get(key) ?? new Set<(event: unknown) => void>();
    bucket.add(handler);
    this.listeners.set(key, bucket);
  }

  removeEventListener(
    type: string,
    handler: (event: unknown) => void,
    capture = false,
  ): void {
    const key = capture ? `${type}__capture` : type;
    this.listeners.get(key)?.delete(handler);
  }

  dispatchEvent(
    event: { type: string },
    phase: "bubble" | "capture" = "bubble",
  ): boolean {
    this.received.push(event.type);
    const key = phase === "capture" ? `${event.type}__capture` : event.type;
    for (const handler of [...(this.listeners.get(key) ?? [])]) {
      handler(event);
    }
    return true;
  }

  /**
   * Dispatch along `event.composedPath` like the native DOM: every capture
   * listener root-first, then every bubble listener target-first.
   *
   * `stopPropagation` ends the walk early and `stopImmediatePropagation`
   * also drops the remaining listeners on the current node. Returns whether
   * a captured handler stopped propagation, so a test can prove an event
   * never reached the owner window.
   */
  dispatchCaptured(event: MockPanelEvent): boolean {
    const chain = (pathOf(event) ?? [event.target ?? this]).filter(
      (node): node is MockEl => node instanceof MockEl,
    );
    const ordered = chain.length > 0 ? chain : [this];
    const stopped = (): boolean => event.stopped === true;
    for (const node of ordered) {
      if (stopped()) {
        break;
      }
      node.dispatchEvent(event, "capture");
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (stopped()) {
        break;
      }
      (ordered[index] as MockEl).dispatchEvent(event, "bubble");
    }
    return stopped();
  }
}
/**
 * Minimal simulated document: `activeElement` plus element registration. The
 * form reads `ownerDocument.activeElement` only to decide the deliberate
 * focus handoff; this is a simulation, not native focus behaviour.
 */
export class MockDocument {
  activeElement: MockEl | null = null;
  /** Simulated owner window; may be absent for a headless host. */
  defaultView: MockWindow | null = null;
  private bodyHost: MockEl | null;
  /**
   * Whether this document exposes a `body`. A headless owner document may
   * not, in which case the S2b panel falls back to its declared container.
   */
  private readonly hasBody: boolean;

  constructor(options: { body?: MockEl | null } = {}) {
    this.bodyHost = options.body ?? null;
    this.hasBody = options.body !== null;
  }

  /** Simulated owner `body`; the S2b overlay mounts here. */
  get body(): MockEl | null {
    if (!this.hasBody) {
      return null;
    }
    // Created lazily: the module-level shared document would otherwise read
    // `sharedDocument` before it is initialised.
    if (this.bodyHost === null) {
      const created = new MockEl("body", this);
      created.attach();
      this.bodyHost = created;
    }
    return this.bodyHost;
  }

  createElement(tag: string): MockEl {
    return new MockEl(tag, this);
  }

  /** Document-level event target (S2b captures dismissal here). */
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    capture = false,
  ): void {
    const key = capture ? `${type}__capture` : type;
    const bucket = this.listeners.get(key) ?? new Set<(event: unknown) => void>();
    bucket.add(handler);
    this.listeners.set(key, bucket);
  }

  removeEventListener(
    type: string,
    handler: (event: unknown) => void,
    capture = false,
  ): void {
    const key = capture ? `${type}__capture` : type;
    this.listeners.get(key)?.delete(handler);
  }

  /**
   * Dispatch like the native document: the document itself first (capture),
   * then the body chain root-first, then the bubble chain target-first, and
   * finally the owner WINDOW bubble listeners — but only when propagation
   * was not stopped. Returns whether a captured handler stopped it.
   */
  dispatchCaptured(event: MockPanelEvent): boolean {
    const body = this.body as MockEl;
    const chain = (pathOf(event) ?? [event.target ?? body]).filter(
      (node): node is MockEl => node instanceof MockEl,
    );
    const ordered = chain.length > 0 ? chain : [body];
    this.dispatch(event, "capture");
    for (const node of ordered) {
      if (event.stopped === true) {
        break;
      }
      node.dispatchEvent(event, "capture");
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (event.stopped === true) {
        break;
      }
      (ordered[index] as MockEl).dispatchEvent(event, "bubble");
    }
    if (event.stopped !== true) {
      this.dispatch(event, "bubble");
    }
    // The window is the outermost bubble target, exactly as in a browser:
    // a suppressed event never reaches it, an unsuppressed one does.
    if (event.stopped !== true && this.defaultView !== null) {
      this.defaultView.dispatchEvent(event.type, event);
    }
    return event.stopped === true;
  }

  /** Dispatch to this document's own listeners for one phase. */
  dispatch(event: { type: string }, phase: "bubble" | "capture" = "bubble"): void {
    const key = phase === "capture" ? `${event.type}__capture` : event.type;
    for (const handler of [...(this.listeners.get(key) ?? [])]) {
      handler(event);
    }
  }

  /** Listener count for one (possibly capture-qualified) key. */
  listenerCount(type: string, capture = false): number {
    const key = capture ? `${type}__capture` : type;
    return this.listeners.get(key)?.size ?? 0;
  }

  /** Total registered listener count (cleanup evidence). */
  listenerTotal(): number {
    let total = 0;
    for (const bucket of this.listeners.values()) {
      total += bucket.size;
    }
    return total;
  }

  /** @internal */
  register(_el: MockEl): void {
    // Registration is intentionally trivial: no global element registry is
    // needed because activeElement is tracked directly by focus().
  }
}

const sharedDocument = new MockDocument();

/** Build a detached host element, like an Obsidian container `div`. */
export function createMockContainer(): MockEl {
  return new MockEl("div");
}

/**
 * Build a fresh owner document (own body) with an attached pane container.
 * Each call returns an isolated document, so an S2b test can mount one
 * overlay without observing another test's nodes.
 */
export function createMockDocument(options: { body?: MockEl | null } = {}): {
  doc: MockDocument;
  body: MockEl | null;
  pane: MockEl;
} {
  const doc = new MockDocument(options);
  const host = doc.body;
  const pane = new MockEl("div", doc);
  if (host !== null) {
    host.appendChild(pane);
  } else {
    pane.attach();
  }
  return { doc, body: host, pane };
}

/** Reset the simulated focus state between tests. */
export function resetMockFocus(): void {
  sharedDocument.activeElement = null;
}

/**
 * Controlled simulation of the native rule that moving an already-attached,
 * focused node drops its focus. Only `appendChild`/`insertBefore` call this,
 * so a no-op reposition never disturbs focus. This is a call-contract model
 * for the regression tests, NOT evidence of real browser behaviour.
 */
function simulateMoveFocusLoss(child: MockEl): void {
  if (sharedDocument.activeElement === child && child.parent !== null) {
    sharedDocument.activeElement = null;
  }
}

/** Simulate typing into a control: set the value, then dispatch `input`. */
export function typeInto(input: MockEl, value: string): void {
  input.value = value;
  input.dispatchEvent({ type: "input" });
}

// ── S2b minimal overlay extensions (append-only) ─────────────────────
// Only the surface the S2b panel wrapper actually uses: a style bag for the
// geometry it writes, a layout rect, `querySelectorAll`, capture-aware event
// registration/dispatch with `composedPath`, and a document/window pair.
// Still NOT a browser engine: no layout, hit-testing or native capture
// semantics. Everything above is the untouched accepted S2a base.

/**
 * A tiny inline-style bag: the S2b overlay writes geometry through
 * `setProperty`, exactly like a real `CSSStyleDeclaration`.
 */
export class MockStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  get size(): number {
    return this.values.size;
  }

  entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }
}

/** A mock event the overlay seam can carry a composed path on. */
export interface MockPanelEvent {
  type: string;
  /** Ordered dispatch path (root first), like the native accessor. */
  composedPath?: (() => unknown[]) | readonly unknown[];
  /** Element the event was aimed at. */
  target?: unknown;
  key?: string;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  /** Set when a captured handler stopped propagation. */
  stopped?: boolean;
  preventDefault?(): void;
  stopPropagation?(): void;
  stopImmediatePropagation?(): void;
}

/**
 * Build a dispatchable mock event carrying the native prevention methods
 * and the `composedPath()` accessor the S2b handlers call.
 */
export function createMockPanelEvent(init: MockPanelEvent): MockPanelEvent {
  const path = init.composedPath;
  const event: MockPanelEvent = { ...init };
  if (path !== undefined) {
    event.composedPath =
      typeof path === "function" ? path : () => [...path];
  }
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  event.stopPropagation = () => {
    event.stopped = true;
  };
  event.stopImmediatePropagation = () => {
    event.stopped = true;
  };
  return event;
}

/** A minimal owner-window stand-in: resize listeners plus viewport size. */
export class MockWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  innerWidth = 1200;
  innerHeight = 800;

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(handler);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(type: string, event: unknown = { type }): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** Read a mock event's composed path, mirroring the native accessor. */
function pathOf(event: MockPanelEvent): unknown[] | undefined {
  if (typeof event.composedPath !== "function") {
    return undefined;
  }
  return event.composedPath();
}
