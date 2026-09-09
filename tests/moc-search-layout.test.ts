import { describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = fs.existsSync(CHROME_PATH);

interface LayoutCaseResult {
  isRtl: boolean;
  paddingInlineStart: string;
  paddingInlineEnd: string;
  gapIconText: number;
  gapTextClear: number;
  clearWidth: number;
  clearHeight: number;
  clearPadding: string;
}

describe("MOC search input layout geometry under simulated Obsidian styles", () => {
  it.runIf(hasChrome)(
    "proves search text does not intersect search icon or clear button under Obsidian input[type=search] defaults (LTR and RTL)",
    async () => {
      const cssContent = fs.readFileSync("src/styles.css", "utf-8");
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "moc-search-layout-"));
      const userDataDir = path.join(testDir, "chrome-profile");

      let server: http.Server | undefined;
      let child: ReturnType<typeof spawn> | undefined;

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --background-primary: #ffffff;
  --background-secondary: #f7f7f7;
  --background-modifier-border: #e0e0e0;
  --background-modifier-form-field: #ffffff;
  --text-normal: #222222;
  --text-muted: #888888;
  --interactive-accent: #0969da;
  --radius-m: 6px;
  --radius-s: 4px;
  --input-padding: 4px 8px;
  --input-border-width: 1px;
  --font-ui-small: 12px;
  --font-ui-smaller: 11px;
  --pn-pad-lg: 12px;
  --pn-pad-md: 8px;
  --pn-transition: 150ms ease;
}

.theme-dark {
  --background-primary: #1e1e1e;
  --background-secondary: #262626;
  --background-modifier-border: #383838;
  --background-modifier-form-field: #141414;
  --text-normal: #dcddde;
  --text-muted: #8e8e8e;
  --interactive-accent: #7b68ee;
}

/* Simulated Obsidian base + higher-specificity theme defaults */
textarea,
.multi-select-container,
input[type='date'],
input[type='text'],
input[type='search'] {
  padding: var(--input-padding);
  font-size: 13px;
  line-height: 1.4;
  box-sizing: border-box;
}

.workspace-leaf input[type='search'],
.view-content input[type='search'] {
  padding: var(--input-padding);
}

.workspace-leaf button,
.view-content button {
  padding: 4px 14px;
  height: 32px;
  min-height: 32px;
}

${cssContent}
</style>
</head>
<body class="workspace-leaf">

<!-- Case 1: 240px light empty -->
<div id="tc1" class="view-content paper-notes-library" style="width: 240px; padding: 10px;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="搜索主题或表格内容…">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear is-hidden" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<!-- Case 2: 240px light input -->
<div id="tc2" class="view-content paper-notes-library" style="width: 240px; padding: 10px;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="搜索主题或表格内容…" value="单细胞NMF分析">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<!-- Case 3: 240px dark input -->
<div id="tc3" class="view-content paper-notes-library theme-dark" style="width: 240px; padding: 10px; background: #1e1e1e;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="搜索主题或表格内容…" value="单细胞NMF分析">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<!-- Case 4: 320px light input -->
<div id="tc4" class="view-content paper-notes-library" style="width: 320px; padding: 10px;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="搜索主题或表格内容…" value="单细胞NMF分析">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<!-- Case 5: 320px dark empty -->
<div id="tc5" class="view-content paper-notes-library theme-dark" style="width: 320px; padding: 10px; background: #1e1e1e;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="搜索主题或表格内容…">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear is-hidden" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<!-- Case 6: 240px RTL input -->
<div id="tc6" class="view-content paper-notes-library mod-rtl is-rtl" dir="rtl" style="width: 240px; padding: 10px;">
  <div class="paper-notes-moc-directory">
    <div class="paper-notes-moc-header">
      <div class="paper-notes-moc-search-wrap">
        <span class="paper-notes-moc-search-icon" aria-hidden="true"><svg width="14" height="14"></svg></span>
        <input class="paper-notes-moc-search-input" type="search" placeholder="חיפוש..." value="חיפוש תאים">
        <button class="paper-notes-icon-button paper-notes-moc-search-clear" type="button"><svg width="14" height="14"></svg></button>
      </div>
    </div>
  </div>
</div>

<script>
window.addEventListener('DOMContentLoaded', () => {
  const cases = ['tc1', 'tc2', 'tc3', 'tc4', 'tc5', 'tc6'];
  const results = {};

  for (const id of cases) {
    const root = document.getElementById(id);
    const input = root.querySelector('.paper-notes-moc-search-input');
    const icon = root.querySelector('.paper-notes-moc-search-icon');
    const clear = root.querySelector('.paper-notes-moc-search-clear');
    
    const inputStyle = window.getComputedStyle(input);
    const clearStyle = window.getComputedStyle(clear);
    const inputRect = input.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const clearRect = clear.getBoundingClientRect();
    
    const isRtl = root.getAttribute('dir') === 'rtl';
    const isClearHidden = clear.classList.contains('is-hidden');
    let gapIconText = 0;
    let gapTextClear = 0;

    if (!isRtl) {
      const textContentStart = inputRect.left + parseFloat(inputStyle.paddingLeft) + parseFloat(inputStyle.borderLeftWidth);
      const textContentEnd = inputRect.right - parseFloat(inputStyle.paddingRight) - parseFloat(inputStyle.borderRightWidth);
      const iconEnd = iconRect.right;
      const clearStart = clearRect.left;
      gapIconText = textContentStart - iconEnd;
      gapTextClear = isClearHidden ? 999 : clearStart - textContentEnd;
    } else {
      // In RTL, inline-start is right edge, inline-end is left edge
      const textContentStart = inputRect.right - parseFloat(inputStyle.paddingRight) - parseFloat(inputStyle.borderRightWidth);
      const textContentEnd = inputRect.left + parseFloat(inputStyle.paddingLeft) + parseFloat(inputStyle.borderLeftWidth);
      const iconEnd = iconRect.left;
      const clearStart = clearRect.right;
      gapIconText = iconEnd - textContentStart;
      gapTextClear = isClearHidden ? 999 : textContentEnd - clearStart;
    }

    results[id] = {
      isRtl,
      paddingInlineStart: inputStyle.paddingInlineStart,
      paddingInlineEnd: inputStyle.paddingInlineEnd,
      gapIconText,
      gapTextClear,
      clearWidth: isClearHidden ? 0 : clearRect.width,
      clearHeight: isClearHidden ? 0 : clearRect.height,
      clearPadding: clearStyle.padding,
    };
  }

  fetch(location.origin, {
    method: 'POST',
    body: JSON.stringify(results)
  });
});
</script>
</body>
</html>`;

      try {
        const results = await new Promise<Record<string, LayoutCaseResult>>((resolve, reject) => {
          server = http.createServer((req, res) => {
            if (req.method === "POST") {
              let body = "";
              req.on("data", (chunk) => (body += chunk));
              req.on("end", () => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("OK");
                resolve(JSON.parse(body));
              });
            } else {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(html);
            }
          });

          server.listen(0, "127.0.0.1", () => {
            const address = server!.address() as import("net").AddressInfo;
            const port = address.port;
            const chromeArgs = [
              "--headless=new",
              "--disable-gpu",
              "--no-first-run",
              "--no-default-browser-check",
              `--user-data-dir=${userDataDir}`,
              `http://127.0.0.1:${port}`,
            ];

            child = spawn(CHROME_PATH, chromeArgs, { stdio: "ignore" });
            child.on("error", (err) => reject(err));
          });

          setTimeout(() => {
            reject(new Error("Timeout waiting for headless Chrome layout test results"));
          }, 15000);
        });

        // Verification across all test cases
        for (const [id, res] of Object.entries(results)) {
          expect(res.paddingInlineStart, `${id} paddingInlineStart`).toBe("28px");
          expect(res.paddingInlineEnd, `${id} paddingInlineEnd`).toBe("32px");
          // Icon and search text MUST have positive clearance (> 0)
          expect(res.gapIconText, `${id} gapIconText`).toBeGreaterThan(0);
          // If clear button is visible, text must have non-negative clearance (>= 0)
          if (res.clearWidth > 0) {
            expect(res.gapTextClear, `${id} gapTextClear`).toBeGreaterThanOrEqual(0);
            expect(res.clearWidth, `${id} clearWidth`).toBe(24);
            expect(res.clearHeight, `${id} clearHeight`).toBe(24);
            expect(res.clearPadding, `${id} clearPadding`).toBe("0px");
          }
        }
      } finally {
        if (child && !child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        if (server) {
          server.close();
        }
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
    20000,
  );
});
