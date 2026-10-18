import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import {
  SAMPLE_CSL_JSON,
  SAMPLE_MARKDOWN,
  buildPreviewArgs,
  cslPreviewCachePath,
  extractCitationParagraph,
  extractPreviewHtml,
  extractRefsDiv,
  generateCslPreview,
  type CslPreviewConfig,
  type CslPreviewFileSystem,
  type CslPreviewPorts,
  type PandocProcess,
  type PandocRunner,
} from "../src/services/csl-preview";

// ---------------------------------------------------------------------------
// Fakes for ports (runner and filesystem).
// ---------------------------------------------------------------------------

class FakePandocProcess implements PandocProcess {
  exitCode: number | null = null;
  killed = false;
  killSignal?: string;
  private listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  private stdoutListeners: Array<(chunk: Buffer) => void> = [];
  private stderrListeners: Array<(chunk: Buffer) => void> = [];

  stdout = {
    on: (_event: string, cb: (chunk: Buffer) => void): void => {
      this.stdoutListeners.push(cb);
    },
  };
  stderr = {
    on: (_event: string, cb: (chunk: Buffer) => void): void => {
      this.stderrListeners.push(cb);
    },
  };

  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: string, cb: (...args: any[]) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  emitStdout(text: string): void {
    for (const cb of this.stdoutListeners) cb(Buffer.from(text, "utf8"));
  }

  emitStderr(text: string): void {
    for (const cb of this.stderrListeners) cb(Buffer.from(text, "utf8"));
  }

  emitError(error: Error): void {
    for (const cb of this.listeners["error"] ?? []) cb(error);
  }

  emitClose(code: number | null): void {
    this.exitCode = code;
    for (const cb of this.listeners["close"] ?? []) cb(code);
  }
}

interface FakeFsState {
  fs: CslPreviewFileSystem;
  files: Map<string, string>;
  ops: string[];
}

function makeFakeFs(seed: Array<[string, string]> = []): FakeFsState {
  const files = new Map<string, string>(seed);
  const ops: string[] = [];
  let mkdtempCount = 0;

  const fs: CslPreviewFileSystem = {
    async mkdtemp(prefix: string): Promise<string> {
      mkdtempCount += 1;
      const path = `/tmp/${prefix}${mkdtempCount}`;
      ops.push(`mkdtemp:${path}`);
      return path;
    },
    async writeText(path: string, content: string): Promise<void> {
      ops.push(`writeText:${path}`);
      files.set(path, content);
    },
    async readText(path: string): Promise<string> {
      ops.push(`readText:${path}`);
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return content;
    },
    async rmRecursive(path: string): Promise<void> {
      ops.push(`rmRecursive:${path}`);
      for (const key of Array.from(files.keys())) {
        if (key.startsWith(path)) {
          files.delete(key);
        }
      }
    },
    async exists(path: string): Promise<boolean> {
      ops.push(`exists:${path}`);
      return files.has(path);
    },
  };

  return { fs, files, ops };
}

const SAMPLE_HTML_OUTPUT = `
<h1 id="preview">Preview</h1>
<p>Citing <span class="citation" data-cites="sample-article sample-book sample-inproceedings">(Doe 2019; Smith 2020; Zhang 2021)</span>.</p>
<div id="refs" class="references csl-bib-body hanging-indent" role="list">
<div id="ref-sample-book" class="csl-entry" role="listitem">
Doe, Jane. 2019. <em>The Sample Book</em>. New York: Example Press.
</div>
<div id="ref-sample-article" class="csl-entry" role="listitem">
Smith, John. 2020. “A Sample Journal Article.” <em>Journal of Examples</em> 10 (2): 100–110. https://doi.org/10.1234/example.
</div>
<div id="ref-sample-inproceedings" class="csl-entry" role="listitem">
Zhang, Wei. 2021. “A Sample Conference Paper.” In <em>Proceedings of the Example Conference</em>, 50–55.
</div>
</div>
`.trim();

describe("CSL Preview (Stage S1)", () => {
  describe("sample bibliography and markdown constants", () => {
    it("exports valid SAMPLE_CSL_JSON containing exactly 3 items with required ids", () => {
      const items = JSON.parse(SAMPLE_CSL_JSON) as Array<Record<string, unknown>>;
      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(3);

      const ids = items.map((i) => i.id);
      expect(ids).toEqual(["sample-article", "sample-book", "sample-inproceedings"]);

      const article = items.find((i) => i.id === "sample-article");
      expect(article).toMatchObject({
        id: "sample-article",
        type: "article-journal",
        author: [{ family: "Smith", given: "John" }],
        title: "A Sample Journal Article",
        "container-title": "Journal of Examples",
        issued: { "date-parts": [[2020]] },
        volume: "10",
        issue: "2",
        page: "100-110",
        DOI: "10.1234/example",
      });

      const book = items.find((i) => i.id === "sample-book");
      expect(book).toMatchObject({
        id: "sample-book",
        type: "book",
        author: [{ family: "Doe", given: "Jane" }],
        title: "The Sample Book",
        issued: { "date-parts": [[2019]] },
        publisher: "Example Press",
        "publisher-place": "New York",
      });

      const inproc = items.find((i) => i.id === "sample-inproceedings");
      expect(inproc).toMatchObject({
        id: "sample-inproceedings",
        type: "paper-conference",
        author: [{ family: "Zhang", given: "Wei" }],
        title: "A Sample Conference Paper",
        "container-title": "Proceedings of the Example Conference",
        issued: { "date-parts": [[2021]] },
        page: "50-55",
      });
    });

    it("exports SAMPLE_MARKDOWN citing all 3 keys with a heading", () => {
      expect(SAMPLE_MARKDOWN).toMatch(/^#\s+/m);
      expect(SAMPLE_MARKDOWN).toContain(
        "Citing [@sample-article; @sample-book; @sample-inproceedings].",
      );
    });
  });

  describe("pure helpers", () => {
    it("computes cslPreviewCachePath as <cslDir>/.cache/<cslFile>.html", () => {
      const cachePath = cslPreviewCachePath("/vault/.paper-notes/csl", "nature.csl");
      expect(cachePath).toBe(
        join("/vault/.paper-notes/csl", ".cache", "nature.csl.html"),
      );
    });

    it("builds Pandoc CLI preview arguments without lua-filter or reference-doc", () => {
      const args = buildPreviewArgs("/vault/.paper-notes/csl/nature.csl");
      expect(args).toEqual([
        "sample.md",
        "--from",
        "markdown",
        "--to",
        "html",
        "--citeproc",
        "--bibliography",
        "library.json",
        "--csl",
        "/vault/.paper-notes/csl/nature.csl",
        "-o",
        "out.html",
      ]);
      expect(args).not.toContain("--lua-filter");
      expect(args).not.toContain("--reference-doc");
    });

    it("extracts refs div properly with nested divs", () => {
      const html = `
        <header>Header</header>
        <div id="refs" class="references">
          <div id="ref-1" class="csl-entry">
            <div class="inner">1. Ref one</div>
          </div>
          <div id="ref-2" class="csl-entry">2. Ref two</div>
        </div>
        <footer>Footer</footer>
      `;
      const refs = extractRefsDiv(html);
      expect(refs).toBeDefined();
      expect(refs).toContain('id="refs"');
      expect(refs).toContain("Ref one");
      expect(refs).toContain("Ref two");
      expect(refs).not.toContain("<header>");
      expect(refs).not.toContain("<footer>");
    });

    it("extracts citation paragraph containing citation span", () => {
      const p = extractCitationParagraph(SAMPLE_HTML_OUTPUT);
      expect(p).toBeDefined();
      expect(p).toContain('class="citation"');
      expect(p).toContain("Doe 2019; Smith 2020; Zhang 2021");
    });

    it("extractPreviewHtml combines citation sentence and bibliography", () => {
      const result = extractPreviewHtml(SAMPLE_HTML_OUTPUT);
      expect(result).toContain('class="citation"');
      expect(result).toContain('id="refs"');
      expect(result).toContain("Smith, John. 2020.");
      expect(result).not.toContain('<h1 id="preview">');
    });

    it("extractPreviewHtml falls back to full body when no refs div is present", () => {
      const htmlWithBody = `
        <!DOCTYPE html>
        <html>
        <head><title>Test</title></head>
        <body>
          <h1>No refs</h1>
          <p>Plain text paragraph.</p>
        </body>
        </html>
      `;
      const resultWithBody = extractPreviewHtml(htmlWithBody);
      expect(resultWithBody).toContain("<h1>No refs</h1>");
      expect(resultWithBody).toContain("<p>Plain text paragraph.</p>");
      expect(resultWithBody).not.toContain("<!DOCTYPE html>");

      const fragmentWithoutBody = "<p>Plain fragment without refs div</p>";
      const resultFragment = extractPreviewHtml(fragmentWithoutBody);
      expect(resultFragment).toBe(fragmentWithoutBody);
    });
  });

  describe("generateCslPreview orchestration", () => {
    const config: CslPreviewConfig = {
      pandocPath: "/usr/local/bin/pandoc",
      cslPath: "/vault/.paper-notes/csl/nature.csl",
      cachePath: "/vault/.paper-notes/csl/.cache/nature.csl.html",
    };

    it("success path: runs pandoc, extracts HTML, writes cache file, and cleans up temp dir", async () => {
      const fakeFs = makeFakeFs();
      let capturedArgs: string[] = [];
      let capturedCwd = "";
      let capturedCommand = "";

      const runner: PandocRunner = (command, args, options) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedCwd = options.cwd;
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          // Fake pandoc writing out.html to cwd
          fakeFs.files.set(join(options.cwd, "out.html"), SAMPLE_HTML_OUTPUT);
          proc.emitClose(0);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.html).toContain('class="citation"');
        expect(result.html).toContain('id="refs"');
        expect(result.html).toContain("Smith, John. 2020.");
      }

      // Assert command and arguments
      expect(capturedCommand).toBe(config.pandocPath);
      expect(capturedArgs).toEqual(buildPreviewArgs(config.cslPath));
      expect(capturedCwd).toMatch(/^\/tmp\/csl-preview-/);

      // Assert sample files written to temp directory
      const mkdtempOp = fakeFs.ops.find((op) => op.startsWith("mkdtemp:"));
      expect(mkdtempOp).toBeDefined();
      const tempDir = mkdtempOp!.split(":")[1];

      expect(fakeFs.ops).toContain(`writeText:${join(tempDir, "sample.md")}`);
      expect(fakeFs.ops).toContain(`writeText:${join(tempDir, "library.json")}`);

      // Assert cache file was written
      expect(fakeFs.files.get(config.cachePath)).toBe(
        result.ok ? result.html : "",
      );

      // Assert temp dir was removed in finally
      expect(fakeFs.ops).toContain(`rmRecursive:${tempDir}`);
    });

    it("pandoc nonzero exit returns ok: false with stderr and does not write cache", async () => {
      const fakeFs = makeFakeFs();

      const runner: PandocRunner = (_cmd, _args, _opts) => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          proc.emitStderr("pandoc: error reading CSL style file\n");
          proc.emitClose(1);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("pandoc: error reading CSL style file");
      }

      // Assert no cache file written
      expect(fakeFs.files.has(config.cachePath)).toBe(false);

      // Temp dir still cleaned up
      const mkdtempOp = fakeFs.ops.find((op) => op.startsWith("mkdtemp:"));
      expect(fakeFs.ops).toContain(`rmRecursive:${mkdtempOp!.split(":")[1]}`);
    });

    it("pandoc nonzero exit with empty stderr formats generic exit code error", async () => {
      const fakeFs = makeFakeFs();

      const runner: PandocRunner = () => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          proc.emitClose(99);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Pandoc process exited with code 99");
      }
      expect(fakeFs.files.has(config.cachePath)).toBe(false);
    });

    it("process spawn error event returns ok: false without throwing", async () => {
      const fakeFs = makeFakeFs();

      const runner: PandocRunner = () => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          proc.emitError(new Error("spawn ENOENT pandoc"));
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("spawn ENOENT pandoc");
      }
      expect(fakeFs.files.has(config.cachePath)).toBe(false);
    });

    it("runner throwing synchronously returns ok: false without throwing", async () => {
      const fakeFs = makeFakeFs();

      const runner: PandocRunner = () => {
        throw new Error("Cannot execute binary: Permission denied");
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Cannot execute binary: Permission denied");
      }
      expect(fakeFs.files.has(config.cachePath)).toBe(false);
    });

    it("times out and kills process after configured timeoutMs with SIGTERM", async () => {
      const fakeFs = makeFakeFs();
      let fakeProc: FakePandocProcess | null = null;

      const runner: PandocRunner = () => {
        fakeProc = new FakePandocProcess();
        // Do not emit close: let it hang
        return fakeProc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, {
        ...config,
        timeoutMs: 40,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Pandoc preview timed out after 0s");
      }

      expect(fakeProc).not.toBeNull();
      expect(fakeProc!.killed).toBe(true);
      expect(fakeProc!.killSignal).toBe("SIGTERM");
      expect(fakeFs.files.has(config.cachePath)).toBe(false);
    });

    it("missing refs div falls back to full body HTML and writes cache", async () => {
      const fakeFs = makeFakeFs();
      const fallbackHtml = "<div><p>Simple output without bibliography</p></div>";

      const runner: PandocRunner = (_cmd, _args, options) => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          fakeFs.files.set(join(options.cwd, "out.html"), fallbackHtml);
          proc.emitClose(0);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.html).toBe(fallbackHtml);
      }
      expect(fakeFs.files.get(config.cachePath)).toBe(fallbackHtml);
    });

    it("failure when reading out.html returns ok: false and cleans temp dir", async () => {
      const fakeFs = makeFakeFs();

      const runner: PandocRunner = () => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          // Do not write out.html
          proc.emitClose(0);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ENOENT");
      }
    });

    it("cleans up temp dir even if rmRecursive throws internally", async () => {
      const fakeFs = makeFakeFs();
      // Force rmRecursive to throw
      fakeFs.fs.rmRecursive = vi.fn().mockRejectedValue(new Error("Disk busy"));

      const runner: PandocRunner = (_cmd, _args, options) => {
        const proc = new FakePandocProcess();
        queueMicrotask(() => {
          fakeFs.files.set(join(options.cwd, "out.html"), SAMPLE_HTML_OUTPUT);
          proc.emitClose(0);
        });
        return proc;
      };

      const ports: CslPreviewPorts = { runner, fs: fakeFs.fs };
      const result = await generateCslPreview(ports, config);

      // The preview result should still be ok, cleanup error was caught in finally
      expect(result.ok).toBe(true);
    });
  });
});
