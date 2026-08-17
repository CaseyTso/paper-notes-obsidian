/**
 * MinerU key settings flow tests (Task: MinerU).
 *
 * Exercises the plugin methods behind the settings-tab MinerU Key section:
 * status refresh, stdin-delivered save (never argv), delete, and empty/
 * unavailable failures. The key value must never surface in any result.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesPlugin from "../src/main";
import { CliClient } from "../src/services/cli-client";
import { buildEnvelope, writeFakeCli } from "./fixtures/fake-paper-notes";

const KEY = "sk-mineru-test-" + "1234567890abcdef";

function manifest(): PluginManifest {
  return {
    id: "paper-notes",
    name: "Paper Notes",
    version: "1.0.0",
    minAppVersion: "1.4.0",
    description: "test fixture",
    isDesktopOnly: true,
  } as PluginManifest;
}

function makePlugin(cliPath: string): PaperNotesPlugin {
  const app = {
    workspace: {
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      revealLeaf: () => Promise.resolve(),
    },
    vault: { adapter: { getBasePath: () => "/vault" } },
  } as unknown as App;
  const plugin = new PaperNotesPlugin(app, manifest());
  (plugin as unknown as { cliClient: CliClient }).cliClient = new CliClient(cliPath);
  return plugin;
}

describe("MinerU key settings", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  function tempCli(behavior: Parameters<typeof writeFakeCli>[1]): string {
    const dir = mkdtempSync(join(tmpdir(), "paper-notes-key-"));
    dirs.push(dir);
    return writeFakeCli(dir, behavior);
  }

  it("refreshMineruKeyStatus reads the configured boolean", async () => {
    const plugin = makePlugin(
      tempCli({ stdoutRaw: JSON.stringify(buildEnvelope({ data: { configured: true } })) + "\n" }),
    );
    expect(await plugin.refreshMineruKeyStatus()).toBe(true);
    expect(plugin.mineruKeyConfiguredStatus()).toBe(true);
  });

  it("setMineruKey delivers the value on stdin and never echoes it", async () => {
    const plugin = makePlugin(tempCli({ readStdin: true }));
    const result = await plugin.setMineruKey(KEY);
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain(KEY);
    expect(plugin.mineruKeyConfiguredStatus()).toBe(true);
  });

  it("rejects an empty key", async () => {
    const plugin = makePlugin(tempCli({}));
    const result = await plugin.setMineruKey("   ");
    expect(result.ok).toBe(false);
  });

  it("deleteMineruKey clears the configured status", async () => {
    const plugin = makePlugin(
      tempCli({ stdoutRaw: JSON.stringify(buildEnvelope({ data: { configured: false } })) + "\n" }),
    );
    (plugin as unknown as { mineruKeyConfigured: boolean }).mineruKeyConfigured = true;
    const result = await plugin.deleteMineruKey();
    expect(result.ok).toBe(true);
    expect(plugin.mineruKeyConfiguredStatus()).toBe(false);
  });

  it("reports CLI unavailability without leaking", async () => {
    const plugin = new PaperNotesPlugin(
      { workspace: {} } as unknown as App,
      manifest(),
    );
    (plugin as unknown as { cliClient: CliClient }).cliClient = new CliClient(
      join(mkdtempSync(join(tmpdir(), "paper-notes-none-")), "missing-cli"),
    );
    const result = await plugin.setMineruKey(KEY);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(KEY);
  });
});
