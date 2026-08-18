/**
 * CLI bridge to the sibling paper-fetch tool (Fetch PDF).
 *
 * Uses the same child-process safety rules as the paper-notes `CliClient`:
 * `spawn()` with an argument array, no shell, detached process group,
 * SIGTERM→SIGKILL escalation, `AbortSignal` cancellation, and stderr
 * sanitization. Unlike `CliClient` there is no protocol envelope: paper-fetch
 * emits one plain JSON object on stdout for both `fetch --json` and
 * `doctor --json`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { sanitizeDiagnostics } from "./cli-client";
import type {
  AbleSciStatusResult,
  DoctorCheckJson,
  DoctorReportJson,
  FetchResultJson,
} from "../types/fetch";

export type FetchClientErrorCode =
  | "not_found"
  | "permission"
  | "cli_error"
  | "timeout"
  | "aborted"
  | "bad_json";

export interface FetchClientErrorOptions {
  code: FetchClientErrorCode;
  message: string;
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  cause?: unknown;
}

export class FetchClientError extends Error {
  readonly code: FetchClientErrorCode;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(options: FetchClientErrorOptions) {
    super(options.message);
    this.name = "FetchClientError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
    this.stdout = options.stdout ?? "";
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface FetchRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FetchRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const KILL_ESCALATION_MS = 250;
const PROBE_TIMEOUT_MS = 15_000;
const DOCTOR_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 300_000;

/** Minimal shape guard for paper-fetch's fetch result JSON. */
function isFetchResultJson(value: unknown): value is FetchResultJson {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.success === "boolean";
}

/** Minimal shape guard for paper-fetch's doctor JSON. */
function isDoctorReportJson(value: unknown): value is DoctorReportJson {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.checks);
}

export class FetchClient {
  constructor(private readonly cliPath: string) {}

  /**
   * Run one paper-fetch operation. Resolves with stdout/stderr/exit code.
   * Rejects with FetchClientError on transport failures; structured JSON
   * parsing happens in the callers.
   */
  run(args: string[], options: FetchRunOptions = {}): Promise<FetchRunResult> {
    const { signal, timeoutMs } = options;

    return new Promise<FetchRunResult>((resolve, reject) => {
      let settled = false;
      let termination: Promise<void> | undefined;
      let child: ChildProcess | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const stdoutText = (): string => Buffer.concat(stdout).toString("utf8");
      const stderrText = (): string =>
        sanitizeDiagnostics(Buffer.concat(stderr).toString("utf8"));

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const signalGroup = (cliSignal: NodeJS.Signals): void => {
        const pid = child?.pid;
        if (pid === undefined) {
          return;
        }
        try {
          process.kill(-pid, cliSignal);
        } catch {
          try {
            child?.kill(cliSignal);
          } catch {
            // Already gone.
          }
        }
      };

      const terminate = (): Promise<void> => {
        if (termination !== undefined) {
          return termination;
        }
        termination = new Promise<void>((terminated) => {
          const proc = child;
          if (proc === undefined) {
            terminated();
            return;
          }
          const killer = setTimeout(() => {
            signalGroup("SIGKILL");
            clearTimeout(killer);
          }, KILL_ESCALATION_MS);
          const finished = (): void => {
            terminated();
          };
          if (proc.exitCode !== null || proc.signalCode !== null) {
            finished();
            return;
          }
          proc.once("exit", finished);
          proc.once("close", finished);
          try {
            signalGroup("SIGTERM");
          } catch {
            finished();
          }
        });
        return termination;
      };

      const fail = (options: FetchClientErrorOptions): void => {
        settle(() => reject(new FetchClientError(options)));
      };

      const onAbort = (): void => {
        void terminate().then(() => {
          fail({
            code: "aborted",
            message: "paper-fetch run was cancelled",
            stderr: stderrText(),
          });
        });
      };

      const onTimeout = (): void => {
        void terminate().then(() => {
          fail({
            code: "timeout",
            message: `paper-fetch run exceeded ${timeoutMs}ms and was terminated`,
            stderr: stderrText(),
          });
        });
      };

      if (signal?.aborted) {
        reject(new FetchClientError({ code: "aborted", message: "paper-fetch run was cancelled" }));
        return;
      }
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        reject(new FetchClientError({ code: "timeout", message: "paper-fetch run timed out" }));
        return;
      }

      const proc = spawn(this.cliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child = proc;

      if (timeoutMs !== undefined) {
        timer = setTimeout(onTimeout, timeoutMs);
      }
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      proc.on("error", (error: NodeJS.ErrnoException) => {
        const code: FetchClientErrorCode =
          error.code === "ENOENT"
            ? "not_found"
            : error.code === "EACCES"
              ? "permission"
              : "cli_error";
        fail({
          code,
          message: `cannot start paper-fetch at "${this.cliPath}": ${error.message}`,
          cause: error,
        });
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });

      proc.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        if (termination !== undefined) {
          // The tracked process died as part of a timeout/cancel; the
          // termination flow owns the outcome.
          return;
        }
        settled = true;
        cleanup();
        resolve({
          stdout: stdoutText(),
          stderr: stderrText(),
          exitCode: exitCode ?? 0,
        });
      });
    });
  }

  /** True when the CLI can be launched at all (non-mutating --help). */
  async probe(): Promise<boolean> {
    try {
      await this.run(["--help"], { timeoutMs: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch one paper PDF using a deterministic identifier (DOI / PMID /
   * PMCID). Always passes --no-zotero so the vault plugin never touches
   * Zotero; --output points at a plugin-owned temporary directory.
   */
  async fetchPdf(
    identifier: string,
    options: {
      outputDir: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<FetchResultJson> {
    const result = await this.run(
      [
        "fetch",
        identifier,
        "--json",
        "--no-zotero",
        "--output",
        options.outputDir,
      ],
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = undefined;
    }
    if (!isFetchResultJson(parsed)) {
      throw new FetchClientError({
        code: "bad_json",
        message: "paper-fetch produced malformed JSON on stdout",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
    return parsed;
  }

  /**
   * Run read-only `paper-fetch doctor --json` and return only the ableSci
   * (科研通) check row. Never prints or returns cookie values.
   */
  async ableSciStatus(): Promise<AbleSciStatusResult> {
    let result: FetchRunResult;
    try {
      result = await this.run(["doctor", "--json"], {
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });
    } catch (error) {
      const code = error instanceof FetchClientError ? error.code : "cli_error";
      return {
        status: "unavailable",
        rowStatus: code,
        detail: "paper-fetch doctor 无法运行，无法检查科研通登录状态。",
        action: "检查 paper-fetch CLI 路径与安装（Settings → Fetch PDF）。",
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = undefined;
    }
    if (!isDoctorReportJson(parsed)) {
      return {
        status: "unavailable",
        rowStatus: "bad_json",
        detail: "paper-fetch doctor 返回了无法解析的报告。",
        action: "运行 `paper-fetch doctor --json` 查看详情。",
      };
    }
    const row = parsed.checks.find(
      (check): check is DoctorCheckJson => check?.name === "ablesci",
    );
    if (row === undefined) {
      return {
        status: "unavailable",
        rowStatus: "missing_row",
        detail: "paper-fetch doctor 报告缺少 ablesci 检查项。",
        action: "运行 `paper-fetch doctor --json` 查看详情。",
      };
    }
    return {
      status: row.status === "ok" ? "ready" : "not_ready",
      rowStatus: row.status,
      detail: row.detail,
      action: row.action,
    };
  }
}