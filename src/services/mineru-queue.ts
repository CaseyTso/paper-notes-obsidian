/**
 * Session-bound MinerU conversion queue (Task: MinerU).
 *
 * FIFO, one paper running at a time, no parallel uploads. Items are
 * added from the Library menu (fresh or confirmed re-convert), removed
 * while waiting, or cancelled while running. Quitting/reloading Obsidian
 * calls `dispose()`: the current CLI child is terminated (SIGTERM →
 * SIGKILL escalation via the client), the pending queue is discarded,
 * and already-published results are untouched.
 *
 * Progress comes from the CLI's NDJSON stream (`mineru convert`):
 * `stage`, `extracted_pages` / `total_pages`. On a drain the configured
 * `onSummary` callback receives the succeeded/failed keys (cancelled
 * items are excluded).
 */

import { CliClient, CliError } from "./cli-client";

export type MineruQueueItemState = "queued" | "running";

export interface MineruQueueItem {
  /** Citation key (unique among queued/running). */
  key: string;
  /** Display label (citation key or title). */
  title: string;
  /** Confirmation token for a re-convert (absent for fresh converts). */
  confirmToken?: string;
  state: MineruQueueItemState;
  /** 1-based position among queued items (Queued #N). */
  queueIndex: number;
  /** Latest CLI progress stage (`uploading|waiting|processing|...`). */
  stage?: string;
  extractedPages?: number;
  totalPages?: number;
}

export interface MineruQueueSnapshot {
  /** Active items: queued (in FIFO order) then the single running item. */
  items: MineruQueueItem[];
  running: MineruQueueItem | undefined;
}

export interface MineruQueueSummary {
  succeeded: string[];
  failed: Array<{ key: string; reason: string }>;
}

export interface MineruQueueConfig {
  client: CliClient;
  /** Absolute vault root passed to every `mineru convert --vault`. */
  vaultRoot: string;
  onUpdate?: (snapshot: MineruQueueSnapshot) => void;
  onSummary?: (summary: MineruQueueSummary) => void;
}

type RunOutcome = { status: "done" } | { status: "failed"; reason: string };

export class MineruQueue {
  private items: MineruQueueItem[] = [];
  private completed: MineruQueueSummary = { succeeded: [], failed: [] };
  private runningController: AbortController | undefined;
  private active = false;
  private disposed = false;
  private batchStarted = false;

  constructor(private readonly config: MineruQueueConfig) {}

  getSnapshot(): MineruQueueSnapshot {
    const running = this.items.find((item) => item.state === "running");
    const queued = this.items
      .filter((item) => item.state === "queued")
      .sort((a, b) => a.queueIndex - b.queueIndex);
    queued.forEach((item, index) => {
      item.queueIndex = index + 1;
    });
    return {
      items: [...queued, ...(running !== undefined ? [running] : [])],
      running,
    };
  }

  /**
   * Add one conversion. Duplicate keys (queued or running) are rejected;
   * the caller surfaces the returned reason in a Notice.
   */
  enqueue(
    key: string,
    title: string,
    confirmToken?: string,
  ): { ok: boolean; reason?: string } {
    if (this.disposed) {
      return { ok: false, reason: "plugin is reloading; queue unavailable" };
    }
    if (this.items.some((item) => item.key === key)) {
      return { ok: false, reason: `${key} is already queued or running` };
    }
    if (!this.batchStarted) {
      this.batchStarted = true;
      this.completed = { succeeded: [], failed: [] };
    }
    this.items.push({
      key,
      title,
      confirmToken,
      state: "queued",
      queueIndex: this.items.length + 1,
    });
    this.emit();
    void this.tick();
    return { ok: true };
  }

  /** Remove a waiting item. Returns false when not removable. */
  removeQueued(key: string): boolean {
    const index = this.items.findIndex(
      (item) => item.state === "queued" && item.key === key,
    );
    if (index === -1) {
      return false;
    }
    this.items.splice(index, 1);
    this.emit();
    return true;
  }

  /** Cancel the running item (aborts the CLI child). */
  cancelRunning(): void {
    this.runningController?.abort();
  }

  /** Reload/unload: cancel the child and drop the whole pending queue. */
  dispose(): void {
    this.disposed = true;
    this.cancelRunning();
    this.items = [];
    this.batchStarted = false;
    this.completed = { succeeded: [], failed: [] };
    this.emit();
  }

  private async tick(): Promise<void> {
    if (this.active || this.disposed) {
      return;
    }
    const next = this.items.find((item) => item.state === "queued");
    if (next === undefined) {
      this.finishBatchIfDrained();
      return;
    }
    this.active = true;
    next.state = "running";
    next.queueIndex = 0;
    this.emit();

    const controller = new AbortController();
    this.runningController = controller;
    try {
      const outcome = await this.runOne(next, controller.signal);
      if (outcome.status === "done") {
        this.completed.succeeded.push(next.key);
      } else {
        this.completed.failed.push({ key: next.key, reason: outcome.reason });
      }
    } catch (error) {
      // A cancelled run (aborted child) is simply dropped: not counted in
      // the drain summary and removed from the active list below.
      if (!(error instanceof CliError && error.code === "aborted")) {
        const reason =
          error instanceof Error ? error.message : "conversion failed";
        this.completed.failed.push({ key: next.key, reason });
      }
    } finally {
      this.items = this.items.filter((item) => item !== next);
      this.active = false;
      this.runningController = undefined;
      this.emit();
      void this.tick();
    }
  }

  private async runOne(
    item: MineruQueueItem,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const args = [
      "mineru",
      "convert",
      "--vault",
      this.config.vaultRoot,
      "--key",
      item.key,
    ];
    if (item.confirmToken !== undefined) {
      args.push("--confirm-token", item.confirmToken);
    }
    let envelope;
    try {
      const result = await this.config.client.runStream(args, {
        signal,
        onProgress: (event) => {
          item.stage =
            typeof event.stage === "string" ? event.stage : undefined;
          item.extractedPages =
            typeof event.extracted_pages === "number"
              ? event.extracted_pages
              : undefined;
          item.totalPages =
            typeof event.total_pages === "number"
              ? event.total_pages
              : undefined;
          this.emit();
        },
      });
      envelope = result.envelope;
    } catch (error) {
      if (error instanceof CliError && error.code === "aborted") {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "conversion failed";
      return { status: "failed", reason };
    }
    if (envelope.status === "success") {
      return { status: "done" };
    }
    const reason =
      envelope.errors[0]?.message ??
      (envelope.status === "conflict"
        ? "state changed; re-run the conversion"
        : "conversion failed");
    return { status: "failed", reason };
  }

  private finishBatchIfDrained(): void {
    if (!this.batchStarted || this.items.length > 0) {
      return;
    }
    this.batchStarted = false;
    const summary: MineruQueueSummary = this.completed;
    this.completed = { succeeded: [], failed: [] };
    this.config.onSummary?.(summary);
  }

  private emit(): void {
    this.config.onUpdate?.(this.getSnapshot());
  }
}
