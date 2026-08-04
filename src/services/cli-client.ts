/**
 * CLI bridge to the paper-notes core (Task 22).
 *
 * Every invocation uses `child_process.spawn()` with an argument array and
 * `--json` (the core CLI requires the flag before the subcommand). The
 * client never concatenates command strings and never enables a shell.
 *
 * Contract (mirrors `paper_notes/protocol.py`, protocol v1):
 * - Exactly one JSON envelope on stdout.
 * - Human diagnostics on stderr.
 * - Envelope `protocol_version` must equal 1; anything else is treated as
 *   an incompatible CLI and forces read-only mode.
 * - Timeouts and `AbortSignal` cancellation terminate the child (SIGTERM,
 *   escalating to SIGKILL) and reject with a structured `CliError`.
 * - stderr is surfaced sanitized: secret-like tokens are redacted so
 *   diagnostics can never leak credentials into the UI or logs.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  PROTOCOL_VERSION,
  isProtocolEnvelope,
  type ProtocolEnvelope,
} from "../types/protocol";

export type CliErrorCode =
  | "not_found"
  | "permission"
  | "cli_error"
  | "timeout"
  | "aborted"
  | "bad_json"
  | "protocol_mismatch";

export interface CliErrorOptions {
  code: CliErrorCode;
  message: string;
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  observedVersion?: number | null;
  cause?: unknown;
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly observedVersion: number | null;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = "CliError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
    this.stdout = options.stdout ?? "";
    this.observedVersion = options.observedVersion ?? null;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface CliRunResult {
  envelope: ProtocolEnvelope;
  exitCode: number;
  /** Sanitized stderr diagnostics. */
  stderr: string;
}

export interface CliProbeResult {
  /** True when the CLI speaks exactly protocol v1. */
  compatible: boolean;
  /** Protocol version observed from the CLI, when known. */
  protocolVersion: number | null;
  /** True when the CLI is missing, broken, or protocol-incompatible. */
  readOnlyMode: boolean;
  /** Package version reported by the CLI, when available. */
  cliVersion?: string;
  /** Failure code when the probe did not succeed. */
  error?: CliErrorCode;
}

export interface RunCliOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const KILL_ESCALATION_MS = 250;

/** Redact secret-like tokens from CLI diagnostics before surfacing them. */
export function sanitizeDiagnostics(text: string): string {
  return text
    .replace(/\bsk-[^\s]{6,}/g, "sk-***")
    .replace(
      /\b(api[_-]?key|secret|token|password)(\s*[:=]\s*)[^\s]{4,}/gi,
      "$1$2***",
    );
}

export class CliClient {
  constructor(private readonly cliPath: string) {}

  /**
   * Run one CLI operation and resolve with the parsed protocol envelope.
   * Rejects with `CliError` for transport failures (missing binary,
   * timeout, abort, malformed stdout) and for protocol-version mismatch.
   */
  run(args: string[], options: RunCliOptions = {}): Promise<CliRunResult> {
    const { signal, timeoutMs } = options;

    return new Promise<CliRunResult>((resolve, reject) => {
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

      /**
       * Signal the whole process group (the child is spawned `detached`
       * so it leads its own group). A shebang CLI can be launched through
       * an interpreter wrapper (observed on macOS when the script lives on
       * certain mounts): killing only the tracked PID would leave the real
       * CLI orphaned and running.
       */
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

      /**
       * Terminate the child once. SIGTERM first; a delayed SIGKILL on the
       * group catches processes that ignore SIGTERM or outlive the tracked
       * PID (interpreter-wrapper case). The escalation timer is never
       * cancelled early so the group is always reaped.
       */
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

      const fail = (options_: CliErrorOptions): void => {
        settle(() => reject(new CliError(options_)));
      };

      const onAbort = (): void => {
        void terminate().then(() => {
          fail({
            code: "aborted",
            message: "CLI run was cancelled",
            stderr: stderrText(),
          });
        });
      };

      const onTimeout = (): void => {
        void terminate().then(() => {
          fail({
            code: "timeout",
            message: `CLI run exceeded ${timeoutMs}ms and was terminated`,
            stderr: stderrText(),
          });
        });
      };

      if (signal?.aborted) {
        reject(
          new CliError({ code: "aborted", message: "CLI run was cancelled" }),
        );
        return;
      }
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        reject(
          new CliError({ code: "timeout", message: "CLI run timed out" }),
        );
        return;
      }

      const proc = spawn(this.cliPath, ["--json", ...args], {
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
        const code: CliErrorCode =
          error.code === "ENOENT"
            ? "not_found"
            : error.code === "EACCES"
              ? "permission"
              : "cli_error";
        fail({
          code,
          message: `cannot start CLI at "${this.cliPath}": ${error.message}`,
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
          // termination flow owns the outcome (stdout may be empty because
          // an interpreter wrapper died before the real CLI was reaped).
          return;
        }
        settled = true;
        cleanup();

        const raw = stdoutText();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.trim());
        } catch {
          parsed = undefined;
        }

        if (!isProtocolEnvelope(parsed)) {
          reject(
            new CliError({
              code: "bad_json",
              message:
                "CLI produced malformed output; expected exactly one JSON envelope on stdout",
              exitCode,
              stderr: stderrText(),
              stdout: sanitizeDiagnostics(raw),
            }),
          );
          return;
        }

        if (parsed.protocol_version !== PROTOCOL_VERSION) {
          reject(
            new CliError({
              code: "protocol_mismatch",
              message: `unsupported protocol version ${parsed.protocol_version} (expected ${PROTOCOL_VERSION}); plugin is read-only`,
              exitCode,
              stderr: stderrText(),
              observedVersion: parsed.protocol_version,
            }),
          );
          return;
        }

        resolve({
          envelope: parsed,
          exitCode: exitCode ?? 0,
          stderr: stderrText(),
        });
      });
    });
  }

  /**
   * Discover and validate the CLI: run `--json version` and report whether
   * the plugin may trust it. Never throws; a missing, broken, or
   * protocol-mismatched CLI reports read-only mode.
   */
  async probe(): Promise<CliProbeResult> {
    try {
      const { envelope } = await this.run(["version"]);
      return {
        compatible: true,
        protocolVersion: envelope.protocol_version,
        readOnlyMode: false,
        cliVersion:
          typeof envelope.data.version === "string"
            ? envelope.data.version
            : undefined,
      };
    } catch (error) {
      const code = error instanceof CliError ? error.code : "cli_error";
      const observed =
        error instanceof CliError ? error.observedVersion : null;
      return {
        compatible: false,
        protocolVersion: observed,
        readOnlyMode: true,
        error: code,
      };
    }
  }
}
