import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin, {
  EXPORT_DOCX_COMMAND,
  OPEN_LIBRARY_COMMAND,
  VIEW_TYPE_PAPER_NOTES,
} from "../src/main";
import {
  registeredCommands,
  registeredViews,
  resetRegistries,
} from "./obsidian.mock";

function makePlugin(): PaperNotesPlugin {
  const app = {
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

describe("paper-notes plugin scaffold", () => {
  beforeEach(() => {
    resetRegistries();
  });

  it("exports a plugin class", () => {
    expect(typeof PaperNotesPlugin).toBe("function");
  });

  it("declares isDesktopOnly = true", () => {
    expect(makePlugin().isDesktopOnly).toBe(true);
  });

  it("registers the paper-notes-open-library view type and command", async () => {
    expect(VIEW_TYPE_PAPER_NOTES).toBe("paper-notes-open-library");
    expect(OPEN_LIBRARY_COMMAND).toBe("paper-notes-open-library");

    const plugin = makePlugin();
    await plugin.onload();

    expect(registeredViews).toContain(VIEW_TYPE_PAPER_NOTES);
    expect(registeredViews).toContain("paper-notes-topic-moc");
    expect(registeredCommands).toContain("paper-notes-open-topic-moc");
    expect(registeredCommands).toContain(OPEN_LIBRARY_COMMAND);
  });

  it("registers DOCX export command but does not register PDF export command", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(registeredCommands).toContain(EXPORT_DOCX_COMMAND);
    expect(registeredCommands).toContain("paper-notes-export-docx");
    expect(registeredCommands).not.toContain("paper-notes-export-pdf");
    expect("EXPORT_PDF_COMMAND" in (await import("../src/main"))).toBe(false);
  });
});
