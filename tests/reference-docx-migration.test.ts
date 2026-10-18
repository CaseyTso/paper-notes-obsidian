import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockAccess, mockReadFile } = vi.hoisted(() => {
  return {
    mockAccess: vi.fn(),
    mockReadFile: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async (p: any, ...args: any[]) => {
      const custom = mockAccess.getMockImplementation();
      if (custom) {
        return custom(p, ...args);
      }
      return actual.access(p, ...args);
    }),
    readFile: vi.fn(async (p: any, ...args: any[]) => {
      const custom = mockReadFile.getMockImplementation();
      if (custom) {
        return custom(p, ...args);
      }
      return actual.readFile(p, ...args);
    }),
  };
});

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin from "../src/main";
import { REFERENCE_DOCX_DIR } from "../src/settings";

interface MockVaultAdapter {
  remove: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getFullPath: ReturnType<typeof vi.fn>;
}

function makePluginWithAdapter(
  adapter: MockVaultAdapter,
  initialData: Record<string, unknown> = {},
): {
  plugin: PaperNotesPlugin;
  savedData: Record<string, unknown>[];
} {
  const savedData: Record<string, unknown>[] = [];
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

  const plugin = new PaperNotesPlugin(app, manifest);

  let currentData = { ...initialData };
  plugin.loadData = vi.fn().mockImplementation(async () => currentData);
  plugin.saveData = vi.fn().mockImplementation(async (data: unknown) => {
    currentData = { ...(data as Record<string, unknown>) };
    savedData.push(currentData);
  });

  return { plugin, savedData };
}

describe("Reference DOCX migration (Stage R1)", () => {
  let tempDir: string;
  let adapter: MockVaultAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockReset();
    mockReadFile.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-ref-docx-"));
    adapter = {
      remove: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(false),
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ files: [] }),
      getFullPath: vi.fn((p: string) => `/vault/${p}`),
    };
  });

  afterEach(() => {
    mockAccess.mockReset();
    mockReadFile.mockReset();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("exports REFERENCE_DOCX_DIR constant with the correct vault path", () => {
    expect(REFERENCE_DOCX_DIR).toBe(".paper-notes/reference-docx");
  });

  it("skips migration when referenceDocx is empty", async () => {
    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = "";

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(adapter.write).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.settings.referenceDocx).toBe("");
  });

  it("skips migration when referenceDocx is already a clean filename", async () => {
    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = "custom-template.docx";

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(adapter.write).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.settings.referenceDocx).toBe("custom-template.docx");
  });

  it("migrates existing file: creates directory, writes file, updates settings, and saves", async () => {
    const docxPath = join(tempDir, "legacy-template.docx");
    const docxContent = Buffer.from("dummy-docx-binary-content");
    writeFileSync(docxPath, docxContent);

    adapter.exists.mockResolvedValue(false);

    const { plugin, savedData } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = docxPath;

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(adapter.exists).toHaveBeenCalledWith(".paper-notes/reference-docx");
    expect(adapter.mkdir).toHaveBeenCalledWith(".paper-notes/reference-docx");
    expect(adapter.write).toHaveBeenCalledWith(
      ".paper-notes/reference-docx/legacy-template.docx",
      docxContent,
    );
    expect(plugin.settings.referenceDocx).toBe("legacy-template.docx");
    expect(savedData.length).toBe(1);
    expect(savedData[0].referenceDocx).toBe("legacy-template.docx");
  });

  it("does not call mkdir if directory already exists", async () => {
    const docxPath = join(tempDir, "existing-dir-template.docx");
    writeFileSync(docxPath, "binary");

    adapter.exists.mockResolvedValue(true);

    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = docxPath;

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(adapter.exists).toHaveBeenCalledWith(".paper-notes/reference-docx");
    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.write).toHaveBeenCalledWith(
      ".paper-notes/reference-docx/existing-dir-template.docx",
      expect.any(Buffer),
    );
    expect(plugin.settings.referenceDocx).toBe("existing-dir-template.docx");
  });

  it("handles Windows backslash separators in legacy paths", async () => {
    const winPath = "C:\\Users\\tester\\Documents\\win-template.docx";
    const winBuffer = Buffer.from("win-data");

    mockAccess.mockImplementation(async (p: string) => {
      if (p === winPath) {
        return undefined;
      }
      throw new Error("File not found");
    });
    mockReadFile.mockImplementation(async (p: string) => {
      if (p === winPath) {
        return winBuffer;
      }
      throw new Error("File not found");
    });

    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = winPath;

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(plugin.settings.referenceDocx).toBe("win-template.docx");
    expect(adapter.write).toHaveBeenCalledWith(
      ".paper-notes/reference-docx/win-template.docx",
      winBuffer,
    );
  });

  it("is idempotent: migrating twice does not copy or save again", async () => {
    const docxPath = join(tempDir, "idempotent-template.docx");
    writeFileSync(docxPath, "content");

    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = docxPath;

    // Run 1: performs migration
    await (plugin as any).migrateLegacyReferenceDocx();
    expect(plugin.settings.referenceDocx).toBe("idempotent-template.docx");
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);

    // Run 2: skips since referenceDocx is now a clean filename
    await (plugin as any).migrateLegacyReferenceDocx();
    expect(plugin.settings.referenceDocx).toBe("idempotent-template.docx");
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
  });

  it("clears referenceDocx when file does not exist on disk", async () => {
    const missingPath = join(tempDir, "nonexistent-template.docx");

    const { plugin, savedData } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = missingPath;

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(adapter.write).not.toHaveBeenCalled();
    expect(plugin.settings.referenceDocx).toBe("");
    expect(savedData.length).toBe(1);
    expect(savedData[0].referenceDocx).toBe("");

    // Running again remains empty and does not call saveData again
    await (plugin as any).migrateLegacyReferenceDocx();
    expect(savedData.length).toBe(1);
  });

  it("handles adapter.write errors gracefully without breaking plugin load", async () => {
    const docxPath = join(tempDir, "error-template.docx");
    writeFileSync(docxPath, "content");

    adapter.write.mockRejectedValue(new Error("EACCES: write permission denied"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { plugin } = makePluginWithAdapter(adapter);
    plugin.settings.referenceDocx = docxPath;

    await expect(
      (plugin as any).migrateLegacyReferenceDocx(),
    ).resolves.toBeUndefined();

    // Setting remains as-is so nothing is lost
    expect(plugin.settings.referenceDocx).toBe(docxPath);
    expect(consoleSpy).toHaveBeenCalledWith(
      "Paper Notes: failed to migrate legacy reference DOCX template",
      expect.any(Error),
    );
  });

  it("logs error and leaves setting as-is when vault adapter has no write method", async () => {
    const docxPath = join(tempDir, "no-write-template.docx");
    writeFileSync(docxPath, "content");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const noWriteAdapter = {
      ...adapter,
      write: undefined as any,
    };
    const { plugin } = makePluginWithAdapter(noWriteAdapter);
    plugin.settings.referenceDocx = docxPath;

    await (plugin as any).migrateLegacyReferenceDocx();

    expect(plugin.settings.referenceDocx).toBe(docxPath);
    expect(consoleSpy).toHaveBeenCalledWith(
      "Paper Notes: cannot migrate reference DOCX because vault adapter write is not available.",
    );
  });

  it("migrates automatically during initializeCliBridge", async () => {
    const docxPath = join(tempDir, "bridge-template.docx");
    writeFileSync(docxPath, "docx");

    const { plugin, savedData } = makePluginWithAdapter(adapter, {
      referenceDocx: docxPath,
    });

    await (plugin as any).initializeCliBridge();

    expect(plugin.settings.referenceDocx).toBe("bridge-template.docx");
    expect(savedData[0].referenceDocx).toBe("bridge-template.docx");
    expect(adapter.write).toHaveBeenCalledWith(
      ".paper-notes/reference-docx/bridge-template.docx",
      expect.any(Buffer),
    );
  });
});
