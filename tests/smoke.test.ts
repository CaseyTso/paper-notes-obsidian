import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin, {
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
    expect(registeredCommands).toContain(OPEN_LIBRARY_COMMAND);
  });
});
