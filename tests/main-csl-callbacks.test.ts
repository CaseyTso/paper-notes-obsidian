import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin from "../src/main";
import * as cslModalModule from "../src/modals/csl-style-modal";
import type {
  CslStyleModalCallbacks,
  CslStyleModalHandle,
} from "../src/modals/csl-style-modal";
import type { CslVaultPort } from "../src/services/csl-style-manager";

interface MockVaultAdapter {
  remove: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getFullPath: ReturnType<typeof vi.fn>;
}

function makePluginWithAdapter(adapter: MockVaultAdapter): PaperNotesPlugin {
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
  return new PaperNotesPlugin(app, manifest);
}

describe("CSL Style Manager callbacks (main.ts)", () => {
  let adapter: MockVaultAdapter;
  let plugin: PaperNotesPlugin;
  let capturedCallbacks: CslStyleModalCallbacks | null;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = {
      remove: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ files: [] }),
      getFullPath: vi.fn((p: string) => `/vault/${p}`),
    };
    plugin = makePluginWithAdapter(adapter);
    plugin.settings.selectedCsl = "nature.csl";
    capturedCallbacks = null;

    vi.spyOn(cslModalModule, "createCslStyleModal").mockImplementation(
      (_app, callbacks, _onClose) => {
        capturedCallbacks = callbacks;
        const handle: CslStyleModalHandle = {
          open: vi.fn(),
          close: vi.fn(),
          contentEl: {} as HTMLElement,
        };
        return handle;
      },
    );
  });

  describe("deleteStyle callback (P1 fix)", () => {
    it("rethrows when adapter.remove fails on the primary style file", async () => {
      adapter.remove.mockRejectedValue(new Error("EACCES: permission denied"));

      plugin.openCslStyleManager();
      expect(capturedCallbacks).not.toBeNull();

      await expect(
        capturedCallbacks!.deleteStyle("american-medical-association.csl"),
      ).rejects.toThrow("EACCES: permission denied");
      expect(adapter.remove).toHaveBeenCalledWith(
        ".paper-notes/csl/american-medical-association.csl",
      );
    });

    it("wraps non-Error throwables into Error with fallback message", async () => {
      adapter.remove.mockRejectedValue("string error");

      plugin.openCslStyleManager();
      expect(capturedCallbacks).not.toBeNull();

      await expect(
        capturedCallbacks!.deleteStyle("american-medical-association.csl"),
      ).rejects.toThrow("Could not delete style.");
    });

    it("prevents deleting the currently selected default style", async () => {
      plugin.openCslStyleManager();
      expect(capturedCallbacks).not.toBeNull();

      await expect(
        capturedCallbacks!.deleteStyle("nature.csl"),
      ).rejects.toThrow("Cannot delete the current default style.");
      expect(adapter.remove).not.toHaveBeenCalled();
    });

    it("succeeds and removes both style and cache file when removal succeeds", async () => {
      plugin.openCslStyleManager();
      expect(capturedCallbacks).not.toBeNull();

      await expect(
        capturedCallbacks!.deleteStyle("american-medical-association.csl"),
      ).resolves.toBeUndefined();
      expect(adapter.remove).toHaveBeenCalledWith(
        ".paper-notes/csl/american-medical-association.csl",
      );
      expect(adapter.remove).toHaveBeenCalledWith(
        ".paper-notes/csl/.cache/american-medical-association.csl.html",
      );
    });

    it("ignores cache-removal failure when primary style removal succeeds", async () => {
      adapter.remove.mockImplementation(async (filePath: string) => {
        if (filePath.includes(".cache")) {
          throw new Error("Cache delete failed");
        }
      });

      plugin.openCslStyleManager();
      expect(capturedCallbacks).not.toBeNull();

      await expect(
        capturedCallbacks!.deleteStyle("american-medical-association.csl"),
      ).resolves.toBeUndefined();
      expect(adapter.remove).toHaveBeenCalledTimes(2);
    });
  });

  describe("createCslVaultPort read-only port (P2.4 fix)", () => {
    it("handles string file paths and extracts basenames", async () => {
      adapter.list.mockResolvedValue({
        files: [
          ".paper-notes/csl/nature.csl",
          ".paper-notes/csl/american-medical-association.csl",
        ],
      });

      const port = (
        plugin as unknown as { createCslVaultPort: () => CslVaultPort }
      ).createCslVaultPort();
      const files = await port.listFiles(".paper-notes/csl");
      expect(files).toEqual([
        "nature.csl",
        "american-medical-association.csl",
      ]);
    });

    it("handles object entries with { name: string }", async () => {
      adapter.list.mockResolvedValue({
        files: [{ name: "nature.csl" }, { name: "vancouver.csl" }],
      });

      const port = (
        plugin as unknown as { createCslVaultPort: () => CslVaultPort }
      ).createCslVaultPort();
      const files = await port.listFiles(".paper-notes/csl");
      expect(files).toEqual(["nature.csl", "vancouver.csl"]);
    });

    it("returns an empty array when adapter.list fails or is missing", async () => {
      adapter.list.mockRejectedValue(new Error("directory missing"));

      const port = (
        plugin as unknown as { createCslVaultPort: () => CslVaultPort }
      ).createCslVaultPort();
      const files = await port.listFiles(".paper-notes/csl");
      expect(files).toEqual([]);
    });

    it("blocks writes from read-only export gate port", async () => {
      const port = (
        plugin as unknown as { createCslVaultPort: () => CslVaultPort }
      ).createCslVaultPort();
      await expect(
        port.writeText(".paper-notes/csl/nature.csl", "content"),
      ).rejects.toThrow("CSL writes are not available from export flows.");
    });
  });
});
