/**
 * CSL Style Manager (Task 28) — model + modal wiring tests.
 *
 * Covers `src/services/csl-style-manager.ts` (pure, Obsidian-free logic:
 * XML validation, safe file naming, import/list, global default, export
 * blocking) and `src/modals/csl-style-modal.ts` (thin Obsidian wrapper
 * driven through injected callbacks and the fake DOM in the `obsidian`
 * runtime mock).
 *
 * Behavior contract (plan Task 28 / design spec §13):
 * - Valid `.csl` files are copied verbatim into `<vault>/.paper-notes/csl/`.
 * - Malformed XML, non-CSL roots, missing title/id are rejected with
 *   structured `CslStyleError`s; nothing is written on rejection.
 * - File names derive from the style id and are sanitized so path
 *   traversal is impossible; existing files are never overwritten
 *   (collision → actionable result).
 * - `listCslStyles` reports imported styles (title/id/file).
 * - One global default: `settings.selectedCsl` stores the style file name.
 * - `requireExportStyle` blocks export when no style is selected or the
 *   selected style is missing/unreadable, with an actionable message.
 * - CSL configuration never mutates paper Markdown: every write goes
 *   through the vault port and only under the csl directory.
 *
 * The modal is exercised through a fake DOM (the `obsidian` runtime mock
 * provides `Modal` plus minimal `createEl`/`createDiv` nodes); no real
 * Obsidian UI is involved. Subjective visual acceptance is Task 33 Gate D.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { App } from "obsidian";

import type { CslVaultPort } from "../src/services/csl-style-manager";
import {
  CslStyleError,
  cslFileNameFor,
  importCslStyle,
  listCslStyles,
  parseCslStyle,
  requireExportStyle,
  setDefaultCsl,
} from "../src/services/csl-style-manager";
import type { CslStyleModalCallbacks } from "../src/modals/csl-style-modal";
import { createCslStyleModal } from "../src/modals/csl-style-modal";
import {
  CSL_STYLE_DIR,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type PaperNotesSettings,
} from "../src/settings";

const AMA_STYLE_ID = "https://www.zotero.org/styles/american-medical-association";
const AMA_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info>
    <title>American Medical Association</title>
    <id>${AMA_STYLE_ID}</id>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
  <citation><layout><text variable="title"/></layout></citation>
</style>`;

const NATURE_STYLE_ID = "https://www.zotero.org/styles/nature";
const NATURE_CSL = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info>
    <title>Nature</title>
    <id>${NATURE_STYLE_ID}</id>
  </info>
  <citation><layout><text variable="title"/></layout></citation>
</style>`;

interface MemoryPort {
  port: CslVaultPort;
  files: Map<string, string>;
  writes: string[];
}

function makeMemoryPort(seed: Array<[string, string]> = []): MemoryPort {
  const files = new Map<string, string>(seed);
  const writes: string[] = [];
  const port: CslVaultPort = {
    async listFiles(dir: string): Promise<string[]> {
      const prefix = dir.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        const rest = path.slice(prefix.length);
        if (rest.length === 0 || rest.includes("/")) {
          continue;
        }
        names.add(rest);
      }
      return [...names];
    },
    async readText(path: string): Promise<string | null> {
      return files.get(path) ?? null;
    },
    async writeText(path: string, content: string): Promise<void> {
      writes.push(path);
      files.set(path, content);
    },
  };
  return { port, files, writes };
}

describe("parseCslStyle", () => {
  it("extracts title and id from a valid style", () => {
    const meta = parseCslStyle(AMA_CSL);
    expect(meta.title).toBe("American Medical Association");
    expect(meta.id).toBe(AMA_STYLE_ID);
  });

  it("decodes XML entities inside the title", () => {
    const style = AMA_CSL.replace(
      "<title>American Medical Association</title>",
      "<title>JAMA &amp; Archives</title>",
    );
    expect(parseCslStyle(style).title).toBe("JAMA & Archives");
  });

  it("rejects unbalanced closing tags as malformed XML", () => {
    const broken = AMA_CSL.replace("</style>", "</stlye>");
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "malformed_xml" }),
    );
  });

  it("rejects a stray < inside text as malformed XML", () => {
    const broken = AMA_CSL.replace(
      "American Medical Association",
      "American < Medical Association",
    );
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "malformed_xml" }),
    );
  });

  it("rejects an unterminated comment as malformed XML", () => {
    const broken = AMA_CSL + "\n<!-- never closed";
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "malformed_xml" }),
    );
  });

  it("rejects a non-style root element", () => {
    const broken = AMA_CSL.replace("<style", "<bibliography").replace(
      "</style>",
      "</bibliography>",
    );
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "not_csl" }),
    );
  });

  it("rejects a style root without the CSL namespace", () => {
    const broken = AMA_CSL.replace(
      'xmlns="http://purl.org/net/xbiblio/csl"',
      'xmlns="http://example.com/not-csl"',
    );
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "not_csl" }),
    );
  });

  it("rejects input with a DOCTYPE declaration", () => {
    const broken = `<!DOCTYPE style SYSTEM "evil"><style xmlns="http://purl.org/net/xbiblio/csl"><info><title>X</title><id>y</id></info></style>`;
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "not_csl" }),
    );
  });

  it("rejects a style without <info><title>", () => {
    const broken = AMA_CSL.replace(
      "    <title>American Medical Association</title>\n",
      "",
    );
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "missing_title" }),
    );
  });

  it("rejects a style without <info><id>", () => {
    const broken = AMA_CSL.replace(`    <id>${AMA_STYLE_ID}</id>\n`, "");
    expect(() => parseCslStyle(broken)).toThrowError(
      expect.objectContaining({ code: "missing_id" }),
    );
  });
});

describe("cslFileNameFor", () => {
  it("derives a safe file name from a Zotero style URL", () => {
    expect(cslFileNameFor(AMA_STYLE_ID)).toBe("american-medical-association.csl");
  });

  it("neutralizes path traversal in hostile style ids", () => {
    const name = cslFileNameFor("../../etc/passwd/../../secrets");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.endsWith(".csl")).toBe(true);
  });

  it("rejects ids that sanitize to an empty name", () => {
    expect(() => cslFileNameFor("..")).toThrowError(
      expect.objectContaining({ code: "unsafe_name" }),
    );
    expect(() => cslFileNameFor("///")).toThrowError(
      expect.objectContaining({ code: "unsafe_name" }),
    );
  });
});

describe("importCslStyle", () => {
  it("copies a valid style verbatim into the csl directory", async () => {
    const { port, files, writes } = makeMemoryPort();
    const result = await importCslStyle(port, CSL_STYLE_DIR, AMA_CSL);

    expect(result.status).toBe("imported");
    if (result.status !== "imported") {
      return;
    }
    expect(result.meta.file).toBe("american-medical-association.csl");
    expect(result.meta.title).toBe("American Medical Association");
    expect(files.get(`${CSL_STYLE_DIR}/american-medical-association.csl`)).toBe(
      AMA_CSL,
    );
    expect(writes).toEqual([`${CSL_STYLE_DIR}/american-medical-association.csl`]);
  });

  it("reports a collision and never overwrites an existing style", async () => {
    const { port, files } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/american-medical-association.csl`, NATURE_CSL],
    ]);
    const result = await importCslStyle(port, CSL_STYLE_DIR, AMA_CSL);

    expect(result.status).toBe("collision");
    if (result.status !== "collision") {
      return;
    }
    expect(result.meta.file).toBe("american-medical-association.csl");
    expect(
      files.get(`${CSL_STYLE_DIR}/american-medical-association.csl`),
    ).toBe(NATURE_CSL);
  });

  it("rejects malformed XML and writes nothing", async () => {
    const { port, files, writes } = makeMemoryPort();
    const broken = AMA_CSL.replace("</style>", "</stlye>");

    await expect(
      importCslStyle(port, CSL_STYLE_DIR, broken),
    ).rejects.toBeInstanceOf(CslStyleError);
    expect(writes).toEqual([]);
    expect(files.size).toBe(0);
  });

  it("only ever writes inside the csl directory, even for hostile ids", async () => {
    const { port, writes } = makeMemoryPort();
    const hostile = AMA_CSL.replace(AMA_STYLE_ID, "../../etc/passwd");

    await expect(
      importCslStyle(port, CSL_STYLE_DIR, hostile),
    ).resolves.toMatchObject({ status: "imported" });
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(new RegExp(`^${CSL_STYLE_DIR}/[^/]+$`));
    expect(writes[0]).not.toContain("..");
  });
});

describe("listCslStyles", () => {
  it("lists imported style title/id/file sorted by title", async () => {
    const { port } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/american-medical-association.csl`, AMA_CSL],
      [`${CSL_STYLE_DIR}/nature.csl`, NATURE_CSL],
    ]);

    const styles = await listCslStyles(port, CSL_STYLE_DIR);

    expect(styles).toEqual([
      {
        file: "american-medical-association.csl",
        title: "American Medical Association",
        id: AMA_STYLE_ID,
      },
      { file: "nature.csl", title: "Nature", id: NATURE_STYLE_ID },
    ]);
  });

  it("ignores non-.csl files and corrupt .csl files", async () => {
    const { port } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/nature.csl`, NATURE_CSL],
      [`${CSL_STYLE_DIR}/notes.txt`, "not a style"],
      [`${CSL_STYLE_DIR}/broken.csl`, "<style xmlns=\"http://purl.org/net/xbiblio/csl\">"],
    ]);

    const styles = await listCslStyles(port, CSL_STYLE_DIR);

    expect(styles).toEqual([
      { file: "nature.csl", title: "Nature", id: NATURE_STYLE_ID },
    ]);
  });
});

describe("requireExportStyle", () => {
  it("blocks export with an actionable error when no style is selected", async () => {
    const { port } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/nature.csl`, NATURE_CSL],
    ]);

    const check = await requireExportStyle(port, CSL_STYLE_DIR, "");

    expect(check.ok).toBe(false);
    if (check.ok) {
      return;
    }
    expect(check.error).toContain("CSL Style Manager");
    expect(check.error).toContain("default");
  });

  it("blocks export when the selected style file is missing", async () => {
    const { port } = makeMemoryPort([]);

    const check = await requireExportStyle(
      port,
      CSL_STYLE_DIR,
      "american-medical-association.csl",
    );

    expect(check.ok).toBe(false);
    if (check.ok) {
      return;
    }
    expect(check.error).toContain("american-medical-association.csl");
    expect(check.error).toContain("Re-import");
  });

  it("blocks export when the selected style file is corrupt", async () => {
    const { port } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/broken.csl`, "<style>"],
    ]);

    const check = await requireExportStyle(port, CSL_STYLE_DIR, "broken.csl");

    expect(check.ok).toBe(false);
    if (check.ok) {
      return;
    }
    expect(check.error).toContain("Re-import");
  });

  it("blocks traversal-looking selection values", async () => {
    const { port } = makeMemoryPort([]);

    const check = await requireExportStyle(port, CSL_STYLE_DIR, "../x.csl");

    expect(check.ok).toBe(false);
    if (check.ok) {
      return;
    }
    expect(check.error.length).toBeGreaterThan(0);
  });

  it("resolves a valid selection to the vault-relative path", async () => {
    const { port } = makeMemoryPort([
      [`${CSL_STYLE_DIR}/nature.csl`, NATURE_CSL],
    ]);

    const check = await requireExportStyle(port, CSL_STYLE_DIR, "nature.csl");

    expect(check.ok).toBe(true);
    if (!check.ok) {
      return;
    }
    expect(check.file).toBe("nature.csl");
    expect(check.path).toBe(`${CSL_STYLE_DIR}/nature.csl`);
    expect(check.title).toBe("Nature");
  });
});

describe("CSL configuration never mutates paper Markdown", () => {
  it("performs zero writes outside the csl directory across the whole flow", async () => {
    const { port, files, writes } = makeMemoryPort([
      ["05 Literature/Paper A.md", "---\ntitle: A\n---\nbody"],
    ]);

    await importCslStyle(port, CSL_STYLE_DIR, AMA_CSL);
    await importCslStyle(port, CSL_STYLE_DIR, NATURE_CSL);
    await listCslStyles(port, CSL_STYLE_DIR);
    await requireExportStyle(port, CSL_STYLE_DIR, "nature.csl");

    expect(writes.length).toBeGreaterThan(0);
    for (const path of writes) {
      expect(path.startsWith(`${CSL_STYLE_DIR}/`)).toBe(true);
      expect(path.endsWith(".md")).toBe(false);
    }
    expect(files.get("05 Literature/Paper A.md")).toBe(
      "---\ntitle: A\n---\nbody",
    );
  });
});

describe("global default (settings)", () => {
  it("setDefaultCsl returns a new settings object without mutating the input", () => {
    const settings: PaperNotesSettings = { ...DEFAULT_SETTINGS };

    const updated = setDefaultCsl(settings, "nature.csl");

    expect(updated.selectedCsl).toBe("nature.csl");
    expect(settings.selectedCsl).toBe("");
  });

  it("normalizeSettings preserves a persisted selectedCsl string", () => {
    const settings = normalizeSettings({ selectedCsl: "nature.csl" });
    expect(settings.selectedCsl).toBe("nature.csl");
  });

  it("CSL_STYLE_DIR points at the vault-level csl directory", () => {
    expect(CSL_STYLE_DIR).toBe(".paper-notes/csl");
  });
});

interface FakeElOptions {
  cls?: string;
  text?: string;
}

interface FakeEl {
  textContent: string;
  value: string;
  cls: string;
  children: FakeEl[];
  listeners: Record<string, Array<(event?: unknown) => void>>;
  setText(text: string): void;
  empty(): void;
  createDiv(options?: FakeElOptions): FakeEl;
  createEl(tag: string, options?: FakeElOptions): FakeEl;
  addEventListener(
    name: string,
    handler: (event?: unknown) => void,
  ): void;
}

function makeFakeEl(): FakeEl {
  const children: FakeEl[] = [];
  const listeners: Record<string, Array<(event?: unknown) => void>> = {};
  const el: FakeEl = {
    textContent: "",
    value: "",
    cls: "",
    children,
    listeners,
    setText(text: string): void {
      el.textContent = text;
    },
    empty(): void {
      children.length = 0;
    },
    createDiv(options?: FakeElOptions): FakeEl {
      return makeChild(options);
    },
    createEl(_tag: string, options?: FakeElOptions): FakeEl {
      return makeChild(options);
    },
    addEventListener(
      name: string,
      handler: (event?: unknown) => void,
    ): void {
      (listeners[name] ??= []).push(handler);
    },
  };
  function makeChild(options?: FakeElOptions): FakeEl {
    const child = makeFakeEl();
    if (options?.cls !== undefined) {
      child.cls = options.cls;
    }
    if (options?.text !== undefined) {
      child.textContent = options.text;
    }
    children.push(child);
    return child;
  }
  return el;
}

/**
 * The mock factory is evaluated as soon as the static `import { Modal }`
 * in the modal source runs — before the top-level `class` declarations
 * below. `FakeModal` must therefore be created via `vi.hoisted`
 * (Repair: Gate D R8 static-import follow-up).
 */
const FakeModal = vi.hoisted(() => {
  class FakeModal {
    titleEl: FakeEl;
    contentEl: FakeEl;
    app: unknown;

    constructor(app: unknown) {
      this.app = app;
      this.titleEl = makeFakeEl();
      this.contentEl = makeFakeEl();
    }

    open(): void {
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }

    close(): void {}
  }
  return FakeModal;
});

vi.mock("obsidian", () => ({ Modal: FakeModal }));

function makeModalCallbacks(): {
  callbacks: CslStyleModalCallbacks;
  pickCslFile: ReturnType<typeof vi.fn>;
  importStyle: ReturnType<typeof vi.fn>;
  setDefault: ReturnType<typeof vi.fn>;
  defaultFile: { current: string };
} {
  const defaultFile = { current: "nature.csl" };
  const pickCslFile = vi.fn();
  const importStyle = vi.fn();
  const setDefault = vi.fn((file: string) => {
    defaultFile.current = file;
    return Promise.resolve();
  });
  const listStyles = vi.fn(() =>
    Promise.resolve([
      {
        file: "american-medical-association.csl",
        title: "American Medical Association",
        id: AMA_STYLE_ID,
      },
      { file: "nature.csl", title: "Nature", id: NATURE_STYLE_ID },
    ]),
  );
  const callbacks: CslStyleModalCallbacks = {
    listStyles,
    pickCslFile,
    importStyle,
    setDefault,
    currentDefault: () => defaultFile.current,
  };
  return { callbacks, pickCslFile, importStyle, setDefault, defaultFile };
}

function listRows(handle: { contentEl: HTMLElement }): FakeEl[] {
  const content = handle.contentEl as unknown as FakeEl;
  const list = content.children.find((child) => child.cls === "paper-notes-csl-list");
  return list === undefined ? [] : list.children;
}

function messageOf(handle: { contentEl: HTMLElement }): FakeEl | undefined {
  const content = handle.contentEl as unknown as FakeEl;
  return content.children.find((child) => child.cls === "paper-notes-csl-message");
}

function buttonOf(row: FakeEl, label: string): FakeEl | undefined {
  return row.children.find((child) => child.textContent === label);
}

function actionButtonOf(
  handle: { contentEl: HTMLElement },
  label: string,
): FakeEl | undefined {
  const content = handle.contentEl as unknown as FakeEl;
  const actions = content.children.find(
    (child) => child.cls === "paper-notes-modal-actions",
  );
  if (actions === undefined) {
    return undefined;
  }
  return actions.children.find((child) => child.textContent === label);
}

describe("csl style modal wiring (fake DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders imported styles and marks the current default", async () => {
    const { callbacks } = makeModalCallbacks();
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    const rows = listRows(handle);
    expect(rows[0]?.textContent).toBe("American Medical Association");
    expect(rows[1]?.textContent).toBe("Nature");
    expect(buttonOf(rows[0] as FakeEl, "Set default")).toBeDefined();
    expect(buttonOf(rows[1] as FakeEl, "Default")).toBeDefined();
  });

  it("setting a default calls back with the row's file and re-renders", async () => {
    const { callbacks, setDefault, defaultFile } = makeModalCallbacks();
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    const amaButton = buttonOf(listRows(handle)[0] as FakeEl, "Set default");
    amaButton?.listeners?.click?.[0]?.();
    await vi.waitFor(() => {
      expect(setDefault).toHaveBeenCalledWith(
        "american-medical-association.csl",
      );
    });
    expect(defaultFile.current).toBe("american-medical-association.csl");
    await vi.waitFor(() => {
      expect(buttonOf(listRows(handle)[0] as FakeEl, "Default")).toBeDefined();
    });
  });

  it("importing a picked file reports success and refreshes", async () => {
    const { callbacks, pickCslFile, importStyle } = makeModalCallbacks();
    pickCslFile.mockResolvedValue({ name: "ama.csl", text: AMA_CSL });
    importStyle.mockResolvedValue({
      status: "imported",
      meta: {
        file: "american-medical-association.csl",
        title: "American Medical Association",
        id: AMA_STYLE_ID,
      },
    });
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    actionButtonOf(handle, "Import .csl…")?.listeners?.click?.[0]?.();
    await vi.waitFor(() => {
      expect(importStyle).toHaveBeenCalledWith(AMA_CSL);
    });
    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toContain("Imported");
    });
  });

  it("reports an already-imported collision", async () => {
    const { callbacks, pickCslFile, importStyle } = makeModalCallbacks();
    pickCslFile.mockResolvedValue({ name: "ama.csl", text: AMA_CSL });
    importStyle.mockResolvedValue({
      status: "collision",
      meta: {
        file: "american-medical-association.csl",
        title: "American Medical Association",
        id: AMA_STYLE_ID,
      },
    });
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    actionButtonOf(handle, "Import .csl…")?.listeners?.click?.[0]?.();
    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toContain("already imported");
    });
  });

  it("surfaces a rejection (e.g. malformed XML) as an error message", async () => {
    const { callbacks, pickCslFile, importStyle } = makeModalCallbacks();
    pickCslFile.mockResolvedValue({ name: "broken.csl", text: "<style>" });
    importStyle.mockRejectedValue(
      new CslStyleError("malformed_xml", "Malformed XML."),
    );
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    actionButtonOf(handle, "Import .csl…")?.listeners?.click?.[0]?.();
    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toBe("Malformed XML.");
    });
  });

  it("does nothing when the file pick is cancelled", async () => {
    const { callbacks, pickCslFile, importStyle } = makeModalCallbacks();
    pickCslFile.mockResolvedValue(null);
    const handle = createCslStyleModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    actionButtonOf(handle, "Import .csl…")?.listeners?.click?.[0]?.();
    await vi.waitFor(() => {
      expect(importStyle).not.toHaveBeenCalled();
    });
  });
});
