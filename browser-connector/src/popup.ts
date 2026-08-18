/**
 * Popup entry (MV3 action popup).
 *
 * On click: inject the one-shot extractor into the active tab, generate a
 * fresh capture id, submit the Web Capture to the loopback Capture Bridge,
 * and render exactly one closed result state. Never uses `innerHTML` with
 * captured data; all dynamic text goes through `textContent`.
 */

import {
  CAPTURE_URL,
  CONNECTOR_VERSION,
  CONNECTOR_VERSION_HEADER,
  isBrowserCaptureResult,
  type BrowserCaptureResult,
} from "./protocol";
import type { ExtractionResult } from "./extract";

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const captureButton = document.querySelector<HTMLButtonElement>("#capture");
const resultEl = document.querySelector<HTMLDivElement>("#result");

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function clearResult(): void {
  if (resultEl) {
    resultEl.replaceChildren();
    resultEl.hidden = true;
  }
}

function generateCaptureId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readExtractor(captureId: string): ExtractionResult {
  const extractor = (globalThis as { __paperNotesExtract?: unknown }).__paperNotesExtract;
  if (typeof extractor !== "function") {
    return { request: null, reason: "Paper Notes extractor was not loaded." };
  }
  return (extractor as (doc: Document, url: string, id: string) => ExtractionResult)(
    document,
    location.href,
    captureId,
  );
}

function addText(parent: HTMLElement, text: string): HTMLElement {
  const element = document.createElement("p");
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function addButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.appendChild(button);
  return button;
}

function openObsidian(uri: string): void {
  void chrome.tabs.create({ url: uri });
}

function renderResult(result: BrowserCaptureResult): void {
  if (resultEl === null || resultEl === undefined) {
    return;
  }
  clearResult();
  resultEl.hidden = false;
  const container = document.createElement("div");
  container.className = "result";

  switch (result.status) {
    case "created":
      addText(container, `Created: ${result.title}`);
      addText(container, `Citation key: ${result.citationKey}`);
      break;
    case "existing":
      addText(container, `Already in your library: ${result.title}`);
      addText(container, `Citation key: ${result.citationKey}`);
      break;
    case "needs_review":
      addText(container, "This capture needs review in Obsidian.");
      addText(container, result.reason);
      addButton(container, "Review in Obsidian", () => {
        openObsidian(`obsidian://paper-notes-review?id=${encodeURIComponent(result.reviewId)}`);
      });
      break;
    case "rejected":
      addText(container, "Capture rejected:");
      addText(container, result.reason);
      break;
    case "unavailable":
      addText(container, result.reason);
      addButton(container, "Open Obsidian", () => {
        openObsidian("obsidian://open");
      });
      break;
  }
  resultEl.appendChild(container);
}

async function captureCurrentPage(): Promise<void> {
  clearResult();
  setStatus("Extracting…");
  if (captureButton) {
    captureButton.disabled = true;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (
      tab === undefined ||
      tab.id === undefined ||
      typeof tab.url !== "string" ||
      !tab.url.startsWith("https://")
    ) {
      renderResult({
        status: "rejected",
        code: "unsupported_page",
        reason: "Open a single journal article or preprint page (HTTPS) first.",
      });
      return;
    }

    const captureId = generateCaptureId();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extract.js"],
    });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readExtractor,
      args: [captureId],
    });
    const extraction = injected[0]?.result as ExtractionResult | undefined;
    if (extraction?.request === undefined || extraction.request === null) {
      renderResult({
        status: "rejected",
        code: "no_metadata",
        reason: extraction?.reason ?? "No supported bibliographic metadata found on this page.",
      });
      return;
    }

    setStatus("Saving to Obsidian…");
    let response: Response;
    try {
      response = await fetch(CAPTURE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CONNECTOR_VERSION_HEADER]: CONNECTOR_VERSION,
        },
        body: JSON.stringify(extraction.request),
      });
    } catch {
      renderResult({
        status: "unavailable",
        reason: "Obsidian is not running, or the Local Network Access permission is still needed.",
      });
      return;
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      result = {
        status: "rejected",
        code: "bad_response",
        reason: "The Capture Bridge returned an invalid response.",
      };
    }
    const finalResult: BrowserCaptureResult = isBrowserCaptureResult(result)
      ? result
      : {
          status: "rejected",
          code: "bad_response",
          reason: "The Capture Bridge returned an invalid response.",
        };
    renderResult(finalResult);
  } catch {
    renderResult({
      status: "rejected",
      code: "extraction_failed",
      reason: "Could not extract metadata from this page.",
    });
  } finally {
    setStatus("Ready");
    if (captureButton) {
      captureButton.disabled = false;
    }
  }
}

captureButton?.addEventListener("click", () => {
  void captureCurrentPage();
});

// Keep the popup accessible.
captureButton?.focus();
