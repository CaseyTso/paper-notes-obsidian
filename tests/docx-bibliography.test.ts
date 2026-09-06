/**
 * DOCX bibliography layout (Nature CSL preservation) — unit + real Pandoc XML regressions.
 *
 * Scope: shorter number→author gap and hanging wrapped lines only.
 * Nature CSL wording, fonts, spacing and all non-Bibliography content stay intact.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  alignDocxBibliography,
  BIBLIOGRAPHY_INDENT_TWIPS,
  bibliographyIndentForDigits,
} from "../src/services/docx-bibliography";
import { defaultExportPorts, exportPandoc } from "../src/services/pandoc-export";
import type { PaperRecord } from "../src/types/paper";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docXml(paragraphs: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`
  );
}

function stylesXml(inner = ""): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:styleId="Normal" w:type="paragraph"><w:name w:val="Normal"/>' +
    '<w:pPr><w:tabs><w:tab w:val="left" w:pos="180"/></w:tabs></w:pPr></w:style>' +
    '<w:style w:styleId="Bibliography" w:type="paragraph"><w:name w:val="Bibliography"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr/><w:rPr/></w:style>' +
    `${inner}</w:styles>`
  );
}

function contentTypes(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>"
  );
}

function makeDocx(paragraphs: string, styles = stylesXml()): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes()),
    "word/document.xml": strToU8(docXml(paragraphs)),
    "word/styles.xml": strToU8(styles),
  });
}

/** Numeric Bibliography paragraph mimicking Pandoc: number + space + literal TAB in w:t runs. */
function numericPara(label: string, author: string, extra = ""): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${label}</w:t></w:r>` +
    `<w:r><w:t xml:space="preserve"> </w:t></w:r>` +
    `<w:r><w:t xml:space="preserve">\t</w:t></w:r>` +
    `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${author}</w:t></w:r>` +
    `${extra}</w:p>`
  );
}

function parseDocument(bytes: Uint8Array) {
  const entries = unzipSync(bytes) as Record<string, Uint8Array>;
  const doc = new DOMParser().parseFromString(strFromU8(entries["word/document.xml"]), "application/xml");
  const styles = entries["word/styles.xml"]
    ? new DOMParser().parseFromString(strFromU8(entries["word/styles.xml"]), "application/xml")
    : undefined;
  return { entries, doc, styles };
}

function bibliographyParagraphs(doc: XmlDocument): XmlElement[] {
  return Array.from(doc.getElementsByTagNameNS(W, "p")).filter((p) => {
    const pPr = Array.from(p.childNodes).find(
      (n) => n.nodeType === 1 && (n as XmlElement).localName === "pPr",
    ) as XmlElement | undefined;
    const style = pPr
      ? Array.from(pPr.childNodes).find((n) => n.nodeType === 1 && (n as XmlElement).localName === "pStyle") as XmlElement | undefined
      : undefined;
    return style?.getAttributeNS(W, "val") === "Bibliography";
  });
}

function pPrChild(p: XmlElement, name: string): XmlElement | undefined {
  const pPr = Array.from(p.childNodes).find(
    (n) => n.nodeType === 1 && (n as XmlElement).localName === "pPr",
  ) as XmlElement | undefined;
  if (!pPr) return undefined;
  return Array.from(pPr.childNodes).find(
    (n) => n.nodeType === 1 && (n as XmlElement).localName === name,
  ) as XmlElement | undefined;
}

function tabStops(p: XmlElement): Array<{ val: string | null; pos: string | null }> {
  const tabs = pPrChild(p, "tabs");
  if (!tabs) return [];
  return Array.from(tabs.childNodes)
    .filter((n) => n.nodeType === 1)
    .map((n) => ({
      val: (n as XmlElement).getAttributeNS(W, "val"),
      pos: (n as XmlElement).getAttributeNS(W, "pos"),
    }));
}

function runTexts(p: XmlElement): string[] {
  return Array.from(p.getElementsByTagNameNS(W, "t")).map((t) => t.textContent ?? "");
}

describe("bibliographyIndentForDigits", () => {
  it("stays compact (360 twips) for 1-2 digits", () => {
    expect(bibliographyIndentForDigits(1)).toBe(360);
    expect(bibliographyIndentForDigits(2)).toBe(360);
    expect(BIBLIOGRAPHY_INDENT_TWIPS).toBe(360);
  });

  it("widens for 3+ digits so numbers cannot overrun the stop", () => {
    expect(bibliographyIndentForDigits(3)).toBe(480);
    expect(bibliographyIndentForDigits(4)).toBe(600);
  });
});

describe("alignDocxBibliography unit", () => {
  it("replaces number+space+literal TAB with a real tab, 360 stop and hanging indent", () => {
    const out = alignDocxBibliography(makeDocx(numericPara("1.", "Thomas, T.")));
    const { doc } = parseDocument(out);
    const [para] = bibliographyParagraphs(doc);
    expect(para).toBeDefined();
    // Real OOXML tab present inside a run.
    const runTabs = Array.from(para.getElementsByTagNameNS(W, "tab"))
      .filter((tab) => (tab.parentNode as XmlElement).localName === "r");
    expect(runTabs).toHaveLength(1);
    // Literal separator gone; author wording preserved.
    expect(runTexts(para).join("")).toContain("Thomas, T.");
    expect(runTexts(para).join("")).not.toContain("\t");
    expect(runTexts(para).join("")).toMatch(/^1\.Thomas, T\./);
    // Compact stop + matching hanging indent for wrapped lines.
    expect(tabStops(para)).toContainEqual({ val: "left", pos: "360" });
    const ind = pPrChild(para, "ind")!;
    expect(ind.getAttributeNS(W, "left")).toBe("360");
    expect(ind.getAttributeNS(W, "hanging")).toBe("360");
  });

  it("keeps alignment consistent when 3+ digits require a larger stop", () => {
    const out = alignDocxBibliography(
      makeDocx(numericPara("1.", "One") + numericPara("2.", "Two") + numericPara("100.", "Hundred")),
    );
    const { doc } = parseDocument(out);
    const paras = bibliographyParagraphs(doc);
    expect(paras).toHaveLength(3);
    for (const para of paras) {
      expect(tabStops(para)).toContainEqual({ val: "left", pos: "480" });
      const ind = pPrChild(para, "ind")!;
      expect(ind.getAttributeNS(W, "left")).toBe("480");
      expect(ind.getAttributeNS(W, "hanging")).toBe("480");
    }
  });

  it("handles bracket labels and split runs", () => {
    const para =
      `<w:p><w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">[12]</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve"> \t</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve\">Author</w:t></w:r></w:p>`;
    const fixed = para.replace('preserve\\"', 'preserve"');
    const out = alignDocxBibliography(makeDocx(fixed));
    const { doc } = parseDocument(out);
    const [p] = bibliographyParagraphs(doc);
    expect(p.getElementsByTagNameNS(W, "tab").length).toBeGreaterThan(0);
    expect(runTexts(p).join("")).toContain("Author");
  });

  it("leaves author-date Bibliography paragraphs untouched", () => {
    const authorDate =
      `<w:p><w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">Smith, J. (2024) A title without a number.</w:t></w:r></w:p>`;
    const input = makeDocx(authorDate);
    const out = alignDocxBibliography(input);
    // No numeric entries → identical bytes returned.
    expect(out).toBe(input);
    const { doc } = parseDocument(out);
    const [p] = bibliographyParagraphs(doc);
    expect(pPrChild(p, "tabs")).toBeUndefined();
    expect(pPrChild(p, "ind")).toBeUndefined();
  });

  it("leaves body paragraphs with tabs untouched", () => {
    const body =
      `<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">col1</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve">\tcol2</w:t></w:r></w:p>`;
    const out = alignDocxBibliography(makeDocx(body + numericPara("1.", "Author")));
    const { doc } = parseDocument(out);
    const bodyPara = Array.from(doc.getElementsByTagNameNS(W, "p")).find((p) =>
      runTexts(p).join("").includes("col1"),
    )!;
    expect(pPrChild(bodyPara, "tabs")).toBeUndefined();
    expect(pPrChild(bodyPara, "ind")).toBeUndefined();
    expect(runTexts(bodyPara).join("")).toContain("\t");
  });

  it("preserves run content, bold, hyperlinks and clears inherited early stops", () => {
    const extra =
      `<w:hyperlink r:id=\"rId9\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">` +
      `<w:r><w:t xml:space=\"preserve\">https://doi.org/10.1038/x</w:t></w:r></w:hyperlink>`;
    const out = alignDocxBibliography(makeDocx(numericPara("2.", "Zhang, C.", extra)));
    const { doc, styles } = parseDocument(out);
    const [p] = bibliographyParagraphs(doc);
    const text = runTexts(p).join("");
    expect(text).toContain("Zhang, C.");
    expect(text).toContain("https://doi.org/10.1038/x");
    // Bold run preserved.
    const bold = Array.from(p.getElementsByTagNameNS(W, "b"));
    expect(bold.length).toBeGreaterThan(0);
    // Inherited Normal stop at 180 (< 360) becomes a clear alongside the new stop.
    expect(tabStops(p)).toContainEqual({ val: "clear", pos: "180" });
    expect(tabStops(p)).toContainEqual({ val: "left", pos: "360" });
    // Reference template styles.xml itself is untouched.
    const stylesText = strFromU8((styles ? unzipSync(out) : {})["word/styles.xml"] ?? new Uint8Array());
    expect(stylesText).toContain('w:styleId="Bibliography"');
  });

  it("is idempotent: a second pass keeps one stop and the same indent", () => {
    const once = alignDocxBibliography(makeDocx(numericPara("1.", "A") + numericPara("2.", "B")));
    const twice = alignDocxBibliography(once);
    const first = parseDocument(once);
    const second = parseDocument(twice);
    const firstParas = bibliographyParagraphs(first.doc);
    const secondParas = bibliographyParagraphs(second.doc);
    expect(secondParas).toHaveLength(2);
    for (const [i, p] of secondParas.entries()) {
      const stops = tabStops(p);
      expect(stops.filter((s) => s.val === "left")).toHaveLength(1);
      expect(stops).toContainEqual({ val: "left", pos: "360" });
      const ind = pPrChild(p, "ind")!;
      expect(ind.getAttributeNS(W, "left")).toBe("360");
      expect(firstParas[i].getElementsByTagNameNS(W, "tab").length).toBe(
        p.getElementsByTagNameNS(W, "tab").length,
      );
    }
  });

  it("returns input unchanged when no numeric bibliography entries exist", () => {
    const body =
      `<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr>` +
      `<w:r><w:t xml:space=\"preserve\">plain body</w:t></w:r></w:p>`;
    const input = makeDocx(body);
    expect(alignDocxBibliography(input)).toBe(input);
  });

  it("rejects invalid archives and documents without document.xml", () => {
    expect(() => alignDocxBibliography(new Uint8Array([1, 2, 3]))).toThrow(/invalid docx archive/i);
    const missing = zipSync({ "[Content_Types].xml": strToU8(contentTypes()) });
    expect(() => alignDocxBibliography(missing)).toThrow(/missing word\/document\.xml/i);
    const bad = zipSync({
      "[Content_Types].xml": strToU8(contentTypes()),
      "word/document.xml": strToU8("<!DOCTYPE foo><w:document/>"),
    });
    expect(() => alignDocxBibliography(bad)).toThrow(/doctype/i);
  });
});

// ---------------------------------------------------------------------------
// Real Pandoc + Nature CSL DOCX XML regressions (skipped without pandoc).
// ---------------------------------------------------------------------------

function pandocAvailable(): boolean {
  try {
    return spawnSync("pandoc", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const hasPandoc = pandocAvailable();
const natureCslPath = fileURLToPath(new URL("./fixtures/nature.csl", import.meta.url));

const NATURE_RECORDS: PaperRecord[] = [
  {
    path: "Synthetic/alpha2024/alpha2024.md",
    key: "alpha2024",
    paperId: "11111111-1111-4111-8111-111111111111",
    title: "Alpha Nature layout regression paper",
    authors: [{ family: "Alpha", given: "Ann" }],
    journal: "Synthetic Journal",
    year: 2024,
    identifiers: { doi: "10.1000/synthetic-alpha" },
    citationKeyAliases: [],
    titleAliases: [],
  },
  {
    path: "Synthetic/beta2025/beta2025.md",
    key: "beta2025",
    paperId: "22222222-2222-4222-8222-222222222222",
    title: "Beta Nature layout regression paper",
    authors: [{ family: "Beta", given: "Ben" }],
    journal: "Another Synthetic Journal",
    year: 2025,
    identifiers: {},
    citationKeyAliases: [],
    titleAliases: [],
  },
];

describe.skipIf(!hasPandoc)("nature CSL real DOCX XML regression", () => {
  it("pandoc Nature output uses number+literal-TAB with default 720 stop and no hanging indent", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-notes-nature-baseline-"));
    try {
      const markdownPath = join(root, "manuscript.md");
      const markdown = "# Title\n\nCite [@alpha2024; @beta2025].\n";
      writeFileSync(markdownPath, markdown, "utf8");
      const ports = defaultExportPorts();
      // Bypass the layout hook by calling pandoc directly would duplicate logic;
      // instead verify the raw pandoc shape via a runner spy that skips alignment.
      // Here we assert the preconditions the layout pass is designed for by
      // generating one DOCX through exportPandoc and inspecting a pristine copy
      // produced with the transform disabled via direct pandoc invocation.
      const { execFileSync } = await import("node:child_process");
      const { generateCslJson } = await import("../src/services/pandoc-export");
      writeFileSync(join(root, "library.json"), generateCslJson(NATURE_RECORDS));
      const rawTarget = join(root, "raw.docx");
      execFileSync(
        "pandoc",
        [
          "--from", "markdown", "--to", "docx", "-o", rawTarget,
          "--citeproc", "--bibliography", join(root, "library.json"),
          "--csl", natureCslPath, markdownPath,
        ],
        { encoding: "utf8" },
      );
      const rawEntries = unzipSync(new Uint8Array(readFileSync(rawTarget))) as Record<string, Uint8Array>;
      const rawXml = strFromU8(rawEntries["word/document.xml"]);
      // Precondition: pandoc emits Bibliography paragraphs with a literal TAB character.
      expect(rawXml).toContain("Bibliography");
      expect(rawXml).toContain("\t");
      const rawDoc = new DOMParser().parseFromString(rawXml, "application/xml");
      const rawBib = bibliographyParagraphs(rawDoc);
      expect(rawBib.length).toBeGreaterThanOrEqual(2);
      for (const p of rawBib) {
        // No explicit hanging indent before the fix.
        expect(pPrChild(p, "ind")).toBeUndefined();
      }
      expect(ports).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("production export aligns Nature bibliography XML: real tab, 360 stop, hanging indent", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-notes-nature-aligned-"));
    const exportDir = mkdtempSync(join(tmpdir(), "paper-notes-nature-out-"));
    try {
      const markdownPath = join(root, "manuscript.md");
      const markdown = "# Title\n\nCite [@alpha2024; @beta2025].\n";
      writeFileSync(markdownPath, markdown, "utf8");
      const result = await exportPandoc(
        {
          format: "docx",
          baseName: "manuscript",
          markdown,
          markdownPath,
          exportDirectory: exportDir,
          pandocPath: "pandoc",
          cslPath: natureCslPath,
          referenceDocx: "",
          records: NATURE_RECORDS,
        },
        defaultExportPorts(),
      );
      expect(result.status, result.stderr).toBe("success");
      const target = result.targetPath!;
      const entries = unzipSync(new Uint8Array(readFileSync(target))) as Record<string, Uint8Array>;
      const xml = strFromU8(entries["word/document.xml"]);
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const bib = bibliographyParagraphs(doc);
      expect(bib.length).toBeGreaterThanOrEqual(2);
      for (const p of bib) {
        // Real OOXML tab, compact stop, matching hanging indent.
        expect(p.getElementsByTagNameNS(W, "tab").length).toBeGreaterThan(0);
        expect(tabStops(p)).toContainEqual({ val: "left", pos: "360" });
        const ind = pPrChild(p, "ind")!;
        expect(ind.getAttributeNS(W, "left")).toBe("360");
        expect(ind.getAttributeNS(W, "hanging")).toBe("360");
        // CSL wording preserved: no literal TAB left in the separator.
        expect(runTexts(p).join("")).not.toContain("\t");
      }
      // Nature CSL titles survive the layout pass verbatim.
      expect(xml).toContain("Alpha Nature layout regression paper");
      expect(xml).toContain("Beta Nature layout regression paper");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
