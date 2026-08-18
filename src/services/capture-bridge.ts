/**
 * Capture Bridge (Task 6).
 *
 * Loopback-only HTTP endpoint owned by the Obsidian plugin. It accepts
 * Web Capture POSTs from the Chromium connector, validates every
 * security boundary, and delegates the actual item operation to the
 * paper-notes CLI through an injected handler.
 *
 * Security invariants:
 * - binds `127.0.0.1` only;
 * - exact Host / route / method / content-type / version-header checks;
 * - body cap ≤ 256 KiB and schema/field allowlist;
 * - mutation route never returns `Access-Control-Allow-Origin: *`;
 * - only a `chrome-extension://` Origin is echoed back for CORS;
 * - idempotency cache is bounded and cleared on unload.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CAPTURE_BIND_ADDRESS,
  CAPTURE_PORT,
  CAPTURE_ROUTE,
  CONNECTOR_VERSION,
  CONNECTOR_VERSION_HEADER,
  MAX_CAPTURE_BODY_BYTES,
  isBrowserCaptureResult,
  webCaptureRejectionReason,
  type BrowserCaptureResult,
  type WebCaptureRequest,
} from "../../browser-connector/src/protocol";

export type CaptureBridgeStatus =
  | "stopped"
  | "running"
  | "disabled"
  | "port_conflict"
  | "error";

export interface CaptureBridgeStartResult {
  status: CaptureBridgeStatus;
  port?: number;
  message?: string;
}

export interface CaptureBridgeDependencies {
  /** The action that performs the actual capture (CLI adapter). */
  handler: (request: WebCaptureRequest) => Promise<BrowserCaptureResult>;
  /** Port for tests; production uses 27124. */
  port?: number;
  /** Bind host; production and tests use 127.0.0.1. */
  host?: string;
  /** Body cap; default is the protocol constant (≤256 KiB). */
  bodyLimit?: number;
  /** Optional status callback for plugin UI. */
  onStatusChange?: (status: CaptureBridgeStatus) => void;
  /** Injectable idempotency map (tests can inspect it). */
  idempotency?: Map<string, { fingerprint: string; result: BrowserCaptureResult }>;
}

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  origin?: string,
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin !== undefined) {
    // Never a wildcard on mutation/preflight paths.
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        // Drain the remainder so the client can still receive a 413
        // response instead of a socket reset.
        req.resume();
        resolve({ ok: false, reason: "request body exceeds size cap" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        return;
      }
      resolve({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      resolve({ ok: false, reason: "could not read request body" });
    });
  });
}

function requestFingerprint(request: WebCaptureRequest): string {
  return JSON.stringify(request);
}

export class CaptureBridge {
  private readonly port: number;
  private readonly host: string;
  private readonly bodyLimit: number;
  private readonly handler: (request: WebCaptureRequest) => Promise<BrowserCaptureResult>;
  private readonly onStatusChange?: (status: CaptureBridgeStatus) => void;
  private readonly idempotency: Map<string, { fingerprint: string; result: BrowserCaptureResult }>;
  private server: Server | null = null;
  private actualPort: number | null = null;
  private status: CaptureBridgeStatus = "stopped";

  constructor(deps: CaptureBridgeDependencies) {
    this.port = deps.port ?? CAPTURE_PORT;
    this.host = deps.host ?? CAPTURE_BIND_ADDRESS;
    this.bodyLimit = deps.bodyLimit ?? MAX_CAPTURE_BODY_BYTES;
    this.handler = deps.handler;
    this.onStatusChange = deps.onStatusChange;
    this.idempotency = deps.idempotency ?? new Map();
  }

  getStatus(): CaptureBridgeStatus {
    return this.status;
  }

  getPort(): number {
    return this.actualPort ?? this.port;
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  private setStatus(status: CaptureBridgeStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) {
      return true;
    }
    return origin.startsWith("chrome-extension://");
  }

  private expectedHost(): string {
    return `${this.host}:${this.getPort()}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== this.expectedHost()) {
      jsonResponse(res, 403, { status: "rejected", code: "bad_host", reason: "invalid Host header" });
      return;
    }

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!this.isAllowedOrigin(origin)) {
      jsonResponse(res, 403, { status: "rejected", code: "bad_origin", reason: "origin is not allowed" });
      return;
    }

    const url = req.url ?? "";
    if (url !== CAPTURE_ROUTE) {
      jsonResponse(res, 404, { status: "rejected", code: "not_found", reason: "route not found" });
      return;
    }

    if (req.method === "OPTIONS") {
      if (origin === undefined) {
        jsonResponse(res, 403, { status: "rejected", code: "missing_origin", reason: "preflight requires an Origin" });
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": `Content-Type, ${CONNECTOR_VERSION_HEADER}`,
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      jsonResponse(res, 405, { status: "rejected", code: "method_not_allowed", reason: "method not allowed" });
      return;
    }

    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
      jsonResponse(res, 415, { status: "rejected", code: "bad_content_type", reason: "Content-Type must be application/json" });
      return;
    }

    const versionHeader = req.headers[CONNECTOR_VERSION_HEADER.toLowerCase()];
    if (versionHeader !== CONNECTOR_VERSION) {
      jsonResponse(res, 403, { status: "rejected", code: "missing_version_header", reason: "connector version header is required" });
      return;
    }

    const bodyResult = await readBody(req, this.bodyLimit);
    if (!bodyResult.ok) {
      jsonResponse(res, 413, { status: "rejected", code: "body_too_large", reason: bodyResult.reason });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.body);
    } catch {
      jsonResponse(res, 400, { status: "rejected", code: "bad_json", reason: "request body is not valid JSON" });
      return;
    }

    const rejection = webCaptureRejectionReason(parsed);
    if (rejection !== null) {
      jsonResponse(res, 400, { status: "rejected", code: "bad_request", reason: rejection });
      return;
    }
    const request = parsed as WebCaptureRequest;

    const fingerprint = requestFingerprint(request);
    const cached = this.idempotency.get(request.capture_id);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        jsonResponse(res, 409, { status: "rejected", code: "capture_id_reuse", reason: "capture_id was already used with a different payload" });
        return;
      }
      this.sendResult(res, cached.result, origin);
      return;
    }

    let result: BrowserCaptureResult;
    try {
      result = await this.handler(request);
    } catch {
      jsonResponse(res, 500, { status: "rejected", code: "internal_error", reason: "capture handler failed" });
      return;
    }
    if (!isBrowserCaptureResult(result)) {
      jsonResponse(res, 500, { status: "rejected", code: "bad_result", reason: "capture handler returned an invalid result" });
      return;
    }

    if (this.idempotency.size >= 1000) {
      const oldestKey = this.idempotency.keys().next().value;
      if (oldestKey !== undefined) {
        this.idempotency.delete(oldestKey);
      }
    }
    this.idempotency.set(request.capture_id, { fingerprint, result });

    this.sendResult(res, result, origin);
  }

  private sendResult(res: ServerResponse, result: BrowserCaptureResult, origin?: string): void {
    switch (result.status) {
      case "created":
      case "existing":
      case "needs_review":
        jsonResponse(res, 200, result, origin);
        return;
      case "rejected":
        jsonResponse(res, 400, result, origin);
        return;
      case "unavailable":
        jsonResponse(res, 503, result, origin);
        return;
    }
  }

  start(): Promise<CaptureBridgeStartResult> {
    if (this.server !== null) {
      return Promise.resolve({ status: this.getStatus(), port: this.port });
    }

    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        jsonResponse(res, 500, { status: "rejected", code: "internal_error", reason: "capture bridge error" });
      });
    });
    this.server = server;

    return new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        this.server = null;
        if (error.code === "EADDRINUSE") {
          this.setStatus("port_conflict");
          resolve({ status: "port_conflict", port: this.port, message: "port is already in use" });
          return;
        }
        this.setStatus("error");
        resolve({ status: "error", port: this.port, message: error.message });
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const address = server.address() as AddressInfo | null;
        this.actualPort = address?.port ?? this.port;
        this.setStatus("running");
        resolve({ status: "running", port: this.getPort() });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    this.idempotency.clear();
    this.setStatus("stopped");
    if (server === null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}
