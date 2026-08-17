/**
 * MinerU menu-state decision tests (Task: MinerU).
 */

import { describe, expect, it } from "vitest";
import { mineruMenuItemState, type MineruMenuFlags } from "../src/services/mineru-menu-state";
import {
  mineruConvertArgs,
  mineruDeleteKeyArgs,
  mineruKeyStatusArgs,
  mineruPreviewArgs,
  mineruPreviewOf,
  mineruSetKeyArgs,
} from "../src/services/item-actions";

const READY: MineruMenuFlags = {
  invalid: false,
  readOnly: false,
  hasPdf: true,
  keyConfigured: true,
};

describe("mineruMenuItemState", () => {
  it("labels fresh conversion Convert and re-conversion Re-convert", () => {
    expect(mineruMenuItemState(false, READY).label).toBe("Convert with MinerU…");
    expect(mineruMenuItemState(true, READY).label).toBe("Re-convert with MinerU…");
    expect(mineruMenuItemState(true, READY).enabled).toBe(true);
  });

  it("disables for invalid metadata first", () => {
    const state = mineruMenuItemState(false, { ...READY, invalid: true });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("invalid metadata");
  });

  it("disables for read-only CLI second", () => {
    const state = mineruMenuItemState(false, { ...READY, readOnly: true });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("CLI unavailable");
  });

  it("disables when no Primary PDF", () => {
    const state = mineruMenuItemState(false, { ...READY, hasPdf: false });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("no primary PDF");
  });

  it("disables when MinerU key is not configured", () => {
    const state = mineruMenuItemState(false, { ...READY, keyConfigured: false });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("MinerU key not configured");
  });

  it("priority: invalid beats missing pdf", () => {
    const state = mineruMenuItemState(false, {
      ...READY,
      invalid: true,
      hasPdf: false,
      keyConfigured: false,
    });
    expect(state.reason).toContain("invalid metadata");
  });
});

describe("mineru argv helpers", () => {
  it("builds fresh convert args", () => {
    expect(mineruConvertArgs("/v", "keyA")).toEqual([
      "mineru", "convert", "--vault", "/v", "--key", "keyA",
    ]);
  });

  it("adds --confirm-token for re-convert", () => {
    expect(mineruConvertArgs("/v", "keyA", "tok123")).toEqual([
      "mineru", "convert", "--vault", "/v", "--key", "keyA",
      "--confirm-token", "tok123",
    ]);
  });

  it("builds dry-run preview args", () => {
    expect(mineruPreviewArgs("/v", "keyA")).toEqual([
      "mineru", "convert", "--dry-run", "--vault", "/v", "--key", "keyA",
    ]);
  });

  it("key args never carry the key value", () => {
    expect(mineruKeyStatusArgs()).toEqual(["config", "mineru", "status"]);
    expect(mineruSetKeyArgs()).toEqual(["config", "mineru", "set-key", "--stdin"]);
    expect(mineruDeleteKeyArgs()).toEqual(["config", "mineru", "delete-key"]);
  });

  it("parses the preview payload", () => {
    const parsed = mineruPreviewOf({
      confirmation_token: "tok",
      existing_md: true,
      plan: { action: "mineru_convert" },
    });
    expect(parsed?.token).toBe("tok");
    expect(parsed?.existingMd).toBe(true);
    expect(parsed?.plan).toEqual({ action: "mineru_convert" });
  });

  it("rejects a preview payload without a token", () => {
    expect(mineruPreviewOf({ existing_md: false })).toBeUndefined();
  });
});
