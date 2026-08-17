/**
 * Session-bound MinerU queue tests (Task: MinerU).
 *
 * Drives the real `MineruQueue` against the executable fake CLI:
 * FIFO order, single runner (no parallel), key dedupe, remove-waiting,
 * cancel-running, reload discard (`dispose`), failure continues to the
 * next item, and the end-of-drain summary callback.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliClient } from "../src/services/cli-client";
import { MineruQueue, type MineruQueueSnapshot, type MineruQueueSummary } from "../src/services/mineru-queue";
import { buildEnvelope, writeFakeCli } from "./fixtures/fake-paper-notes";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "paper-notes-queue-"));
}

function progressLine(stage: string, extracted: number, total: number): string {
  return JSON.stringify({ type: "progress", stage, extracted_pages: extracted, total_pages: total }) + "\n";
}

describe("MineruQueue", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  function makeQueue(
    behavior: Parameters<typeof writeFakeCli>[1],
    hooks: {
      onUpdate?: (snapshot: MineruQueueSnapshot) => void;
      onSummary?: (summary: MineruQueueSummary) => void;
    } = {},
  ): { queue: MineruQueue; snapshots: MineruQueueSnapshot[]; summaries: MineruQueueSummary[] } {
    const dir = tempDir();
    dirs.push(dir);
    const client = new CliClient(writeFakeCli(dir, behavior));
    const snapshots: MineruQueueSnapshot[] = [];
    const summaries: MineruQueueSummary[] = [];
    const queue = new MineruQueue({
      client,
      vaultRoot: "/vault",
      onUpdate: (snapshot) => {
        snapshots.push(snapshot);
        hooks.onUpdate?.(snapshot);
      },
      onSummary: (summary) => {
        summaries.push(summary);
        hooks.onSummary?.(summary);
      },
    });
    return { queue, snapshots, summaries };
  }

  function doneEnvelope(data: Record<string, unknown> = {}): string {
    return JSON.stringify(buildEnvelope({ data })) + "\n";
  }

  it("runs one item at a time in FIFO order with progress", async () => {
    const { queue, summaries } = makeQueue({
      delayMs: 800,
      stdoutRaw:
        progressLine("processing", 2, 10) +
        doneEnvelope({ action: "converted", citation_key: "a" }),
    });
    const first = queue.enqueue("a", "A");
    expect(first.ok).toBe(true);
    const second = queue.enqueue("b", "B");
    expect(second.ok).toBe(true);
    await waitFor(() => summaries.length === 1, 5000);
    // both items belong to the same FIFO batch and drain in order
    expect(summaries[0].succeeded).toEqual(["a", "b"]);
    expect(summaries[0].failed).toHaveLength(0);
  });

  it("rejects duplicate keys already queued or running", async () => {
    const { queue } = makeQueue({
      stdoutRaw: doneEnvelope({ action: "converted" }),
    });
    queue.enqueue("a", "A");
    expect(queue.enqueue("a", "A").ok).toBe(false);
  });

  it("removes a waiting item without affecting the running one", async () => {
    const { queue, snapshots } = makeQueue({
      stdoutRaw: doneEnvelope({ action: "converted" }),
    });
    queue.enqueue("a", "A");
    queue.enqueue("b", "B");
    const removed = queue.removeQueued("b");
    expect(removed).toBe(true);
    await waitFor(() => snapshots.length > 0);
    const snapshot = queue.getSnapshot();
    expect(snapshot.items.map((item) => item.key)).toContain("a");
    expect(snapshot.items.map((item) => item.key)).not.toContain("b");
    expect(queue.removeQueued("missing")).toBe(false);
  });

  it("assigns Queued #N indexes to waiting items", async () => {
    const { queue, snapshots } = makeQueue({
      delayMs: 2000,
      stdoutRaw: doneEnvelope({ action: "converted" }),
    });
    queue.enqueue("a", "A");
    queue.enqueue("b", "B");
    queue.enqueue("c", "C");
    await waitFor(() => snapshots.some((s) => s.running?.key === "a"));
    const snapshot = queue.getSnapshot();
    expect(snapshot.running?.key).toBe("a");
    const b = snapshot.items.find((item) => item.key === "b");
    const c = snapshot.items.find((item) => item.key === "c");
    expect(b?.state).toBe("queued");
    expect(b?.queueIndex).toBe(1);
    expect(c?.state).toBe("queued");
    expect(c?.queueIndex).toBe(2);
    queue.dispose();
  });

  it("reports failures and continues with the next item", async () => {
    const { queue, summaries } = makeQueue({
      stdoutRaw:
        JSON.stringify(
          buildEnvelope({
            status: "conflict",
            errors: [{ code: "conflict", message: "state changed" }],
          }),
        ) + "\n",
    });
    queue.enqueue("a", "A");
    queue.enqueue("b", "B");
    await waitFor(() => summaries.length >= 1, 6000);
    const failed = summaries[0].failed.map((entry) => entry.key);
    expect(failed).toEqual(["a", "b"]);
    expect(summaries[0].failed[0].reason).toContain("state changed");
  });

  it("exposes progress pages on the running item", async () => {
    let running: MineruQueueSnapshot["running"];
    const { queue } = makeQueue(
      {
        stdoutRaw:
          progressLine("processing", 7, 12) +
          doneEnvelope({ action: "converted" }),
      },
      {
        onUpdate: (snapshot) => {
          if (snapshot.running !== undefined) {
            running = snapshot.running;
          }
        },
      },
    );
    queue.enqueue("a", "A");
    await waitFor(() => running !== undefined && running.totalPages === 12, 3000);
    expect(running?.extractedPages).toBe(7);
  });

  it("dispose cancels the running child and drops the queue", async () => {
    const { queue, snapshots } = makeQueue({
      delayMs: 60000,
      ignoreSigterm: true,
      stdoutRaw: doneEnvelope({ action: "converted" }),
    });
    queue.enqueue("a", "A");
    queue.enqueue("b", "B");
    await waitFor(() => snapshots.some((s) => s.running !== undefined));
    queue.dispose();
    expect(queue.getSnapshot().items).toHaveLength(0);
    // a second enqueue after dispose is rejected
    expect(queue.enqueue("c", "C").ok).toBe(false);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
