/**
 * Test fixture: a real executable stand-in for the paper-notes core CLI.
 *
 * `writeFakeCli()` materializes a temp Node script with a shebang that the
 * `CliClient` can `spawn()` directly. Behavior is injected per test:
 * stdout payload, stderr diagnostics, exit code, delay, and SIGTERM
 * resistance. The default payload echoes the received argv back inside a
 * protocol-v1 envelope, so tests can prove argument-array spawning with
 * Unicode / space-containing paths round-trips verbatim (a shell would
 * mangle them).
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProtocolEnvelope } from "../../src/types/protocol";

export interface FakeCliBehavior {
  /** Exact stdout payload. Defaults to a v1 success envelope echoing argv. */
  stdoutRaw?: string;
  /** Text written to stderr before exiting (may contain secrets). */
  stderr?: string;
  /** Process exit code. Defaults to 0. */
  exitCode?: number;
  /** Sleep this many ms before printing/exiting (for timeout/cancel tests). */
  delayMs?: number;
  /** When true, ignore SIGTERM so only SIGKILL escalation terminates. */
  ignoreSigterm?: boolean;
  /** When true, read all of stdin and echo it in the envelope data. */
  readStdin?: boolean;
}

export function buildEnvelope(
  overrides: Partial<ProtocolEnvelope> = {},
): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status: "success",
    data: {},
    warnings: [],
    errors: [],
    ...overrides,
  };
}

const RUNNER = `
const behavior = __BEHAVIOR__;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
async function main() {
  if (behavior.ignoreSigterm) {
    process.on("SIGTERM", () => {});
  }
  let stdinData = null;
  if (behavior.readStdin) {
    stdinData = await readStdin();
  }
  if (behavior.delayMs > 0) {
    await sleep(behavior.delayMs);
  }
  if (behavior.stderr) {
    process.stderr.write(behavior.stderr);
  }
  if (behavior.stdoutRaw !== undefined) {
    process.stdout.write(behavior.stdoutRaw);
  } else {
    const data = { argv: process.argv.slice(2) };
    if (behavior.readStdin) {
      data.stdin = stdinData;
    }
    process.stdout.write(
      JSON.stringify({
        protocol_version: 1,
        status: "success",
        data,
        warnings: [],
        errors: [],
      }) + "\\n",
    );
  }
  process.exit(behavior.exitCode ?? 0);
}
main().catch(() => process.exit(4));
`;

export function writeFakeCli(
  directory: string,
  behavior: FakeCliBehavior = {},
): string {
  const scriptPath = join(directory, "fake-paper-notes.mjs");
  const content = `#!/usr/bin/env node\n${RUNNER.replace(
    "__BEHAVIOR__",
    JSON.stringify(behavior),
  )}`;
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, content);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
