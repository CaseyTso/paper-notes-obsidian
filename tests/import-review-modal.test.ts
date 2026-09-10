import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingWebReview } from "../src/services/web-capture-actions";
import { ImportReviewModal } from "../src/modals/import-review-modal";

const { ElStub, ModalStub } = vi.hoisted(() => {
  interface ElOpts {
    cls?: string;
    text?: string;
    value?: string;
    attr?: Record<string, unknown>;
  }

  class ElStub {
    tag: string;
    cls = "";
    textContent = "";
    value = "";
    checked = false;
    disabled = false;
    parentElement: ElStub | null = null;
    children: ElStub[] = [];
    listeners: Record<string, Array<(event?: any) => void>> = {};
    attrs: Record<string, string> = {};

    constructor(tag: string) {
      this.tag = tag;
    }

    addEventListener(type: string, fn: (event?: any) => void): void {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(fn);
    }

    removeEventListener(type: string, fn: (event?: any) => void): void {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((cb) => cb !== fn);
    }

    dispatchEvent(event: { type: string; [key: string]: any }): boolean {
      const list = this.listeners[event.type] ? [...this.listeners[event.type]] : [];
      for (const fn of list) {
        fn(event);
      }
      return true;
    }

    addClass(cls: string): void {
      for (const token of cls.split(/\s+/).filter(Boolean)) {
        if (!this.hasClass(token)) {
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

    hasClass(cls: string): boolean {
      return this.cls.split(/\s+/).includes(cls);
    }

    setText(text: string): void {
      this.textContent = text;
    }

    empty(): void {
      for (const child of this.children) {
        child.parentElement = null;
      }
      this.children = [];
    }

    createDiv(opts?: ElOpts): ElStub {
      return this.createEl("div", opts);
    }

    createEl(tag: string, opts?: ElOpts): ElStub {
      const child = new ElStub(tag);
      child.parentElement = this;
      if (opts?.cls !== undefined) {
        child.addClass(opts.cls);
      }
      if (opts?.text !== undefined) {
        child.textContent = opts.text;
      }
      if (opts?.value !== undefined) {
        child.value = String(opts.value);
      }
      if (opts?.attr !== undefined) {
        for (const [key, value] of Object.entries(opts.attr)) {
          child.attrs[key] = String(value);
        }
      }
      this.children.push(child);
      return child;
    }

    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }

    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }

    focus(): void {}

    matches(selector: string): boolean {
      const s = selector.trim();
      if (s.includes(",")) {
        return s.split(",").some((part) => this.matches(part));
      }
      if (s.includes("[") && s.endsWith("]")) {
        const bracketIdx = s.indexOf("[");
        const tagPart = s.slice(0, bracketIdx).trim();
        const attrPart = s.slice(bracketIdx + 1, -1).trim();
        if (tagPart && this.tag.toLowerCase() !== tagPart.toLowerCase()) {
          return false;
        }
        if (attrPart.includes("=")) {
          const [attr, val] = attrPart.split("=");
          const cleanVal = val.replace(/^["']|["']$/g, "");
          return this.attrs[attr] === cleanVal;
        }
        return attrPart in this.attrs;
      }
      if (s.startsWith(".")) {
        return this.hasClass(s.slice(1));
      }
      return this.tag.toLowerCase() === s.toLowerCase();
    }

    querySelector(selector: string): ElStub | null {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }

    querySelectorAll(selector: string): ElStub[] {
      const result: ElStub[] = [];
      const walk = (node: ElStub) => {
        for (const child of node.children) {
          if (child.matches(selector)) {
            result.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return result;
    }

    closest(selector: string): ElStub | null {
      let curr: ElStub | null = this;
      while (curr) {
        if (curr.matches(selector)) return curr;
        curr = curr.parentElement;
      }
      return null;
    }

    /**
     * Models the DOM click event dispatch algorithm according to HTML Living Standard:
     * 1. Bubble click event upwards from target.
     * 2. If inside a <label>, run synthetic click activation on the labeled control.
     * 3. Default activation for radio input sets checked = true, unchecks same-name radios, and fires change.
     */
    click(): void {
      let current: ElStub | null = this;
      let stopPropagation = false;
      let defaultPrevented = false;
      const evt = {
        target: this,
        type: "click",
        bubbles: true,
        preventDefault: () => {
          defaultPrevented = true;
        },
        stopPropagation: () => {
          stopPropagation = true;
        },
      };

      while (current && !stopPropagation) {
        const list = current.listeners["click"] ? [...current.listeners["click"]] : [];
        for (const fn of list) {
          fn(evt);
        }
        current = current.parentElement;
      }

      if (defaultPrevented) return;

      // Standard HTML label activation:
      const label = this.closest("label");
      if (label) {
        const control = label.querySelector("input, textarea, select, button");
        if (control && this !== control) {
          control.click();
          return;
        }
      }

      // Default activation for radio inputs:
      if (this.tag === "input" && this.attrs["type"] === "radio") {
        const wasChecked = this.checked;
        if (!wasChecked) {
          this.checked = true;
          const name = this.attrs["name"];
          if (name) {
            let root: ElStub = this;
            while (root.parentElement) root = root.parentElement;
            for (const r of root.querySelectorAll('input[type="radio"]')) {
              if (r !== this && r.attrs["name"] === name) {
                r.checked = false;
              }
            }
          }
          const changeEvt = { target: this, type: "change" };
          const changeListeners = this.listeners["change"] ? [...this.listeners["change"]] : [];
          for (const fn of changeListeners) {
            fn(changeEvt);
          }
        }
      }
    }
  }

  class ModalStub {
    app: unknown;
    contentEl: ElStub;
    titleEl: ElStub;
    modalEl: ElStub;
    isOpen = false;
    isClosed = false;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = new ElStub("div");
      this.titleEl = new ElStub("div");
      this.modalEl = new ElStub("div");
    }

    open(): void {
      this.isOpen = true;
      (this as any).onOpen?.();
    }

    close(): void {
      this.isClosed = true;
      (this as any).onClose?.();
    }
  }

  return { ElStub, ModalStub };
});

vi.mock("obsidian", () => ({
  Modal: ModalStub,
}));

// Provide window in Node test environment if not defined
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = globalThis;
}

function createConflictReview(extraConflicts: Array<{ field: string; values: [string, any][] }> = []): PendingWebReview {
  return {
    token: "rev-tok-1",
    request: {
      schema_version: 1,
      capture_id: "cap-1",
      page_url: "https://doi.org/10.1234/sample",
      records: [
        {
          source: "doi_scan",
          values: {
            title: "Official Paper Title",
            authors: [{ family: "Zhang", given: "San" }],
            year: 2024,
          },
        },
      ],
    },
    plan: {
      action: "create_with_confirmation",
      values: {
        title: "Official Paper Title",
        authors: [{ family: "Zhang", given: "San" }],
        year: 2024,
      },
      conflicts: [
        {
          field: "title",
          values: [
            ["crossref", "Official Paper Title"],
            ["web_page", "Web Scraped Title"],
          ],
        },
        ...extraConflicts,
      ],
    },
  };
}

describe("ImportReviewModal conflict option whole-card selection", () => {
  let callbacks: {
    confirm: (confirmed: Record<string, unknown>) => void;
    cancel: () => void;
  };
  let confirmMock: (confirmed: Record<string, unknown>) => void;
  let cancelMock: () => void;

  beforeEach(() => {
    confirmMock = vi.fn((_confirmed: Record<string, unknown>) => {});
    cancelMock = vi.fn(() => {});
    callbacks = {
      confirm: confirmMock,
      cancel: cancelMock,
    };
  });

  it("renders conflict option wrappers as native <label> without for attribute", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const optionLabels = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    expect(optionLabels.length).toBe(2);

    for (const wrap of optionLabels) {
      // Must be a native <label> tag, not a <div>
      expect(wrap.tag).toBe("label");
      // Must not have an explicit for attribute (id-free nesting association)
      expect(wrap.getAttribute("for")).toBeNull();

      const radio = wrap.querySelector('input[type="radio"]');
      expect(radio).not.toBeNull();
      expect(radio?.getAttribute("name")).toBe("field-title");
    }
  });

  it("clicking the option card text area (.paper-notes-review-option-value) selects the radio and triggers change", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    expect(options.length).toBe(2);

    const [wrap0, wrap1] = options;
    const text0 = wrap0.querySelector(".paper-notes-review-option-value");
    expect(text0).not.toBeNull();

    const radio0 = wrap0.querySelector('input[type="radio"]')!;
    const radio1 = wrap1.querySelector('input[type="radio"]')!;

    expect(radio0.checked).toBe(false);
    expect(wrap0.hasClass("is-selected")).toBe(false);

    // Click on the text area
    text0!.click();

    expect(radio0.checked).toBe(true);
    expect(radio1.checked).toBe(false);
    expect(wrap0.hasClass("is-selected")).toBe(true);
    expect(wrap1.hasClass("is-selected")).toBe(false);
    expect((modal as any).radios.get("title")).toBe(radio0);
  });

  it("clicking the source badge (.paper-notes-review-source-badge) selects the option", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0, wrap1] = options;
    const badge1 = wrap1.querySelector(".paper-notes-review-source-badge");
    expect(badge1).not.toBeNull();

    const radio0 = wrap0.querySelector('input[type="radio"]')!;
    const radio1 = wrap1.querySelector('input[type="radio"]')!;

    // Click the badge of the second option
    badge1!.click();

    expect(radio1.checked).toBe(true);
    expect(radio0.checked).toBe(false);
    expect(wrap1.hasClass("is-selected")).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(false);
    expect((modal as any).radios.get("title")).toBe(radio1);
  });

  it("clicking the whitespace/blank padding area of the label wrapper selects the option", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0] = options;

    const radio0 = wrap0.querySelector('input[type="radio"]')!;

    // Click the label wrapper directly
    wrap0.click();

    expect(radio0.checked).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(true);
    expect((modal as any).radios.get("title")).toBe(radio0);
  });

  it("clicking directly on the native radio button still works identically", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0] = options;
    const radio0 = wrap0.querySelector('input[type="radio"]')!;

    radio0.click();

    expect(radio0.checked).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(true);
    expect((modal as any).radios.get("title")).toBe(radio0);
  });

  it("dispatches exactly one change event per selection (no double-triggering)", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0] = options;
    const radio0 = wrap0.querySelector('input[type="radio"]')!;
    const text0 = wrap0.querySelector(".paper-notes-review-option-value")!;

    let changeCount = 0;
    radio0.addEventListener("change", () => {
      changeCount++;
    });

    // Click on the text area
    text0.click();
    expect(changeCount).toBe(1);

    // Clicking an already-selected option does not fire another change
    text0.click();
    expect(changeCount).toBe(1);
  });

  it("selecting the second option in the same field deselects the first (radio exclusivity)", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0, wrap1] = options;
    const radio0 = wrap0.querySelector('input[type="radio"]')!;
    const radio1 = wrap1.querySelector('input[type="radio"]')!;
    const text0 = wrap0.querySelector(".paper-notes-review-option-value")!;
    const text1 = wrap1.querySelector(".paper-notes-review-option-value")!;

    // Select option 0
    text0.click();
    expect(radio0.checked).toBe(true);
    expect(radio1.checked).toBe(false);
    expect(wrap0.hasClass("is-selected")).toBe(true);
    expect(wrap1.hasClass("is-selected")).toBe(false);
    expect((modal as any).radios.get("title")).toBe(radio0);

    // Select option 1 via text click
    text1.click();
    expect(radio0.checked).toBe(false);
    expect(radio1.checked).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(false);
    expect(wrap1.hasClass("is-selected")).toBe(true);
    expect((modal as any).radios.get("title")).toBe(radio1);
  });

  it("options across different fields do not interfere with each other", () => {
    const review = createConflictReview([
      {
        field: "year",
        values: [
          ["crossref", 2024],
          ["web_meta", 2023],
        ],
      },
    ]);
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const titleOptions = (modal.contentEl as unknown as InstanceType<typeof ElStub>)
      .querySelectorAll(".paper-notes-review-option")
      .filter((el) => el.querySelector('input[name="field-title"]'));
    const yearOptions = (modal.contentEl as unknown as InstanceType<typeof ElStub>)
      .querySelectorAll(".paper-notes-review-option")
      .filter((el) => el.querySelector('input[name="field-year"]'));

    expect(titleOptions.length).toBe(2);
    expect(yearOptions.length).toBe(2);

    const titleRadio0 = titleOptions[0].querySelector('input[type="radio"]')!;
    const titleText0 = titleOptions[0].querySelector(".paper-notes-review-option-value")!;

    const yearRadio1 = yearOptions[1].querySelector('input[type="radio"]')!;
    const yearText1 = yearOptions[1].querySelector(".paper-notes-review-option-value")!;

    // Select title option 0
    titleText0.click();
    expect(titleRadio0.checked).toBe(true);
    expect(titleOptions[0].hasClass("is-selected")).toBe(true);

    // Select year option 1
    yearText1.click();
    expect(yearRadio1.checked).toBe(true);
    expect(yearOptions[1].hasClass("is-selected")).toBe(true);

    // Title selection must remain intact
    expect(titleRadio0.checked).toBe(true);
    expect(titleOptions[0].hasClass("is-selected")).toBe(true);
    expect((modal as any).radios.get("title")).toBe(titleRadio0);
    expect((modal as any).radios.get("year")).toBe(yearRadio1);
  });

  it("passes validate() and buildConfirmed() delivers selected values to callback on submit", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();

    // 1. Before selection, confirm() should be blocked by validation
    modal.confirm();
    expect(confirmMock).not.toHaveBeenCalled();
    const errorEl = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelector(".paper-notes-review-error");
    expect(errorEl?.textContent).toBe("Choose a value for Title.");
    expect(errorEl?.hasClass("is-hidden")).toBe(false);

    // 2. Select option 1 ("Web Scraped Title") via whole-card text click
    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const text1 = options[1].querySelector(".paper-notes-review-option-value")!;
    text1.click();

    // 3. Confirm again: validation passes, confirmed values built correctly
    modal.confirm();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Web Scraped Title",
      }),
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("negative test: clicking a card only selects the radio and does NOT close or submit modal", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const text0 = options[0].querySelector(".paper-notes-review-option-value")!;

    // Clicking the card
    text0.click();

    // Modal must NOT close, callbacks must NOT have been called
    expect(closeSpy).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("keyboard navigation / change event directly on radio updates is-selected and radios registry", () => {
    const review = createConflictReview();
    const modal = new ImportReviewModal({} as any, review, callbacks);
    modal.open();

    const options = (modal.contentEl as unknown as InstanceType<typeof ElStub>).querySelectorAll(".paper-notes-review-option");
    const [wrap0, wrap1] = options;
    const radio1 = wrap1.querySelector('input[type="radio"]')!;

    // Simulate native keyboard arrow-key navigation firing change on radio1
    radio1.checked = true;
    radio1.dispatchEvent({ type: "change" });

    expect(wrap1.hasClass("is-selected")).toBe(true);
    expect(wrap0.hasClass("is-selected")).toBe(false);
    expect((modal as any).radios.get("title")).toBe(radio1);
  });
});
