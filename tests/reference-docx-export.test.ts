import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("obsidian", () => import("./obsidian.mock"));

import { TFile, recordedNotices, resetRegistries } from "./obsidian.mock";
import PaperNotesPlugin from "../src/main";
import { REFERENCE_DOCX_DIR } from "../src/settings";

const VALID_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Test Style</title>
    <id>http://www.zotero.org/styles/test</id>
  </info>
</style>`;

describe("Stage R2: Reference DOCX Template Library resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    resetRegistries();
    tempDir = mkdtempSync(join(tmpdir(), "paper-notes-r2-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  function makePlugin(options: {
    referenceDocx?: string;
    getFullPath?: (p: string) => string;
    cachedRead?: (f: TFile) => Promise<string>;
    activeFile?: TFile | null;
  }) {
    const file = options.activeFile !== undefined
      ? options.activeFile
      : new TFile("Notes/TestNote.md");

    const getFullPathMock = vi.fn(
      options.getFullPath ??
        ((p: string) => join(tempDir, p.replace(/^\.\//, "")))
    );

    const app = {
      workspace: {
        getActiveFile: () => file,
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: () => Promise.resolve(),
      },
      vault: {
        adapter: {
          getFullPath: getFullPathMock,
          list: vi.fn(async () => ({ files: [{ name: "test.csl" }] })),
          read: vi.fn(async () => VALID_CSL),
          write: vi.fn(async () => {}),
          exists: vi.fn(async () => false),
        },
        cachedRead: options.cachedRead ?? vi.fn(async () => "# Hello world\nNo citations here."),
      },
    } as any;

    const manifest = {
      id: "paper-notes",
      name: "Paper Notes",
      version: "1.0.0",
      minAppVersion: "1.4.0",
      description: "test fixture",
      isDesktopOnly: true,
    } as any;

    const plugin = new PaperNotesPlugin(app, manifest);
    plugin.settings.exportDirectory = tempDir;
    plugin.settings.pandocPath = "pandoc";
    plugin.settings.selectedCsl = "test.csl";
    plugin.settings.referenceDocx = options.referenceDocx ?? "";
    return { plugin, getFullPathMock, app };
  }

  describe("getSelectedReferenceDocxTitle", () => {
    it("returns 'Default (none)' when referenceDocx is empty", async () => {
      const { plugin } = makePlugin({ referenceDocx: "" });
      expect(await plugin.getSelectedReferenceDocxTitle()).toBe("Default (none)");
    });

    it("returns 'Default (none)' when referenceDocx is whitespace", async () => {
      const { plugin } = makePlugin({ referenceDocx: "   " });
      expect(await plugin.getSelectedReferenceDocxTitle()).toBe("Default (none)");
    });

    it("returns the filename when referenceDocx is set", async () => {
      const { plugin } = makePlugin({ referenceDocx: "custom-template.docx" });
      expect(await plugin.getSelectedReferenceDocxTitle()).toBe("custom-template.docx");
    });
  });

  describe("exportActiveNote referenceDocx resolution", () => {
    it("resolves filename to vault-relative path and checks existence", async () => {
      const { plugin, getFullPathMock } = makePlugin({
        referenceDocx: "missing-template.docx",
      });

      // Call private exportActiveNote
      await (plugin as any).exportActiveNote();

      // Check that getFullPath was called with vault-relative path in REFERENCE_DOCX_DIR
      expect(getFullPathMock).toHaveBeenCalledWith(
        `${REFERENCE_DOCX_DIR}/missing-template.docx`
      );

      // Since the file does not exist on disk, export should be blocked
      const blockedNotice = recordedNotices.find((n) =>
        n.includes("Reference DOCX not found")
      );
      expect(blockedNotice).toBeDefined();
      expect(blockedNotice).toContain("missing-template.docx");
      expect(blockedNotice).toContain("export blocked");
    });

    it("does not call getFullPath for referenceDocx when setting is empty", async () => {
      const { plugin, getFullPathMock } = makePlugin({
        referenceDocx: "",
      });

      await (plugin as any).exportActiveNote();

      // getFullPath should have been called for activeFile and CSL, but not REFERENCE_DOCX_DIR
      const refDocxCalls = getFullPathMock.mock.calls.filter((args: [string]) =>
        args[0].includes(REFERENCE_DOCX_DIR)
      );
      expect(refDocxCalls).toHaveLength(0);
    });

    it("passes resolved absolute path and allows preflight when file exists", async () => {
      const templateDir = join(tempDir, REFERENCE_DOCX_DIR);
      mkdirSync(templateDir, { recursive: true });
      const templatePath = join(templateDir, "valid-template.docx");
      writeFileSync(templatePath, "dummy docx content");

      const { plugin, getFullPathMock } = makePlugin({
        referenceDocx: "valid-template.docx",
      });

      await (plugin as any).exportActiveNote();

      expect(getFullPathMock).toHaveBeenCalledWith(
        `${REFERENCE_DOCX_DIR}/valid-template.docx`
      );

      // Export was not blocked by health preflight
      const blockedNotice = recordedNotices.find((n) =>
        n.includes("export blocked")
      );
      expect(blockedNotice).toBeUndefined();
    });
  });
});
