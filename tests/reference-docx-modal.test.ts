/**
 * Reference DOCX Template Library modal tests (Stage R3 / ADR 0005).
 *
 * Covers:
 * 1. Modal component UI wiring (`src/modals/reference-docx-modal.ts`):
 *    - List rendering (renders file names, marks default with "Default", non-default with "Set default")
 *    - Set default (clicking "Set default" invokes callback and updates UI)
 *    - Delete (delete button is disabled on default; non-default triggers delete and refreshes)
 *    - Import flow (native picker integration, importing, handling cancellation and errors)
 *    - Close callback
 * 2. Main plugin callback wiring (`openReferenceDocxManager` in `src/main.ts`):
 *    - listTemplates (vault listing, docx filtering, sorting, fault tolerance)
 *    - setDefault / currentDefault (persisting settings)
 *    - deleteTemplate (blocking default deletion, adapter removal)
 *    - importTemplate (binary copy into vault directory)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin from "../src/main";
import {
  createReferenceDocxModal,
  type ReferenceDocxModalCallbacks,
  type ReferenceDocxModalHandle,
} from "../src/modals/reference-docx-modal";
import * as refDocxModalModule from "../src/modals/reference-docx-modal";
import { REFERENCE_DOCX_DIR } from "../src/settings";

interface MockEl {
  cls?: string;
  textContent?: string;
  disabled?: boolean;
  attrs: Record<string, string>;
  children: MockEl[];
  listeners: Record<string, ((event?: unknown) => void)[]>;
  click(): void;
  getAttribute(name: string): string | null;
}

function listRows(handle: ReferenceDocxModalHandle): MockEl[] {
  const content = handle.contentEl as unknown as MockEl;
  const list = content.children.find(
    (child) => child.cls === "paper-notes-refdocx-list",
  );
  return list ? list.children : [];
}

function messageOf(handle: ReferenceDocxModalHandle): MockEl | undefined {
  const content = handle.contentEl as unknown as MockEl;
  return content.children.find(
    (child) => child.cls === "paper-notes-refdocx-message",
  );
}

function buttonOf(row: MockEl, label: string): MockEl | undefined {
  return row.children.find((child) => child.textContent === label);
}

function actionButtonOf(
  handle: ReferenceDocxModalHandle,
  label: string,
): MockEl | undefined {
  const content = handle.contentEl as unknown as MockEl;
  const actions = content.children.find(
    (child) => child.cls === "paper-notes-modal-actions",
  );
  if (!actions) {
    return undefined;
  }
  return actions.children.find((child) => child.textContent === label);
}

function makeModalCallbacks(initialTemplates: string[] = ["custom.docx", "standard.docx"]): {
  callbacks: ReferenceDocxModalCallbacks;
  templates: { current: string[] };
  defaultFile: { current: string };
  listTemplates: ReturnType<typeof vi.fn>;
  pickTemplateFile: ReturnType<typeof vi.fn>;
  importTemplate: ReturnType<typeof vi.fn>;
  setDefault: ReturnType<typeof vi.fn>;
  deleteTemplate: ReturnType<typeof vi.fn>;
} {
  const templates = { current: [...initialTemplates] };
  const defaultFile = { current: "standard.docx" };

  const listTemplates = vi.fn(async () => [...templates.current]);
  const pickTemplateFile = vi.fn(async () => null as { name: string; sourcePath: string } | null);
  const importTemplate = vi.fn(async (_sourcePath: string, fileName: string) => {
    if (!templates.current.includes(fileName)) {
      templates.current.push(fileName);
    }
  });
  const setDefault = vi.fn(async (file: string) => {
    defaultFile.current = file;
  });
  const deleteTemplate = vi.fn(async (file: string) => {
    if (file === defaultFile.current) {
      throw new Error("Cannot delete the current default template.");
    }
    templates.current = templates.current.filter((t) => t !== file);
  });

  const callbacks: ReferenceDocxModalCallbacks = {
    listTemplates,
    pickTemplateFile,
    importTemplate,
    setDefault,
    currentDefault: () => defaultFile.current,
    deleteTemplate,
  };

  return {
    callbacks,
    templates,
    defaultFile,
    listTemplates,
    pickTemplateFile,
    importTemplate,
    setDefault,
    deleteTemplate,
  };
}

describe("ReferenceDocxModal component wiring", () => {
  it("renders imported templates and distinguishes default vs non-default", async () => {
    const { callbacks } = makeModalCallbacks(["custom.docx", "standard.docx"]);
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    const rows = listRows(handle);
    expect(rows[0]?.textContent).toBe("custom.docx");
    expect(rows[1]?.textContent).toBe("standard.docx");

    // Row 0 is non-default
    expect(buttonOf(rows[0]!, "Set default")).toBeDefined();
    const deleteBtn0 = buttonOf(rows[0]!, "Delete");
    expect(deleteBtn0).toBeDefined();
    expect(deleteBtn0?.disabled).toBeFalsy();

    // Row 1 is default
    expect(buttonOf(rows[1]!, "Default")).toBeDefined();
    const deleteBtn1 = buttonOf(rows[1]!, "Delete");
    expect(deleteBtn1).toBeDefined();
    expect(deleteBtn1?.disabled).toBe(true);
    expect(deleteBtn1?.getAttribute("disabled")).toBe("true");
  });

  it("sets a new default and re-renders", async () => {
    const { callbacks, setDefault, defaultFile } = makeModalCallbacks([
      "custom.docx",
      "standard.docx",
    ]);
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    const setDefaultBtn = buttonOf(listRows(handle)[0]!, "Set default");
    setDefaultBtn?.click();

    await vi.waitFor(() => {
      expect(setDefault).toHaveBeenCalledWith("custom.docx");
    });
    expect(defaultFile.current).toBe("custom.docx");

    await vi.waitFor(() => {
      // Row 0 is now Default
      expect(buttonOf(listRows(handle)[0]!, "Default")).toBeDefined();
      expect(buttonOf(listRows(handle)[0]!, "Delete")?.disabled).toBe(true);
      // Row 1 is now Set default
      expect(buttonOf(listRows(handle)[1]!, "Set default")).toBeDefined();
      expect(buttonOf(listRows(handle)[1]!, "Delete")?.disabled).toBeFalsy();
    });
  });

  it("surfaces an error when setting default fails", async () => {
    const { callbacks, setDefault } = makeModalCallbacks(["custom.docx", "standard.docx"]);
    setDefault.mockRejectedValue(new Error("Disk write error."));
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    buttonOf(listRows(handle)[0]!, "Set default")?.click();

    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toBe("Disk write error.");
    });
  });

  it("deleting a template calls callback and refreshes the list", async () => {
    const { callbacks, deleteTemplate } = makeModalCallbacks([
      "custom.docx",
      "standard.docx",
    ]);
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    buttonOf(listRows(handle)[0]!, "Delete")?.click();

    await vi.waitFor(() => {
      expect(deleteTemplate).toHaveBeenCalledWith("custom.docx");
    });

    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toContain('Deleted template "custom.docx".');
      expect(listRows(handle).length).toBe(1);
      expect(listRows(handle)[0]?.textContent).toBe("standard.docx");
    });
  });

  it("blocks deleting the current default template", async () => {
    const { callbacks, deleteTemplate } = makeModalCallbacks([
      "custom.docx",
      "standard.docx",
    ]);
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    const defaultRow = listRows(handle)[1]!;
    const defaultDeleteBtn = buttonOf(defaultRow, "Delete");
    expect(defaultDeleteBtn?.disabled).toBe(true);

    // Clicking disabled button doesn't trigger deleteTemplate
    defaultDeleteBtn?.click();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it("surfaces an error when deleteTemplate fails", async () => {
    const { callbacks, deleteTemplate } = makeModalCallbacks([
      "custom.docx",
      "standard.docx",
    ]);
    deleteTemplate.mockRejectedValue(new Error("Permission denied."));
    const handle = createReferenceDocxModal({} as App, callbacks);

    handle.open();
    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(2);
    });

    buttonOf(listRows(handle)[0]!, "Delete")?.click();

    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toBe("Permission denied.");
    });
  });

  it("import flow calls native picker and imports template", async () => {
    const { callbacks, pickTemplateFile, importTemplate } = makeModalCallbacks([
      "standard.docx",
    ]);
    pickTemplateFile.mockResolvedValue({
      name: "new-template.docx",
      sourcePath: "/tmp/new-template.docx",
    });

    const handle = createReferenceDocxModal({} as App, callbacks);
    handle.open();

    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(1);
    });

    actionButtonOf(handle, "Import .docx…")?.click();

    await vi.waitFor(() => {
      expect(pickTemplateFile).toHaveBeenCalled();
      expect(importTemplate).toHaveBeenCalledWith(
        "/tmp/new-template.docx",
        "new-template.docx",
      );
    });

    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toBe('Imported "new-template.docx".');
      expect(listRows(handle).length).toBe(2);
    });
  });

  it("import flow does nothing when user cancels file picker", async () => {
    const { callbacks, pickTemplateFile, importTemplate } = makeModalCallbacks([
      "standard.docx",
    ]);
    pickTemplateFile.mockResolvedValue(null);

    const handle = createReferenceDocxModal({} as App, callbacks);
    handle.open();

    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(1);
    });

    actionButtonOf(handle, "Import .docx…")?.click();

    await vi.waitFor(() => {
      expect(pickTemplateFile).toHaveBeenCalled();
    });

    expect(importTemplate).not.toHaveBeenCalled();
    expect(messageOf(handle)?.textContent).toBe("");
  });

  it("import flow surfaces an error when importTemplate fails", async () => {
    const { callbacks, pickTemplateFile, importTemplate } = makeModalCallbacks([
      "standard.docx",
    ]);
    pickTemplateFile.mockResolvedValue({
      name: "corrupted.docx",
      sourcePath: "/tmp/corrupted.docx",
    });
    importTemplate.mockRejectedValue(new Error("File corrupt or unreadable."));

    const handle = createReferenceDocxModal({} as App, callbacks);
    handle.open();

    await vi.waitFor(() => {
      expect(listRows(handle).length).toBe(1);
    });

    actionButtonOf(handle, "Import .docx…")?.click();

    await vi.waitFor(() => {
      expect(messageOf(handle)?.textContent).toBe("File corrupt or unreadable.");
    });
  });

  it("close button calls onClose callback", async () => {
    const { callbacks } = makeModalCallbacks();
    const onClose = vi.fn();
    const handle = createReferenceDocxModal({} as App, callbacks, onClose);

    handle.open();
    actionButtonOf(handle, "Close")?.click();

    expect(onClose).toHaveBeenCalled();
  });
});

describe("PaperNotesPlugin.openReferenceDocxManager callbacks wiring", () => {
  let tempDir: string;
  let adapter: {
    list: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    writeBinary: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let plugin: PaperNotesPlugin;
  let capturedCallbacks: ReferenceDocxModalCallbacks | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-refdocx-test-"));
    capturedCallbacks = null;

    adapter = {
      list: vi.fn().mockResolvedValue({ files: [] }),
      exists: vi.fn().mockResolvedValue(true),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeBinary: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    const app = {
      vault: {
        adapter,
      },
      workspace: {
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: () => Promise.resolve(),
      },
    } as unknown as App;

    const manifest = {
      id: "paper-notes",
      name: "Paper Notes",
      version: "1.0.0",
      minAppVersion: "1.4.0",
      description: "test fixture",
      isDesktopOnly: true,
    } as PluginManifest;

    plugin = new PaperNotesPlugin(app, manifest);
    plugin.settings.referenceDocx = "default.docx";

    vi.spyOn(refDocxModalModule, "createReferenceDocxModal").mockImplementation(
      (_app, callbacks, _onClose) => {
        capturedCallbacks = callbacks;
        return {
          open: vi.fn(),
          close: vi.fn(),
          contentEl: {} as HTMLElement,
        };
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it("listTemplates lists .docx files in REFERENCE_DOCX_DIR and filters non-docx", async () => {
    adapter.list.mockResolvedValue({
      files: [
        ".paper-notes/reference-docx/zebra.docx",
        ".paper-notes/reference-docx/alpha.docx",
        ".paper-notes/reference-docx/not-a-template.txt",
        ".paper-notes/reference-docx/style.csl",
      ],
    });

    plugin.openReferenceDocxManager();
    expect(capturedCallbacks).not.toBeNull();

    const list = await capturedCallbacks!.listTemplates();
    expect(adapter.list).toHaveBeenCalledWith(REFERENCE_DOCX_DIR);
    expect(list).toEqual(["alpha.docx", "zebra.docx"]);
  });

  it("listTemplates handles object files array format", async () => {
    adapter.list.mockResolvedValue({
      files: [
        { name: "b.docx" },
        { name: "a.docx" },
        { name: "c.pdf" },
      ],
    });

    plugin.openReferenceDocxManager();
    const list = await capturedCallbacks!.listTemplates();
    expect(list).toEqual(["a.docx", "b.docx"]);
  });

  it("listTemplates gracefully returns empty array when directory list throws", async () => {
    adapter.list.mockRejectedValue(new Error("Directory not found"));

    plugin.openReferenceDocxManager();
    const list = await capturedCallbacks!.listTemplates();
    expect(list).toEqual([]);
  });

  it("setDefault updates plugin settings and saves", async () => {
    const saveSpy = vi.spyOn(plugin, "saveSettings").mockResolvedValue(undefined);

    plugin.openReferenceDocxManager();
    await capturedCallbacks!.setDefault("new-choice.docx");

    expect(plugin.settings.referenceDocx).toBe("new-choice.docx");
    expect(saveSpy).toHaveBeenCalled();
  });

  it("currentDefault returns current referenceDocx setting", () => {
    plugin.settings.referenceDocx = "active.docx";
    plugin.openReferenceDocxManager();

    expect(capturedCallbacks!.currentDefault()).toBe("active.docx");
  });

  it("deleteTemplate blocks deleting the current default template", async () => {
    plugin.settings.referenceDocx = "locked.docx";
    plugin.openReferenceDocxManager();

    await expect(capturedCallbacks!.deleteTemplate("locked.docx")).rejects.toThrow(
      "Cannot delete the current default template.",
    );
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("deleteTemplate removes non-default template via adapter", async () => {
    plugin.settings.referenceDocx = "keep.docx";
    plugin.openReferenceDocxManager();

    await capturedCallbacks!.deleteTemplate("remove-me.docx");
    expect(adapter.remove).toHaveBeenCalledWith(
      `${REFERENCE_DOCX_DIR}/remove-me.docx`,
    );
  });

  it("deleteTemplate propagates adapter removal failure", async () => {
    plugin.settings.referenceDocx = "keep.docx";
    adapter.remove.mockRejectedValue(new Error("EPERM: operation not permitted"));
    plugin.openReferenceDocxManager();

    await expect(
      capturedCallbacks!.deleteTemplate("remove-me.docx"),
    ).rejects.toThrow("EPERM: operation not permitted");
  });

  it("importTemplate copies source file into vault reference-docx directory", async () => {
    const sourceFile = join(tempDir, "my-template.docx");
    writeFileSync(sourceFile, Buffer.from("fake-docx-binary-data"));
    adapter.exists.mockResolvedValue(false);

    plugin.openReferenceDocxManager();
    await capturedCallbacks!.importTemplate(sourceFile, "my-template.docx");

    expect(adapter.mkdir).toHaveBeenCalledWith(REFERENCE_DOCX_DIR);
    expect(adapter.writeBinary).toHaveBeenCalledWith(
      `${REFERENCE_DOCX_DIR}/my-template.docx`,
      expect.any(ArrayBuffer),
    );
  });
});
