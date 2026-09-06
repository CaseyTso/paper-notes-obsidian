import { DOMParser, XMLSerializer, type Element, type Node } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML = "http://www.w3.org/XML/1998/namespace";
const PPR_ORDER = "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange".split(" ");

function children(node: Node): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1);
}

function child(node: Node, name: string): Element | undefined {
  return children(node).find((el) => el.namespaceURI === W && el.localName === name);
}

function parse(xml: string) {
  // Only locally generated DOCX XML is expected. Refuse doctypes and malformed
  // XML rather than repairing/publishing a damaged document silently.
  if (/<!DOCTYPE/i.test(xml)) throw new Error("Unexpected DOCTYPE in DOCX XML");
  return new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
    .parseFromString(xml, "application/xml");
}

function property(parent: Element, name: string): Element {
  const existing = child(parent, name);
  if (existing) return existing;
  const el = parent.ownerDocument!.createElementNS(W, `w:${name}`);
  const rank = PPR_ORDER.indexOf(name);
  const next = children(parent).find((node) => PPR_ORDER.indexOf(node.localName!) > rank);
  parent.insertBefore(el, next ?? null);
  return el;
}

/** Compact stop for 1-2 digit labels (0.25 in / 0.635 cm). Longer labels
 * widen every bibliography entry to the same stop so wrapped lines stay
 * aligned instead of jumping to Word's next default 1.27 cm stop. */
export const BIBLIOGRAPHY_INDENT_TWIPS = 360;

/** Uniform stop for the whole bibliography from the widest numeric label. */
export function bibliographyIndentForDigits(maxDigits: number): number {
  return Math.max(BIBLIOGRAPHY_INDENT_TWIPS, (maxDigits + 1) * 120);
}

interface BibliographyCandidate {
  paragraph: Element;
  pPr: Element;
  styleId: string;
  tokens: Element[];
  start: number;
  end: number;
  digits: number;
}

/** Repair only numbered, tab-separated Bibliography paragraphs, not body tabs
 * or author-date references. CSL wording, spacing/fonts and other styles stay intact.
 * Wrapped lines hang at the same uniform stop as the author text.
 */
export function alignDocxBibliography(input: Uint8Array): Uint8Array {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(input) as Record<string, Uint8Array>;
  } catch (error) {
    throw new Error(`Invalid DOCX archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const documentBytes = entries["word/document.xml"];
  if (!documentBytes) throw new Error("DOCX is missing word/document.xml");
  const documentXml = strFromU8(documentBytes);
  const doc = parse(documentXml);
  const styles = entries["word/styles.xml"] ? parse(strFromU8(entries["word/styles.xml"])) : undefined;
  const bibliographyIds = new Set(["Bibliography"]);
  const styleMap = new Map<string, Element>();
  for (const style of Array.from(styles?.getElementsByTagNameNS(W, "style") ?? [])) {
    const id = style.getAttributeNS(W, "styleId");
    if (id) styleMap.set(id, style);
    if (id && child(style, "name")?.getAttributeNS(W, "val")?.toLowerCase() === "bibliography") bibliographyIds.add(id);
  }
  // First pass: collect numeric Bibliography paragraphs so the whole list
  // shares one uniform stop derived from the widest label.
  const candidates: BibliographyCandidate[] = [];
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, "p"));
  for (const paragraph of paragraphs) {
    const pPr = child(paragraph, "pPr");
    const styleId = pPr && child(pPr, "pStyle")?.getAttributeNS(W, "val");
    if (!pPr || !styleId || !bibliographyIds.has(styleId)) continue;
    const tokens = Array.from(paragraph.getElementsByTagNameNS(W, "*")).filter((el) => el.localName === "t" || el.localName === "tab");
    const text = tokens.map((el) => el.localName === "tab" ? "\t" : el.textContent ?? "").join("");
    const match = /^(\s*(?:\[\d+\]|\d+[.)]?))([ \u00a0]*\t[ \u00a0]*)/.exec(text);
    if (!match) continue;
    candidates.push({
      paragraph,
      pPr,
      styleId,
      tokens,
      start: match[1]!.length,
      end: match[0].length,
      digits: match[1]!.replace(/\D/g, "").length,
    });
  }
  if (candidates.length === 0) return input;
  // Uniform indent: 360 twips for 1-2 digits, wider when a 3+ digit label
  // is present so the number cannot overrun its stop.
  const indent = bibliographyIndentForDigits(Math.max(...candidates.map((c) => c.digits)));
  for (const candidate of candidates) {
    const { pPr, styleId, tokens, start, end } = candidate;
    const inheritedStops = new Set<number>();
    const visited = new Set<string>();
    let style: Element | undefined = styleMap.get(styleId);
    while (style) {
      const id = style.getAttributeNS(W, "styleId")!;
      if (visited.has(id)) break;
      visited.add(id);
      for (const tab of Array.from(style.getElementsByTagNameNS(W, "tab"))) {
        const pos = Number(tab.getAttributeNS(W, "pos"));
        if (Number.isFinite(pos) && pos < indent) inheritedStops.add(pos);
      }
      style = styleMap.get(child(style, "basedOn")?.getAttributeNS(W, "val") ?? "");
    }
    const tabs = property(pPr, "tabs");
    for (const tab of children(tabs)) {
      const pos = Number(tab.getAttributeNS(W, "pos"));
      if (pos <= indent) { inheritedStops.add(pos); tabs.removeChild(tab); }
    }
    for (const pos of [...inheritedStops].sort((a, b) => a - b)) {
      if (pos >= indent) continue;
      const clear = doc.createElementNS(W, "w:tab");
      clear.setAttributeNS(W, "w:val", "clear");
      clear.setAttributeNS(W, "w:pos", String(pos));
      tabs.appendChild(clear);
    }
    const stop = doc.createElementNS(W, "w:tab");
    stop.setAttributeNS(W, "w:val", "left");
    stop.setAttributeNS(W, "w:pos", String(indent));
    tabs.appendChild(stop);
    const ind = property(pPr, "ind");
    for (const attr of ["firstLine", "firstLineChars", "hangingChars", "leftChars", "start", "startChars"]) ind.removeAttributeNS(W, attr);
    ind.setAttributeNS(W, "w:left", String(indent));
    ind.setAttributeNS(W, "w:hanging", String(indent));

    // Replace just the separator with a real OOXML tab, even when Pandoc
    // split the label/space/literal tab among different runs. Preserve runs.
    let offset = 0;
    let inserted = false;
    for (const token of tokens) {
      const value = token.localName === "tab" ? "\t" : token.textContent ?? "";
      const tokenEnd = offset + value.length;
      if (tokenEnd > start && offset < end) {
        const before = value.slice(0, Math.max(0, start - offset));
        const after = value.slice(Math.max(0, end - offset));
        const parent = token.parentNode!;
        const makeText = (value: string) => {
          const t = doc.createElementNS(W, "w:t");
          t.setAttributeNS(XML, "xml:space", "preserve");
          t.appendChild(doc.createTextNode(value));
          return t;
        };
        if (before) parent.insertBefore(makeText(before), token);
        if (!inserted) { parent.insertBefore(doc.createElementNS(W, "w:tab"), token); inserted = true; }
        if (after) parent.insertBefore(makeText(after), token);
        parent.removeChild(token);
      }
      offset = tokenEnd;
    }
  }
  const serialized = new XMLSerializer().serializeToString(doc);
  entries["word/document.xml"] = strToU8(serialized);
  return zipSync(entries);
}
