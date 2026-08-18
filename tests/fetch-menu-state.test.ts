/**
 * Fetch PDF menu-state decision tests.
 */

import { describe, expect, it } from "vitest";
import { fetchMenuItemState, type FetchMenuFlags } from "../src/services/fetch-menu-state";

const READY: FetchMenuFlags = {
  invalid: false,
  readOnly: false,
  fetchAvailable: true,
  hasPdf: false,
  hasIdentifier: true,
};

describe("fetchMenuItemState", () => {
  it("enables when every prerequisite is satisfied", () => {
    const state = fetchMenuItemState(READY);
    expect(state.enabled).toBe(true);
    expect(state.reason).toBeUndefined();
  });

  it("disables for invalid metadata first", () => {
    const state = fetchMenuItemState({ ...READY, invalid: true });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("invalid metadata");
  });

  it("disables for read-only (paper-notes CLI) second", () => {
    const state = fetchMenuItemState({ ...READY, readOnly: true });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("CLI unavailable");
  });

  it("disables when paper-fetch CLI is unavailable", () => {
    const state = fetchMenuItemState({ ...READY, fetchAvailable: false });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("paper-fetch CLI unavailable");
  });

  it("disables when a Primary PDF already exists", () => {
    const state = fetchMenuItemState({ ...READY, hasPdf: true });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("primary PDF present");
  });

  it("disables when no DOI/PMID/PMCID identifier exists", () => {
    const state = fetchMenuItemState({ ...READY, hasIdentifier: false });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("no DOI/PMID/PMCID");
  });

  it("priority: invalid beats missing identifier", () => {
    const state = fetchMenuItemState({
      ...READY,
      invalid: true,
      hasIdentifier: false,
      fetchAvailable: false,
      hasPdf: true,
    });
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("invalid metadata");
  });
});
