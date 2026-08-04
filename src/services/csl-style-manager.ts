/**
 * CSL Style Manager (Task 28).
 *
 * Pure, Obsidian-free logic for importing/validating CSL styles and
 * selecting one global default (design spec §13). CSL styles are vault
 * configuration assets stored under `.paper-notes/csl/` — they are never
 * written into literature Markdown.
 *
 * Contract:
 * - `parseCslStyle` validates the XML structure (balanced tags, single
 *   root, no markup declarations), requires a `<style>` root carrying the
 *   CSL namespace, and extracts `<info><title>` / `<info><id>`.
 * - `cslFileNameFor` derives a single safe path component from the style
 *   id; traversal and empty names are rejected with `unsafe_name`.
 * - `importCslStyle` writes the verbatim style under the csl directory;
 *   an existing file with the same derived name is a reported collision
 *   and is never overwritten. Rejected styles write nothing.
 * - `listCslStyles` reports valid imported styles (title/id/on-disk file),
 *   ignoring non-`.csl` files and corrupt ones.
 * - `requireExportStyle` is the export gate: it returns the vault-relative
 *   path of the selected style, or an actionable error when no style is
 *   selected or the selected style is missing/unreadable. The Pandoc
 *   export task (29) consumes this check before launching.
 * - `setDefaultCsl` updates the single global default immutably.
 *
 * Vault I/O goes through `CslVaultPort` (injected), so tests exercise the
 * full logic against an in-memory filesystem without touching any real
 * vault.
 */

/** CSL namespace URI required on the `<style>` root element. */
export const CSL_NAMESPACE = "http://purl.org/net/xbiblio/csl";

export interface CslStyleMeta {
  /** File name inside the csl directory (single safe path component). */
  file: string;
  /** `<info><title>` of the style. */
  title: string;
  /** `<info><id>` of the style (usually a Zotero style URL). */
  id: string;
}

export type CslStyleErrorCode =
  | "malformed_xml"
  | "not_csl"
  | "missing_title"
  | "missing_id"
  | "unsafe_name";

export class CslStyleError extends Error {
  readonly code: CslStyleErrorCode;

  constructor(code: CslStyleErrorCode, message: string) {
    super(message);
    this.name = "CslStyleError";
    this.code = code;
  }
}

/** Minimal vault surface the CSL manager needs. */
export interface CslVaultPort {
  /** File names directly inside `dir` (no recursion); [] when missing. */
  listFiles(dir: string): Promise<string[]>;
  /** File content, or null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** Write `content` to `path`, creating parent directories as needed. */
  writeText(path: string, content: string): Promise<void>;
}

export type CslImportResult =
  | { status: "imported"; meta: CslStyleMeta }
  | { status: "collision"; meta: CslStyleMeta };

export type ExportStyleCheck =
  | { ok: true; file: string; path: string; title: string }
  | { ok: false; error: string };

/**
 * Validate XML structure and CSL metadata.
 *
 * Structural checks: balanced, properly nested tags; a single root
 * element; no DOCTYPE or other markup declarations; comments, CDATA and
 * processing instructions handled. Metadata checks: the root must be
 * `<style>` with the CSL namespace, and `<info>` must provide `<title>`
 * and `<id>`.
 */
export function parseCslStyle(xml: string): Omit<CslStyleMeta, "file"> {
  const root = parseXmlStructure(xml);
  if (root.name !== "style") {
    throw new CslStyleError(
      "not_csl",
      `Root element is <${root.name}>, expected <style>.`,
    );
  }
  if (root.attributes.get("xmlns") !== CSL_NAMESPACE) {
    throw new CslStyleError(
      "not_csl",
      "The <style> root must declare the CSL namespace (http://purl.org/net/xbiblio/csl).",
    );
  }
  const title = extractInfoField(xml, "title");
  if (title === null) {
    throw new CslStyleError(
      "missing_title",
      "CSL style has no <info><title> element.",
    );
  }
  const id = extractInfoField(xml, "id");
  if (id === null) {
    throw new CslStyleError(
      "missing_id",
      "CSL style has no <info><id> element.",
    );
  }
  return {
    title: decodeXmlEntities(title).trim(),
    id: decodeXmlEntities(id).trim(),
  };
}

/**
 * Derive the storage file name from the style id (usually a Zotero style
 * URL). The result is guaranteed to be a single safe path component:
 * it cannot contain separators or `..` components and always ends in
 * `.csl`. Ids that sanitize to an empty name are rejected.
 */
export function cslFileNameFor(id: string): string {
  const segment = id.trim().split("/").pop() ?? "";
  const sanitized = segment
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "");
  if (sanitized.length === 0) {
    throw new CslStyleError(
      "unsafe_name",
      "Style id does not yield a usable file name.",
    );
  }
  const file = `${sanitized}.csl`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.csl$/.test(file)) {
    throw new CslStyleError(
      "unsafe_name",
      "Style id yields an unsafe file name.",
    );
  }
  return file;
}

/**
 * Import a style: validate, derive the file name, and copy the verbatim
 * content under `dir`. When a style with the same derived file name
 * already exists the import is reported as a collision and the existing
 * file is never touched.
 */
export async function importCslStyle(
  port: CslVaultPort,
  dir: string,
  xml: string,
): Promise<CslImportResult> {
  const meta = parseCslStyle(xml);
  const file = cslFileNameFor(meta.id);
  const existing = await port.readText(pathJoin(dir, file));
  if (existing !== null) {
    return { status: "collision", meta: { ...meta, file } };
  }
  await port.writeText(pathJoin(dir, file), xml);
  return { status: "imported", meta: { ...meta, file } };
}

/** List valid imported styles (title/id/on-disk file), sorted by title. */
export async function listCslStyles(
  port: CslVaultPort,
  dir: string,
): Promise<CslStyleMeta[]> {
  const names = await port.listFiles(dir);
  const styles: CslStyleMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".csl")) {
      continue;
    }
    const content = await port.readText(pathJoin(dir, name));
    if (content === null) {
      continue;
    }
    try {
      const meta = parseCslStyle(content);
      styles.push({ ...meta, file: name });
    } catch (error) {
      // Corrupt styles are skipped from the listing; they are still
      // caught by `requireExportStyle` when selected as the default.
      if (!(error instanceof CslStyleError)) {
        throw error;
      }
    }
  }
  return styles.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Export gate (consumed by the Pandoc export task): resolve the selected
 * global default to a vault-relative style path, or return an actionable
 * error telling the user exactly how to fix the selection.
 */
export async function requireExportStyle(
  port: CslVaultPort,
  dir: string,
  selectedFile: string,
): Promise<ExportStyleCheck> {
  if (selectedFile.trim().length === 0) {
    return {
      ok: false,
      error:
        "No CSL style selected. Open the CSL Style Manager from the plugin settings and choose a default style before exporting.",
    };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.csl$/.test(selectedFile)) {
    return {
      ok: false,
      error: `Selected CSL style "${selectedFile}" is not a valid style file name. Re-import it in the CSL Style Manager.`,
    };
  }
  const content = await port.readText(pathJoin(dir, selectedFile));
  if (content === null) {
    return {
      ok: false,
      error: `Selected CSL style "${selectedFile}" is missing from .paper-notes/csl. Re-import it in the CSL Style Manager.`,
    };
  }
  let title: string;
  try {
    title = parseCslStyle(content).title;
  } catch {
    return {
      ok: false,
      error: `Selected CSL style "${selectedFile}" could not be read. Re-import it in the CSL Style Manager.`,
    };
  }
  return {
    ok: true,
    file: selectedFile,
    path: pathJoin(dir, selectedFile),
    title,
  };
}

/**
 * Set the single global default immutably: returns a new settings object
 * whose `selectedCsl` stores the style file name.
 */
export function setDefaultCsl(
  settings: { selectedCsl: string },
  file: string,
): { selectedCsl: string } {
  return { ...settings, selectedCsl: file };
}

function pathJoin(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  return base.length === 0 ? name : `${base}/${name}`;
}

interface XmlRoot {
  name: string;
  attributes: Map<string, string>;
}

function parseXmlStructure(xml: string): XmlRoot {
  let i = 0;
  const stack: string[] = [];
  let root: XmlRoot | null = null;

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) {
        throw new CslStyleError("malformed_xml", "Unterminated XML comment.");
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) {
        throw new CslStyleError("malformed_xml", "Unterminated CDATA section.");
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) {
        throw new CslStyleError(
          "malformed_xml",
          "Unterminated processing instruction.",
        );
      }
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new CslStyleError(
        "not_csl",
        "DTD and other markup declarations are not allowed in CSL styles.",
      );
    }
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) {
        throw new CslStyleError("malformed_xml", "Unterminated closing tag.");
      }
      const name = xml.slice(lt + 2, end).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
        throw new CslStyleError("malformed_xml", `Invalid closing tag </${name}>.`);
      }
      const open = stack.pop();
      if (open === undefined || open !== name) {
        throw new CslStyleError(
          "malformed_xml",
          `Mismatched closing tag </${name}>.`,
        );
      }
      i = end + 1;
      continue;
    }
    const end = findTagEnd(xml, lt);
    if (end === -1) {
      throw new CslStyleError("malformed_xml", "Unterminated tag.");
    }
    const inner = xml.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const { name, attributes } = parseTagBody(body);
    if (stack.length === 0) {
      if (root !== null) {
        throw new CslStyleError("malformed_xml", "Multiple root elements.");
      }
      root = { name, attributes };
    }
    if (!selfClosing) {
      stack.push(name);
    }
    i = end + 1;
  }

  if (stack.length > 0) {
    throw new CslStyleError(
      "malformed_xml",
      `Unclosed element <${stack[stack.length - 1]}>.`,
    );
  }
  if (root === null) {
    throw new CslStyleError("malformed_xml", "No root element found.");
  }
  return root;
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let j = start + 1; j < xml.length; j++) {
    const ch = xml[j];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return j;
    }
  }
  return -1;
}

function parseTagBody(body: string): XmlRoot {
  const trimmed = body.trim();
  const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(trimmed);
  if (match === null) {
    throw new CslStyleError("malformed_xml", "Invalid tag name.");
  }
  const name = match[1];
  const attributes = new Map<string, string>();
  const rest = match[2];
  const attributeRe =
    /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let attributeMatch: RegExpExecArray | null;
  while ((attributeMatch = attributeRe.exec(rest)) !== null) {
    const value =
      attributeMatch[3] !== undefined ? attributeMatch[3] : attributeMatch[4];
    attributes.set(attributeMatch[1], value);
  }
  const leftover = rest.replace(attributeRe, "").trim();
  if (leftover.length > 0) {
    throw new CslStyleError("malformed_xml", `Malformed attributes on <${name}>.`);
  }
  return { name, attributes };
}

function extractInfoField(xml: string, field: string): string | null {
  const infoStart = xml.indexOf("<info");
  if (infoStart === -1) {
    return null;
  }
  const infoEnd = xml.indexOf("</info>", infoStart);
  if (infoEnd === -1) {
    return null;
  }
  const info = xml.slice(infoStart, infoEnd);
  const match = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`).exec(info);
  return match === null ? null : match[1];
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
}
