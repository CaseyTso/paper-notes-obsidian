import type { MinimalDocument, MinimalElement } from "../src/extract";

export class FakeElement implements MinimalElement {
  readonly tag: string;
  private readonly attrs: Record<string, string>;
  readonly textContent: string | null;

  constructor(
    tag: string,
    attrs: Record<string, string> = {},
    textContent: string | null = null,
  ) {
    this.tag = tag.toLowerCase();
    this.attrs = { ...attrs };
    this.textContent = textContent;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  matches(selector: string): boolean {
    if (selector === "meta") {
      return this.tag === "meta";
    }
    if (selector.includes("script[type=\"application/ld+json\"]")) {
      return this.tag === "script" && this.attrs.type === "application/ld+json";
    }
    const attrSelector = selector.match(/^([a-z]+)\[([a-zA-Z]+)([~|^$*]?=)\"([^\"]+)\"\]$/);
    if (attrSelector) {
      const [, tag, attr, operator, expected] = attrSelector;
      if (this.tag !== tag) {
        return false;
      }
      const actual = this.attrs[attr] ?? "";
      if (operator === "=") {
        return actual === expected;
      }
      if (operator === "^=") {
        return actual.startsWith(expected);
      }
      return false;
    }
    // Comma-separated selector lists (Dublin Core / OpenGraph).
    if (selector.includes(",")) {
      return selector.split(",").some((part) => this.matches(part.trim()));
    }
    return false;
  }
}

export class FakeDocument implements MinimalDocument {
  readonly elements: FakeElement[];
  body?: { innerText?: string };

  constructor(elements: FakeElement[] = [], bodyText?: string) {
    this.elements = elements;
    if (bodyText !== undefined) {
      this.body = { innerText: bodyText };
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.elements.filter((element) => element.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export function meta(name: string, content: string): FakeElement {
  return new FakeElement("meta", { name, content });
}

export function propertyMeta(property: string, content: string): FakeElement {
  return new FakeElement("meta", { property, content });
}

export function jsonLd(text: string): FakeElement {
  return new FakeElement("script", { type: "application/ld+json" }, text);
}
