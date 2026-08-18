import { describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { CaptureBridge } from "../src/services/capture-bridge";
import type { BrowserCaptureResult, WebCaptureRequest } from "../browser-connector/src/protocol";

function validRequest(): WebCaptureRequest {
  return {
    schema_version: 1,
    capture_id: "7b0c7b5d-1d2e-4a6f-9f2e-8e9c0d1a2b3c",
    page_url: "https://example.org/articles/10.1000/abc",
    records: [
      {
        source: "highwire",
        values: {
          item_type: "article-journal",
          title: "A test paper",
          authors: [{ family: "Doe", given: "Jane" }],
          doi: "10.1000/abc",
          year: 2024,
        },
      },
    ],
  };
}

async function startBridge(
  handler: (request: WebCaptureRequest) => Promise<BrowserCaptureResult>,
  overrides: Partial<ConstructorParameters<typeof CaptureBridge>[0]> = {},
): Promise<{ bridge: CaptureBridge; port: number }> {
  const bridge = new CaptureBridge({
    handler,
    port: 0,
    ...overrides,
  });
  const result = await bridge.start();
  expect(result.status).toBe("running");
  expect(result.port).toBeTypeOf("number");
  return { bridge, port: result.port! };
}

async function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paper-Notes-Connector-Version": "1",
    ...headers,
  };
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rawPost(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Paper-Notes-Connector-Version": "1",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("CaptureBridge lifecycle", () => {
  it("starts on loopback and stops cleanly", async () => {
    const handler = vi.fn(async () => ({ status: "unavailable" as const, reason: "no" }));
    const { bridge, port } = await startBridge(handler);
    expect(bridge.getStatus()).toBe("running");
    expect(bridge.getPort()).toBe(port);
    await bridge.stop();
    expect(bridge.getStatus()).toBe("stopped");
  });

  it("reports port_conflict when the port is already bound", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address() as AddressInfo;
    const bridge = new CaptureBridge({
      handler: async () => ({ status: "unavailable" as const, reason: "no" }),
      port: address.port,
    });
    const result = await bridge.start();
    expect(result.status).toBe("port_conflict");
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("does not double-start", async () => {
    const handler = vi.fn(async () => ({ status: "unavailable" as const, reason: "no" }));
    const { bridge } = await startBridge(handler);
    const again = await bridge.start();
    expect(again.status).toBe("running");
    await bridge.stop();
  });
});

describe("CaptureBridge security", () => {
  it("rejects bad Host", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await rawPost(port, "/v1/capture", validRequest(), {
      Host: "evil.example:27124",
    });
    expect(res.statusCode).toBe(403);
    await bridge.stop();
  });

  it("rejects wrong route", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await post(port, "/other", validRequest());
    expect(res.status).toBe(404);
    await bridge.stop();
  });

  it("rejects wrong method", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await fetch(`http://127.0.0.1:${port}/v1/capture`, { method: "GET" });
    expect(res.status).toBe(405);
    await bridge.stop();
  });

  it("rejects non-JSON content type", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await post(port, "/v1/capture", validRequest(), { "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
    await bridge.stop();
  });

  it("rejects missing or wrong connector version header", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const missing = await post(port, "/v1/capture", validRequest(), {
      "X-Paper-Notes-Connector-Version": "",
    });
    expect(missing.status).toBe(403);
    const wrong = await post(port, "/v1/capture", validRequest(), {
      "X-Paper-Notes-Connector-Version": "2",
    });
    expect(wrong.status).toBe(403);
    await bridge.stop();
  });

  it("rejects non-extension origins", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await post(port, "/v1/capture", validRequest(), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    await bridge.stop();
  });

  it("rejects malformed JSON", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const res = await post(port, "/v1/capture", "{not json", {});
    expect(res.status).toBe(400);
    await bridge.stop();
  });

  it("rejects unknown fields", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const body = { ...validRequest(), command: "rm -rf /" };
    const res = await post(port, "/v1/capture", body);
    expect(res.status).toBe(400);
    await bridge.stop();
  });

  it("rejects oversized bodies", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }), {
      bodyLimit: 100,
    });
    const body = JSON.stringify(validRequest()) + "x".repeat(200);
    const res = await post(port, "/v1/capture", body);
    expect(res.status).toBe(413);
    await bridge.stop();
  });
});

describe("CaptureBridge results and idempotency", () => {
  it("returns created result and caches by capture_id", async () => {
    const handler = vi.fn(async () => ({
      status: "created" as const,
      citationKey: "doe2024",
      title: "A test paper",
      path: "05 Literature/doe2024/doe2024.md",
    }));
    const { bridge, port } = await startBridge(handler);
    const res = await post(port, "/v1/capture", validRequest());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BrowserCaptureResult;
    expect(payload.status).toBe("created");
    expect(handler).toHaveBeenCalledTimes(1);

    const second = await post(port, "/v1/capture", validRequest());
    expect(second.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await bridge.stop();
  });

  it("rejects capture_id reuse with a different payload", async () => {
    const handler = vi.fn(async () => ({ status: "unavailable" as const, reason: "no" }));
    const { bridge, port } = await startBridge(handler);
    await post(port, "/v1/capture", validRequest());
    const changed = validRequest();
    changed.records[0].values.title = "Changed";
    const res = await post(port, "/v1/capture", changed);
    expect(res.status).toBe(409);
    await bridge.stop();
  });

  it("maps rejected and unavailable results to HTTP status codes", async () => {
    const rejected = await startBridge(async () => ({ status: "rejected" as const, code: "bad", reason: "no" }));
    const resRejected = await post(rejected.port, "/v1/capture", validRequest());
    expect(resRejected.status).toBe(400);
    await rejected.bridge.stop();

    const unavailable = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const resUnavailable = await post(unavailable.port, "/v1/capture", validRequest());
    expect(resUnavailable.status).toBe(503);
    await unavailable.bridge.stop();
  });

  it("returns a safe error when the handler throws", async () => {
    const { bridge, port } = await startBridge(async () => {
      throw new Error("secret path /Users/me");
    });
    const res = await post(port, "/v1/capture", validRequest());
    expect(res.status).toBe(500);
    const payload = (await res.json()) as BrowserCaptureResult;
    expect(payload.status).toBe("rejected");
    expect(JSON.stringify(payload)).not.toContain("/Users/me");
    await bridge.stop();
  });

  it("clears idempotency on stop", async () => {
    const idempotency = new Map<string, { fingerprint: string; result: BrowserCaptureResult }>();
    const handler = vi.fn(async () => ({ status: "unavailable" as const, reason: "no" }));
    const { bridge, port } = await startBridge(handler, { idempotency });
    await post(port, "/v1/capture", validRequest());
    expect(idempotency.size).toBe(1);
    await bridge.stop();
    expect(idempotency.size).toBe(0);
  });

  it("preflight only echoes a chrome-extension origin", async () => {
    const { bridge, port } = await startBridge(async () => ({ status: "unavailable" as const, reason: "no" }));
    const origin = "chrome-extension://abcdefghijklmnop";
    const res = await fetch(`http://127.0.0.1:${port}/v1/capture`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    await bridge.stop();
  });
});
