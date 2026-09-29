/**
 * Literature Card creation (Card Selection) test suite.
 *
 * Verifies:
 * - Strict Figure note source identification & key regex.
 * - View mode enforcement (Source / Live Preview supported; Reading View rejected).
 * - UTF-8 byte half-open interval calculation with CJK, emoji, and CRLF.
 * - Save-await before byte computation with unsaved selection updates.
 * - Modal title validation, Enter/Esc, and failure input preservation.
 * - Anchor failed handling (still opens card, no dead link, warning Notice).
 * - Path taken strictly from CLI output (no manual stitching).
 * - Open in new tab and cursor position after `## 扩展`.
 * - Concurrency guard and editor freeze / unfreeze lifecycle.
 * - Plugin command and editor-menu integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./obsidian.mock"));

import {
  parseFigureSource,
  isSourceOrLivePreview,
  computeSelectionByteOffsets,
  findPositionAfterHeading,
  positionCursorAfterExtensionHeading,
  cardCreateArgs,
  CardCreationService,
  defaultFreezeEditor,
  type CardCreationServicePorts,
  type CardCreationViewPort,
} from "../src/services/card-creation";
import { LiteratureCardModal } from "../src/modals/literature-card-modal";
import { CliClient, type CliRunResult } from "../src/services/cli-client";
import type { ProtocolEnvelope } from "../src/types/protocol";
import PaperNotesPlugin, {
  CREATE_LITERATURE_CARD_COMMAND,
} from "../src/main";
import {
  registeredCommands,
  registeredCommandObjects,
  recordedNotices,
  resetRegistries,
  TFile,
  Editor,
  MarkdownView,
  Menu,
} from "./obsidian.mock";

function makeEnvelope(
  status: ProtocolEnvelope["status"],
  data: Record<string, unknown> = {},
  warnings: ProtocolEnvelope["warnings"] = [],
  errors: ProtocolEnvelope["errors"] = [],
): ProtocolEnvelope {
  return {
    protocol_version: 1,
    status,
    data,
    warnings,
    errors,
  } as ProtocolEnvelope;
}

function mockCliClient(
  result: CliRunResult | ((args: string[]) => CliRunResult),
): CliClient {
  const run = vi.fn(
    typeof result === "function"
      ? (args: string[]) => Promise.resolve(result(args))
      : () => Promise.resolve(result),
  );
  const client = { run } as unknown as CliClient;
  return client;
}

describe("1. Strict Figure Source Identification", () => {
  it("accepts valid canonical Figure note path with standard citation key", () => {
    const res = parseFigureSource("05 Literature/shiau2024/Figure解读_shiau2024.md");
    expect(res).not.toBeNull();
    expect(res?.key).toBe("shiau2024");
    expect(res?.sourceNote).toBe("Figure解读_shiau2024");
  });

  it("accepts citation keys with allowed characters (+, _, ., -)", () => {
    const res = parseFigureSource(
      "05 Literature/author-2024_a.b+c/Figure解读_author-2024_a.b+c.md",
    );
    expect(res).not.toBeNull();
    expect(res?.key).toBe("author-2024_a.b+c");
    expect(res?.sourceNote).toBe("Figure解读_author-2024_a.b+c");
  });

  it("rejects non-Figure notes in paper directory", () => {
    // Main note
    expect(parseFigureSource("05 Literature/shiau2024/shiau2024.md")).toBeNull();
    // Card note
    expect(parseFigureSource("05 Literature/shiau2024/cards/card_one.md")).toBeNull();
    // Attachment PDF
    expect(parseFigureSource("05 Literature/shiau2024/shiau2024.pdf")).toBeNull();
    // MinerU markdown
    expect(parseFigureSource("05 Literature/shiau2024/minerUmd_shiau2024.md")).toBeNull();
  });

  it("rejects when directory and Figure note key do not match", () => {
    expect(parseFigureSource("05 Literature/shiau2024/Figure解读_other.md")).toBeNull();
  });

  it("rejects paths outside literature root", () => {
    expect(parseFigureSource("Notes/shiau2024/Figure解读_shiau2024.md")).toBeNull();
    expect(parseFigureSource("04 Literature/shiau2024/Figure解读_shiau2024.md")).toBeNull();
  });

  it("rejects path traversal attempts", () => {
    expect(parseFigureSource("05 Literature/../shiau2024/Figure解读_shiau2024.md")).toBeNull();
    expect(parseFigureSource("05 Literature/..key/Figure解读_..key.md")).toBeNull();
  });

  it("rejects invalid citation keys (e.g. starting with digit or spaces)", () => {
    expect(parseFigureSource("05 Literature/123author/Figure解读_123author.md")).toBeNull();
    expect(parseFigureSource("05 Literature/author 2024/Figure解读_author 2024.md")).toBeNull();
  });

  it("respects customized literatureRoot setting with leading/trailing slashes", () => {
    expect(
      parseFigureSource("Library/Papers/shiau2024/Figure解读_shiau2024.md", "Library/Papers"),
    ).toEqual({
      key: "shiau2024",
      sourceNote: "Figure解读_shiau2024",
    });

    expect(
      parseFigureSource("/05 Literature/shiau2024/Figure解读_shiau2024.md", "/05 Literature/"),
    ).toEqual({
      key: "shiau2024",
      sourceNote: "Figure解读_shiau2024",
    });
  });
});

describe("2. View Mode Enforcement", () => {
  it("accepts Source Mode", () => {
    const view = {
      getMode: () => "source",
      getState: () => ({ mode: "source", source: true }),
    };
    expect(isSourceOrLivePreview(view)).toBe(true);
  });

  it("accepts Live Preview Mode", () => {
    const view = {
      getMode: () => "source",
      getState: () => ({ mode: "source", source: false }),
    };
    expect(isSourceOrLivePreview(view)).toBe(true);
  });

  it("rejects Reading View", () => {
    const view = {
      getMode: () => "preview",
      getState: () => ({ mode: "preview" }),
    };
    expect(isSourceOrLivePreview(view)).toBe(false);
  });

  it("rejects Reading View when getState indicates preview", () => {
    const view = {
      getState: () => ({ mode: "preview" }),
    };
    expect(isSourceOrLivePreview(view)).toBe(false);
  });
});

describe("3. UTF-8 Byte Offset Calculations (CJK, Emoji, CRLF)", () => {
  it("calculates exact UTF-8 byte offsets for ASCII single-line", () => {
    const text = "Hello world\nThis is a selection\nEnd";
    const from = { line: 1, ch: 0 };
    const to = { line: 1, ch: 4 }; // "This"
    const result = computeSelectionByteOffsets(text, from, to, "This");

    expect(result.startByte).toBe(12); // "Hello world\n" is 12 bytes
    expect(result.endByte).toBe(16);
    expect(result.selectionText).toBe("This");
    expect(result.selectionBytes).toEqual(new TextEncoder().encode("This"));
  });

  it("calculates exact UTF-8 byte offsets for CJK multi-byte characters (3 bytes/char)", () => {
    // "第一行说明\n" = 5 * 3 + 1 = 16 bytes
    // "图 1 显示了神经元的结构\n"
    // "图 1" -> '图' (3 bytes) + ' ' (1 byte) + '1' (1 byte) = 5 bytes
    const text = "第一行说明\n图 1 显示了神经元的结构\n结束";
    const from = { line: 1, ch: 0 };
    const to = { line: 1, ch: 3 }; // "图 1"
    const result = computeSelectionByteOffsets(text, from, to, "图 1");

    expect(result.startByte).toBe(16);
    expect(result.endByte).toBe(21);
    expect(result.selectionText).toBe("图 1");
    expect(result.selectionBytes).toEqual(new TextEncoder().encode("图 1"));
  });

  it("calculates exact UTF-8 byte offsets for emoji surrogate pairs (4 bytes/char)", () => {
    // "Prefix: " = 8 bytes
    // "🔬 Microscope" -> "🔬" is 2 UTF-16 units, 4 UTF-8 bytes
    const text = "Prefix: 🔬 Microscope\nNext";
    const from = { line: 0, ch: 8 };
    const to = { line: 0, ch: 10 }; // "🔬" (length 2 in JS string)
    const result = computeSelectionByteOffsets(text, from, to, "🔬");

    expect(result.startByte).toBe(8);
    expect(result.endByte).toBe(12);
    expect(result.selectionText).toBe("🔬");
    expect(result.selectionBytes).toEqual(new TextEncoder().encode("🔬"));
  });

  it("rejects selection that splits a Unicode surrogate pair", () => {
    const text = "Prefix: 🔬 Microscope\n";
    // ch 9 splits the surrogate pair of 🔬
    const from = { line: 0, ch: 9 };
    const to = { line: 0, ch: 12 };
    expect(() => computeSelectionByteOffsets(text, from, to)).toThrow(
      /Unicode 代理对/,
    );
  });

  it("calculates exact UTF-8 byte offsets with CRLF (\\r\\n) newlines", () => {
    // Line 0: "Line 1\r\n" -> 8 bytes
    // Line 1: "Line 2 target\r\n" -> 15 bytes
    // Line 2: "Line 3"
    const text = "Line 1\r\nLine 2 target\r\nLine 3";
    const from = { line: 1, ch: 0 };
    const to = { line: 1, ch: 6 }; // "Line 2"
    const result = computeSelectionByteOffsets(text, from, to, "Line 2");

    expect(result.startByte).toBe(8);
    expect(result.endByte).toBe(14);
    expect(result.selectionText).toBe("Line 2");
    expect(result.selectionBytes).toEqual(new TextEncoder().encode("Line 2"));
  });

  it("handles multi-line selection spanning CRLF preserving disk line breaks", () => {
    const text = "Alpha\r\nBeta\r\nGamma";
    const from = { line: 0, ch: 0 };
    const to = { line: 1, ch: 4 }; // "Alpha\r\nBeta"
    // In CodeMirror, getSelection() yields normalized \n
    const editorSelection = "Alpha\nBeta";
    const result = computeSelectionByteOffsets(text, from, to, editorSelection);

    expect(result.startByte).toBe(0);
    expect(result.endByte).toBe(11);
    expect(result.selectionText).toBe("Alpha\r\nBeta");
    expect(result.selectionBytes).toEqual(new TextEncoder().encode("Alpha\r\nBeta"));
  });

  it("rejects when editor selection does not match saved file text", () => {
    const text = "Line 1\nDifferent saved content\nLine 3";
    const from = { line: 1, ch: 0 };
    const to = { line: 1, ch: 9 };
    expect(() =>
      computeSelectionByteOffsets(text, from, to, "Expected text that differs"),
    ).toThrow(/不一致/);
  });
});

describe("4. Unsaved Selection Save-Await and Recompute", () => {
  it("awaits saveView before reading binary bytes and computes offsets on saved content", async () => {
    let saved = false;
    const executionOrder: string[] = [];

    let diskContent = "Initial content on disk before edit.";
    const editedContent = "Initial content on disk with UNSAVED EDITS inserted.";

    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/test2024/Figure解读_test2024.md" },
      editor: {
        getSelection: () => "UNSAVED EDITS",
        getCursor: (which) =>
          which === "from" ? { line: 0, ch: 29 } : { line: 0, ch: 42 },
      },
      getMode: () => "source",
      save: async () => {
        executionOrder.push("saveView");
        saved = true;
        diskContent = editedContent;
      },
      containerEl: { style: { pointerEvents: "" } },
    };

    const ports: CardCreationServicePorts = {
      client: mockCliClient({
        envelope: makeEnvelope("success", {
          path: "05 Literature/test2024/cards/card_unsaved.md",
          anchor_status: "inserted",
        }),
        exitCode: 0,
        stderr: "",
      }),
      vaultRoot: "/test-vault",
      readBinary: async () => {
        executionOrder.push("readBinary");
        return new TextEncoder().encode(diskContent).buffer;
      },
      saveView: async (v) => {
        if (v.save) await v.save();
      },
      reloadSourceNote: async () => {
        executionOrder.push("reloadSourceNote");
      },
      freezeEditor: (v) => defaultFreezeEditor(v),
      openCard: async () => {
        executionOrder.push("openCard");
        return {
          editor: {
            getValue: () => "## 扩展\n",
            setCursor: () => {},
            focus: () => {},
          },
        };
      },
      showNotice: vi.fn(),
    };

    const service = new CardCreationService(ports);
    const result = await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Card from unsaved edit",
    });

    expect(result.ok).toBe(true);
    expect(saved).toBe(true);
    // Verified saveView was called before readBinary
    expect(executionOrder.indexOf("saveView")).toBeLessThan(
      executionOrder.indexOf("readBinary"),
    );
  });

  it("aborts and shows notice when saveView fails without calling CLI", async () => {
    const cliRunSpy = vi.fn();
    const client = { run: cliRunSpy } as unknown as CliClient;
    const showNotice = vi.fn();

    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/test2024/Figure解读_test2024.md" },
      editor: {
        getSelection: () => "Selected text",
        getCursor: () => ({ line: 0, ch: 0 }),
      },
      getMode: () => "source",
      containerEl: { style: { pointerEvents: "" } },
    };

    const ports: CardCreationServicePorts = {
      client,
      vaultRoot: "/test-vault",
      readBinary: vi.fn(),
      saveView: async () => {
        throw new Error("Disk full: cannot save view.");
      },
      reloadSourceNote: vi.fn(),
      freezeEditor: (v) => defaultFreezeEditor(v),
      openCard: vi.fn(),
      showNotice,
    };

    const service = new CardCreationService(ports);
    const res = await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Test Card",
    });

    expect(res.ok).toBe(false);
    expect(cliRunSpy).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("保存笔记失败"));
  });
});

describe("5. Modal Behavior (Title Required, Enter/Esc, Failure Preserves Title)", () => {
  it("initializes with blank, auto-focused input and renders selection excerpt", () => {
    const modal = new LiteratureCardModal({} as never, {
      sourceSelection: "Detailed figure interpretation quote text",
      onSubmit: async () => true,
    });
    modal.onOpen();

    expect(modal.inputEl.value).toBe("");
  });

  it("rejects empty / whitespace title without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    const modal = new LiteratureCardModal({} as never, {
      sourceSelection: "Selection",
      onSubmit,
    });
    modal.onOpen();

    modal.inputEl.value = "   ";
    await modal.submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(modal.errorEl.textContent).toContain("卡片标题为必填项");
  });

  it("retains input text on conflict or failure and allows editing", async () => {
    let callCount = 0;
    const onSubmit = vi.fn(async (title: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error(`A card named "${title}" already exists.`);
      }
      return true;
    });

    const modal = new LiteratureCardModal({} as never, {
      sourceSelection: "Selection",
      onSubmit,
    });
    modal.onOpen();

    modal.inputEl.value = "Conflicting Title";
    await modal.submit();

    // First attempt failed: input retained!
    expect(modal.inputEl.value).toBe("Conflicting Title");
    expect(modal.errorEl.textContent).toContain("already exists");
    expect(modal.inputEl.disabled).toBe(false);

    // User modifies title and resubmits
    modal.inputEl.value = "Conflicting Title (Resolved)";
    await modal.submit();

    expect(callCount).toBe(2);
    expect(onSubmit).toHaveBeenLastCalledWith("Conflicting Title (Resolved)");
  });

  it("invokes onCancel when closed without submit", () => {
    const onCancel = vi.fn();
    const modal = new LiteratureCardModal({} as never, {
      sourceSelection: "Selection",
      onSubmit: async () => true,
      onCancel,
    });
    modal.onOpen();
    modal.onClose();

    expect(onCancel).toHaveBeenCalled();
  });
});

describe("6. Anchor Failed Handling (No Dead Link, Success, Warning Notice)", () => {
  it("opens card and shows warning without dead links when anchor_status is failed", async () => {
    const noticeMessages: string[] = [];
    let openedPath = "";
    const cursorPositionSet = { line: -1, ch: -1 };

    const savedContent = "Figure 1 explanation passage.\nSecond line.";
    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/author2024/Figure解读_author2024.md" },
      editor: {
        getSelection: () => "passage",
        getCursor: (which) =>
          which === "from" ? { line: 0, ch: 21 } : { line: 0, ch: 28 },
      },
      getMode: () => "source",
      containerEl: { style: { pointerEvents: "" } },
    };

    const ports: CardCreationServicePorts = {
      client: mockCliClient({
        envelope: makeEnvelope(
          "success",
          {
            citation_key: "author2024",
            paper_id: "test-id",
            path: "05 Literature/author2024/cards/card_anchor_failed.md",
            stem: "card_anchor_failed",
            anchor_name: "pn-xyz",
            anchor_status: "failed",
            anchor_inserted: false,
            anchor_link: null,
            backlink_inserted: false,
          },
          [
            {
              code: "card_anchor_failed",
              message:
                "source text at byte range does not match selection; anchor not inserted",
              path: "05 Literature/author2024/Figure解读_author2024.md",
            },
          ],
        ),
        exitCode: 0,
        stderr: "",
      }),
      vaultRoot: "/vault",
      readBinary: async () => new TextEncoder().encode(savedContent).buffer,
      saveView: async () => {},
      reloadSourceNote: vi.fn(),
      freezeEditor: (v) => defaultFreezeEditor(v),
      openCard: async (cardPath: string) => {
        openedPath = cardPath;
        return {
          editor: {
            getValue: () =>
              "---\npaper_id: test-id\n---\n\npassage\n\n## 扩展\n\n",
            setCursor: (pos) => {
              cursorPositionSet.line = pos.line;
              cursorPositionSet.ch = pos.ch;
            },
            focus: () => {},
          },
        };
      },
      showNotice: (msg) => {
        noticeMessages.push(msg);
      },
    };

    const service = new CardCreationService(ports);
    const res = await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Anchor Failed Test",
    });

    // 1. Result is success
    expect(res.ok).toBe(true);
    expect(res.data?.anchor_status).toBe("failed");
    expect(res.data?.anchor_link).toBeNull();

    // 2. Card was still opened
    expect(openedPath).toBe(
      "05 Literature/author2024/cards/card_anchor_failed.md",
    );

    // 3. Cursor positioned after ## 扩展
    expect(cursorPositionSet.line).toBe(7);

    // 4. Warning notice was displayed
    expect(
      noticeMessages.some((msg) => msg.includes("源笔记未插入锚点（已避免死链）")),
    ).toBe(true);
  });
});

describe("7. Path From CLI Output (Not Hand-Stitched)", () => {
  it("uses the path returned by the CLI envelope directly", async () => {
    let cardPathOpened = "";
    const cliAssignedPath =
      "05 Literature/custom2024/cards/card_custom_derived_slug_123.md";

    const content = "Selected text passage in figure note.";
    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/custom2024/Figure解读_custom2024.md" },
      editor: {
        getSelection: () => "Selected text",
        getCursor: (which) =>
          which === "from" ? { line: 0, ch: 0 } : { line: 0, ch: 13 },
      },
      getMode: () => "source",
      containerEl: { style: { pointerEvents: "" } },
    };

    const ports: CardCreationServicePorts = {
      client: mockCliClient({
        envelope: makeEnvelope("success", {
          citation_key: "custom2024",
          path: cliAssignedPath,
          anchor_status: "inserted",
        }),
        exitCode: 0,
        stderr: "",
      }),
      vaultRoot: "/vault",
      readBinary: async () => new TextEncoder().encode(content).buffer,
      saveView: async () => {},
      reloadSourceNote: vi.fn(),
      freezeEditor: (v) => defaultFreezeEditor(v),
      openCard: async (path: string) => {
        cardPathOpened = path;
        return {
          editor: {
            getValue: () => "## 扩展\n",
            setCursor: () => {},
            focus: () => {},
          },
        };
      },
      showNotice: vi.fn(),
    };

    const service = new CardCreationService(ports);
    await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Human Authored Title That Would Have Different Slug",
    });

    expect(cardPathOpened).toBe(cliAssignedPath);
  });
});

describe("8. Open in New Tab and Position Cursor After ## 扩展", () => {
  it("finds line immediately after ## 扩展 heading", () => {
    const cardContent = [
      "---",
      "citation_key: test2024",
      "---",
      "",
      "Verbatim selection",
      "",
      "> 参见 [[Figure解读_test2024#^anchor|Figure解读_test2024]]",
      "",
      "## 扩展",
      "",
    ].join("\n");

    const pos = findPositionAfterHeading(cardContent, "## 扩展");
    expect(pos).toEqual({ line: 9, ch: 0 });
  });

  it("positions at heading line end if ## 扩展 is the final line", () => {
    const cardContent = "Verbatim selection\n\n## 扩展";
    const pos = findPositionAfterHeading(cardContent, "## 扩展");
    expect(pos).toEqual({ line: 2, ch: 5 });
  });

  it("sets editor cursor and focuses editor", () => {
    let cursorSet: { line: number; ch: number } | null = null;
    let focused = false;

    const editor = {
      getValue: () => "# Note\n\n## 扩展\n\nTrailing line",
      setCursor: (p: { line: number; ch: number }) => {
        cursorSet = p;
      },
      focus: () => {
        focused = true;
      },
    };

    const success = positionCursorAfterExtensionHeading(editor);
    expect(success).toBe(true);
    expect(cursorSet).toEqual({ line: 3, ch: 0 });
    expect(focused).toBe(true);
  });
});

describe("9. Concurrency Guard and Freeze / Unfreeze Lifecycle", () => {
  it("blocks concurrent card creations and restores pointerEvents in finally", async () => {
    let unfreezeCalled = false;
    let cliResolve!: (val: CliRunResult) => void;
    const cliPromise = new Promise<CliRunResult>((resolve) => {
      cliResolve = resolve;
    });

    const client = {
      run: vi.fn(() => cliPromise),
    } as unknown as CliClient;

    const containerStyle = { pointerEvents: "auto" };
    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/test2024/Figure解读_test2024.md" },
      editor: {
        getSelection: () => "Text",
        getCursor: (which) =>
          which === "from" ? { line: 0, ch: 0 } : { line: 0, ch: 4 },
      },
      getMode: () => "source",
      containerEl: { style: containerStyle },
    };

    const showNotice = vi.fn();
    const ports: CardCreationServicePorts = {
      client,
      vaultRoot: "/vault",
      readBinary: async () => new TextEncoder().encode("Text here").buffer,
      saveView: async () => {},
      reloadSourceNote: vi.fn(),
      freezeEditor: (v) => {
        const prev = v.containerEl?.style.pointerEvents ?? "";
        if (v.containerEl) v.containerEl.style.pointerEvents = "none";
        return {
          unfreeze: () => {
            unfreezeCalled = true;
            if (v.containerEl) v.containerEl.style.pointerEvents = prev;
          },
        };
      },
      openCard: async () => ({
        editor: {
          getValue: () => "## 扩展\n",
          setCursor: () => {},
          focus: () => {},
        },
      }),
      showNotice,
    };

    const service = new CardCreationService(ports);

    // Start first run (in flight)
    const run1 = service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "First Card",
    });

    // Editor is frozen
    expect(containerStyle.pointerEvents).toBe("none");
    expect(service.isBusy()).toBe(true);

    // Attempt second concurrent run
    const run2 = await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Second Card",
    });

    // Second run rejected immediately
    expect(run2.ok).toBe(false);
    expect(showNotice).toHaveBeenCalledWith(
      expect.stringContaining("卡片创建正在进行中"),
    );

    // Resolve first run
    cliResolve({
      envelope: makeEnvelope("success", {
        path: "05 Literature/test2024/cards/card_1.md",
        anchor_status: "inserted",
      }),
      exitCode: 0,
      stderr: "",
    });

    const res1 = await run1;
    expect(res1.ok).toBe(true);

    // Unfrozen in finally
    expect(unfreezeCalled).toBe(true);
    expect(containerStyle.pointerEvents).toBe("auto");
    expect(service.isBusy()).toBe(false);
  });

  it("unfreezes editor even if CLI throws an unexpected error", async () => {
    let unfreezeCalled = false;
    const client = {
      run: vi.fn().mockRejectedValue(new Error("Process spawn failure")),
    } as unknown as CliClient;

    const mockView: CardCreationViewPort = {
      file: { path: "05 Literature/test2024/Figure解读_test2024.md" },
      editor: {
        getSelection: () => "Text",
        getCursor: (which) =>
          which === "from" ? { line: 0, ch: 0 } : { line: 0, ch: 4 },
      },
      getMode: () => "source",
      containerEl: { style: { pointerEvents: "auto" } },
    };

    const ports: CardCreationServicePorts = {
      client,
      vaultRoot: "/vault",
      readBinary: async () => new TextEncoder().encode("Text").buffer,
      saveView: async () => {},
      reloadSourceNote: vi.fn(),
      freezeEditor: () => ({
        unfreeze: () => {
          unfreezeCalled = true;
        },
      }),
      openCard: vi.fn(),
      showNotice: vi.fn(),
    };

    const service = new CardCreationService(ports);
    const res = await service.createCard({
      view: mockView,
      literatureRoot: "05 Literature",
      title: "Failure Card",
    });

    expect(res.ok).toBe(false);
    expect(unfreezeCalled).toBe(true);
    expect(service.isBusy()).toBe(false);
  });
});

describe("10. Plugin Command and Editor Menu Integration", () => {
  beforeEach(() => {
    resetRegistries();
  });

  function makePlugin(): PaperNotesPlugin {
    const app = {
      workspace: {
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: () => Promise.resolve(),
        on: vi.fn(() => ({})),
      },
      vault: {
        adapter: {
          getBasePath: () => "/test-vault",
          readBinary: async () => new ArrayBuffer(0),
        },
        getAbstractFileByPath: () => null,
      },
    } as never;

    const manifest = {
      id: "paper-notes",
      name: "Paper Notes",
      version: "1.0.0",
      minAppVersion: "1.4.0",
      description: "test fixture",
      isDesktopOnly: true,
    } as never;

    return new PaperNotesPlugin(app, manifest);
  }

  it("registers paper-notes-create-literature-card command on plugin load", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(registeredCommands).toContain(CREATE_LITERATURE_CARD_COMMAND);
    const cmd = registeredCommandObjects.find(
      (c) => c.id === CREATE_LITERATURE_CARD_COMMAND,
    );
    expect(cmd).toBeDefined();
    expect(cmd.hotkeys).toEqual([{ modifiers: ["Mod", "Shift"], key: "C" }]);
  });

  it("checks editorCheckCallback: validates Figure source, source mode, and selection", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const cmd = registeredCommandObjects.find(
      (c) => c.id === CREATE_LITERATURE_CARD_COMMAND,
    );
    expect(cmd).toBeDefined();
    const checkCb = cmd.editorCheckCallback;

    const editor = new Editor("Sample content");
    editor.setSelectionText("Selected");
    const view = new MarkdownView();
    view.file = new TFile("05 Literature/author2024/Figure解读_author2024.md");
    view.editor = editor;
    view.mode = "source";

    // 1. Valid: returns true
    expect(checkCb(true, editor, view)).toBe(true);

    // 2. Reading view: returns false
    view.mode = "preview";
    expect(checkCb(true, editor, view)).toBe(false);
    view.mode = "source";

    // 3. Not a Figure note: returns false
    view.file = new TFile("05 Literature/author2024/author2024.md");
    expect(checkCb(true, editor, view)).toBe(false);
    view.file = new TFile("05 Literature/author2024/Figure解读_author2024.md");

    // 4. Empty selection: returns false
    editor.setSelectionText("");
    expect(checkCb(true, editor, view)).toBe(false);
  });

  it("registers editor-menu event on plugin load and adds menu item for Figure note", async () => {
    let editorMenuCallback: any = null;
    const app = {
      workspace: {
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: () => Promise.resolve(),
        on: vi.fn((event: string, cb: any) => {
          if (event === "editor-menu") {
            editorMenuCallback = cb;
          }
          return {};
        }),
      },
      vault: {
        adapter: {
          getBasePath: () => "/test-vault",
          readBinary: async () => new ArrayBuffer(0),
        },
        getAbstractFileByPath: () => null,
      },
    } as never;

    const manifest = {
      id: "paper-notes",
      name: "Paper Notes",
      version: "1.0.0",
      minAppVersion: "1.4.0",
      description: "test fixture",
      isDesktopOnly: true,
    } as never;

    const plugin = new PaperNotesPlugin(app, manifest);
    await plugin.onload();

    expect(editorMenuCallback).not.toBeNull();

    const menu = new Menu();
    const editor = new Editor("Some note content");
    editor.setSelectionText("Selected passage");
    const view = new MarkdownView();
    view.file = new TFile("05 Literature/author2024/Figure解读_author2024.md");
    view.editor = editor;
    view.mode = "source";

    editorMenuCallback(menu, editor, view);

    expect(menu.items).toHaveLength(1);
    expect(menu.items[0].title).toBe("从选区创建 Literature Card");
  });

  it("surfaces notice when CLI is missing or read-only", async () => {
    const plugin = makePlugin();
    // Simulate read-only CLI
    (plugin as any).cliReadOnlyMode = true;

    const editor = new Editor("Sample");
    editor.setSelectionText("Selected");
    const view = new MarkdownView();
    view.file = new TFile("05 Literature/author2024/Figure解读_author2024.md");
    view.editor = editor;

    await plugin.createLiteratureCardFromEditor(view as any, editor as any);

    expect(recordedNotices).toContain(
      "paper-notes CLI 不可用或处于只读模式，无法创建卡片。",
    );
  });

  it("builds CLI arguments matching exact core protocol", () => {
    const args = cardCreateArgs({
      vaultRoot: "/vault/root",
      key: "alpha2024",
      title: "Conclusive Card Title",
      selectionFilePath: "/tmp/selection.txt",
      sourceNote: "Figure解读_alpha2024",
      sourceStartByte: 120,
      sourceEndByte: 350,
    });

    expect(args).toEqual([
      "card",
      "create",
      "--vault",
      "/vault/root",
      "--key",
      "alpha2024",
      "--title",
      "Conclusive Card Title",
      "--selection-file",
      "/tmp/selection.txt",
      "--source-note",
      "Figure解读_alpha2024",
      "--source-start-byte",
      "120",
      "--source-end-byte",
      "350",
    ]);

    // Ensure no shell strings, arguments are an array
    expect(Array.isArray(args)).toBe(true);
    // Exact mode must not include --backlink or --anchor-name
    expect(args).not.toContain("--backlink");
    expect(args).not.toContain("--anchor-name");
  });
});
