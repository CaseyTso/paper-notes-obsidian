/**
 * Mobile card-creation glue tests.
 *
 * Exercises the real mobile plugin command (`create-literature-card`) against
 * a fake vault, so the wiring — byte-offset mapping, anchor insertion, card
 * path/frontmatter, the `> 参见` line, the `## 扩展` cursor position — is
 * verified end to end without any Obsidian or Node API.
 *
 * The pure formatting primitives are covered in `tests/card-format.test.ts`;
 * what is asserted here is that the mobile command feeds them the right
 * inputs and applies their output to the vault correctly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./obsidian.mock"));

import type { App, PluginManifest } from "obsidian";
import PaperNotesMobilePlugin, {
  cardStemOf,
} from "../mobile/src/main";
import { registeredCommands, registeredCommandObjects, recordedNotices, resetRegistries } from "./obsidian.mock";
import { CardTitleModal } from "../mobile/src/modals/card-title-modal";

/**
 * Capture the `onSubmit` the plugin hands to the title modal, by stubbing
 * `open()` — the one method every modal must call to appear on screen.
 */
let capturedSubmit: ((title: string) => Promise<boolean>) | undefined;

function captureSubmit(): void {
  capturedSubmit = undefined;
  vi.spyOn(CardTitleModal.prototype, "open").mockImplementation(function open(
    this: CardTitleModal,
  ) {
    capturedSubmit = (this as unknown as {
      options: { onSubmit: (title: string) => Promise<boolean> };
    }).options.onSubmit;
    return undefined;
  });
}

/** The command fires and forgets, so let its microtasks drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && !capturedSubmit; i++) {
    await Promise.resolve();
  }
  await Promise.resolve();
  await Promise.resolve();
}

const KEY = "shiau2024";
const FIGURE_NOTE = `05 Literature/${KEY}/Figure解读_${KEY}.md`;
const MAIN_NOTE = `05 Literature/${KEY}/${KEY}.md`;
const CARD_PATH = `05 Literature/${KEY}/cards/card_多模态基准突破.md`;
const PAPER_ID = "11111111-2222-3333-4444-555555555555";
const SELECTION = "Figure 2 核心结论：模型超越基线 42.5% 🚀，表现出色！";

/** A tiny in-memory vault that records every mutation. */
class FakeVault {
  files = new Map<string, string>();
  created: string[] = [];
  createdFolders: string[] = [];
  modified: string[] = [];

  constructor(sourceText: string) {
    this.files.set(FIGURE_NOTE, sourceText);
    this.files.set(MAIN_NOTE, `---\npaper_id: ${PAPER_ID}\n---\n`);
  }

  getAbstractFileByPath(path: string): unknown {
    // Both notes live in this fake vault, so both resolve to a TFile-shaped
    // object; the two directories resolve to folders.
    if (this.files.has(path)) {
      return { path, name: path.split("/").pop() ?? "" };
    }
    if (path === `05 Literature/${KEY}` || path === `05 Literature/${KEY}/cards`) {
      return { path, children: [] };
    }
    return null;
  }

  async cachedRead(file: { path: string }): Promise<string> {
    const text = this.files.get(file.path);
    if (text === undefined) throw new Error(`not found: ${file.path}`);
    return text;
  }

  async read(file: { path: string }): Promise<string> {
    return this.cachedRead(file);
  }

  async create(path: string, data: string): Promise<unknown> {
    if (this.files.has(path)) throw new Error(`already exists: ${path}`);
    this.created.push(path);
    this.files.set(path, data);
    return { path };
  }

  async createFolder(path: string): Promise<unknown> {
    this.createdFolders.push(path);
    return { path };
  }

  async modify(file: { path: string }, data: string): Promise<void> {
    this.modified.push(file.path);
    this.files.set(file.path, data);
  }
}

function makeApp(vault: FakeVault): App {
  const opened: { path: string; cursor?: { line: number; ch: number } }[] = [];
  const app = {
    vault,
    workspace: {
      getLeaf: () => ({
        openFile: async (file: { path: string }) => {
          opened.push({ path: file.path });
          return undefined;
        },
        get view() {
          return {
            editor: {
              // Return the content of the note that was opened, so the cursor
              // positioning step sees the card it just created.
              getValue: () => vault.files.get(opened[opened.length - 1]?.path ?? "") ?? "",
              setCursor: (pos: { line: number; ch: number }) => {
                opened[opened.length - 1].cursor = pos;
              },
              focus: () => {},
            },
          };
        },
      }),
    },
    metadataCache: {
      // Read the canonical note's `paper_id` out of the fake vault, so a test
      // can put an uppercase UUID there and assert the plugin normalises it.
      getFileCache: (file: { path: string }) => {
        if (file.path === MAIN_NOTE) {
          const text = vault.files.get(MAIN_NOTE) ?? "";
          const m = /^paper_id:\s*(.+)$/m.exec(text);
          if (!m) return null;
          return { frontmatter: { paper_id: m[1].trim() } };
        }
        return null;
      },
    },
    fileManager: {
      processFrontMatter: async () => {},
    },
  } as unknown as App;
  (app as unknown as { __opened: typeof opened }).__opened = opened;
  return app;
}

/** Build the plugin with the editor context the command expects. */
function makePlugin(app: App): PaperNotesMobilePlugin {
  const manifest = {
    id: "paper-notes-mobile",
    name: "Paper Notes Mobile",
    version: "1.0.0",
    minAppVersion: "1.4.0",
    description: "test",
    isDesktopOnly: false,
  } as PluginManifest;
  return new PaperNotesMobilePlugin(app, manifest);
}

/** Editor stub that reports a selection inside `sourceText`. */
function makeEditor(sourceText: string, selection: string, expectPresent = true) {
  const start = sourceText.indexOf(selection);
  if (expectPresent) {
    expect(start).toBeGreaterThanOrEqual(0);
  }
  const before = sourceText.slice(0, start);
  const line = before.split("\n").length - 1;
  const ch = start - (before.lastIndexOf("\n") + 1);
  return {
    getSelection: () => selection,
    getCursor: (which: "from" | "to") =>
      which === "from" ? { line, ch } : { line, ch: ch + selection.length },
    getValue: () => sourceText,
    setCursor: () => {},
    focus: () => {},
    save: async () => {},
  };
}

describe("PaperNotesMobilePlugin — command registration", () => {
  beforeEach(() => {
    resetRegistries();
  });

  it("registers the reading-status and card-creation commands", async () => {
    await makePlugin(makeApp(new FakeVault("x"))).onload();
    expect(registeredCommands).toContain("cycle-reading-status");
    expect(registeredCommands).toContain("create-literature-card");
  });

  it("hides the card command for a non-Figure note", async () => {
    await makePlugin(makeApp(new FakeVault("x"))).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    const checking = command.editorCheckCallback(true, makeEditor("x", "x"), {
      file: { path: `05 Literature/${KEY}/${KEY}.md` },
      app: {},
    });
    expect(checking).toBe(false);
  });

  it("hides the card command when the selection is empty", async () => {
    await makePlugin(makeApp(new FakeVault("x"))).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    const checking = command.editorCheckCallback(true, makeEditor("x", ""), {
      file: { path: FIGURE_NOTE },
      app: {},
    });
    expect(checking).toBe(false);
  });
});

describe("PaperNotesMobilePlugin — create Literature Card from selection", () => {
  beforeEach(() => {
    resetRegistries();
    vi.restoreAllMocks();
    capturedSubmit = undefined;
  });

  it("writes the card, inserts the anchor, and opens the card at `## 扩展`", async () => {
    const sourceText = `# Figure 实验结果解读 🧬\n\n${SELECTION}\n\n## 讨论与展望 💡\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    // Intercept the title modal so the test can submit synchronously.
    captureSubmit();

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();

    expect(capturedSubmit).toBeDefined();
    const ok = await capturedSubmit!("多模态基准突破");
    expect(ok).toBe(true);

    // 1. The card exists at the CLI's exact vault-relative POSIX path.
    expect(vault.created).toEqual([CARD_PATH]);
    const card = vault.files.get(CARD_PATH)!;

    // 2. Frontmatter: three fields, `paper` quoted.
    expect(card.startsWith(
      "---\n" +
        `paper_id: ${PAPER_ID}\n` +
        `citation_key: ${KEY}\n` +
        `paper: "[[${KEY}]]"\n` +
        "---\n\n",
    )).toBe(true);

    const anchor = /card-[0-9a-f]{16}/.exec(card)![0];
    expect(anchor).toMatch(/^card-[0-9a-f]{16}$/);

    // 3. Verbatim selection, the `> 参见` backlink, and the trailing heading.
    expect(card).toContain(SELECTION);
    expect(card).toContain("> 参见 [[Figure解读_" + KEY + "#^");
    const expectedSuffix =
      `${SELECTION}\n\n` +
      `> 参见 [[Figure解读_${KEY}#^${anchor}|Figure解读_${KEY}]]\n\n` +
      `## 扩展\n`;
    expect(card.endsWith(expectedSuffix)).toBe(true);

    // 4. The source note got `^<anchor>` appended to the selection's line,
    //    and nothing else changed.
    const updated = vault.files.get(FIGURE_NOTE)!;
    expect(updated).toBe(sourceText.replace(SELECTION, `${SELECTION} ^${anchor}`));
    expect(vault.modified).toEqual([FIGURE_NOTE]);

    // 5. The card was opened with the cursor on the line after `## 扩展`.
    const opened = (app as unknown as {
      __opened: { path: string; cursor?: { line: number; ch: number } }[];
    }).__opened;
    expect(opened).toHaveLength(1);
    expect(opened[0].path).toBe(CARD_PATH);
    const headingLine = card.split("\n").findIndex((l) => l.trim() === "## 扩展");
    expect(opened[0].cursor).toEqual({ line: headingLine + 1, ch: 0 });

    // 6. No dead-link warning: the anchor was inserted.
    expect(recordedNotices.some((n) => n.includes("未插入锚点"))).toBe(false);
  });

  it("keeps CRLF notes on CRLF when inserting the anchor", async () => {
    const sourceText = `# Figure 🧬\r\n\r\n${SELECTION}\r\n\r\n## 讨论\r\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    await capturedSubmit!("CRLF 卡片");

    const updated = vault.files.get(FIGURE_NOTE)!;
    // The only change is the appended anchor; every CRLF survives.
    const anchor = /card-[0-9a-f]{16}/.exec(
      vault.files.get(`05 Literature/${KEY}/cards/card_CRLF_卡片.md`)!,
    )![0];
    expect(updated).toBe(sourceText.replace(SELECTION, `${SELECTION} ^${anchor}`));
  });

  it("writes the card without a `> 参见` line when the anchor cannot be inserted", async () => {
    // The selection sits inside an unclosed fenced code block: the CLI fails
    // closed, so the card must not carry a dead link.
    const sourceText = `# Figure 🧬\n\n\`\`\`\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    const ok = await capturedSubmit!("失败锚点卡片");
    expect(ok).toBe(true);

    const card = vault.files.get(`05 Literature/${KEY}/cards/card_失败锚点卡片.md`)!;
    expect(card).toContain(SELECTION);
    expect(card).not.toContain("参见");
    expect(card).not.toContain(`[[Figure解读_${KEY}`);
    // The source note was left byte-for-byte untouched.
    expect(vault.files.get(FIGURE_NOTE)).toBe(sourceText);
    expect(vault.modified).toEqual([]);
    // The user is told the anchor was skipped.
    expect(recordedNotices.some((n) => n.includes("未插入锚点"))).toBe(true);
  });

  it("refuses to overwrite an existing card", async () => {
    const sourceText = `# Figure 🧬\n\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    vault.files.set(CARD_PATH, "existing card\n");
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    const ok = await capturedSubmit!("多模态基准突破");

    expect(ok).toBe(false);
    expect(vault.files.get(CARD_PATH)).toBe("existing card\n");
    expect(vault.modified).toEqual([]);
    expect(recordedNotices.some((n) => n.includes("卡片已存在"))).toBe(true);
  });

  it("rejects the command when the paper_id is missing", async () => {
    const sourceText = `# Figure 🧬\n\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    // Remove the canonical note so no paper_id can be resolved.
    vault.files.delete(MAIN_NOTE);
    const editor = makeEditor(sourceText, SELECTION);

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();

    expect(vault.created).toEqual([]);
    expect(recordedNotices.some((n) => n.includes("paper_id"))).toBe(true);
  });

  it("reports a mapping failure without writing anything when the selection moved", async () => {
    const sourceText = `# Figure 🧬\n\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    // Editor reports a selection that no longer matches the file on disk.
    const editor = makeEditor("something else entirely\n", SELECTION, false);

    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();

    expect(vault.created).toEqual([]);
    expect(vault.modified).toEqual([]);
    expect(recordedNotices.some((n) => n.includes("选区映射失败"))).toBe(true);
  });

  it("fails closed when the source note changes while the title modal is open (Finding 1)", async () => {
    const sourceText = `# Figure \U0001f9ec\n\n${SELECTION}\n\n## \u8ba8\u8bba\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();
    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    expect(capturedSubmit).toBeDefined();

    // The user edits the note while the title modal is open: the selection's
    // bytes are gone, so the CLI would report "source text at byte range does
    // not match selection" (`cards.py:2234-2239`). The mobile writer must reach
    // the same outcome without touching the source note.
    vault.files.set(FIGURE_NOTE, `# Figure \U0001f9ec\n\n\u5b8c\u5168\u4e0d\u540c\u7684\u5185\u5bb9\n`);

    const ok = await capturedSubmit!("\u5f39\u7a97\u671f\u95f4\u6539\u52a8");
    expect(ok).toBe(true);

    // The card is still created (the CLI does the same) but without a backlink.
    const card = vault.files.get(`05 Literature/${KEY}/cards/card_弹窗期间改动.md`);
    expect(card).toBeDefined();
    expect(card).toContain(SELECTION);
    expect(card).not.toContain("\u53c2\u89c1");
    expect(card).not.toContain(`[[Figure\u89e3\u8bfb_${KEY}`);

    // Zero source writes: the note keeps exactly what the user typed.
    expect(vault.modified).toEqual([]);
    expect(vault.files.get(FIGURE_NOTE)).toBe(
      `# Figure \U0001f9ec\n\n\u5b8c\u5168\u4e0d\u540c\u7684\u5185\u5bb9\n`,
    );
    // And the user is told the anchor was skipped.
    expect(
      recordedNotices.some((n) => n.includes("\u53d8\u5316") && n.includes("\u6b7b\u94fe")),
    ).toBe(true);
  });

  it("preserves a leading BOM when writing the anchor back (Finding 4)", async () => {
    // A BOM-prefixed note: the anchor write-back must keep all three bytes, or
    // the CLI's "revert restores the exact byte stream" invariant breaks.
    const sourceText = `\ufeff# Figure \U0001f9ec\n\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();
    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    await capturedSubmit!("BOM \u5361\u7247");

    const after = vault.files.get(FIGURE_NOTE)!;
    expect(after.startsWith("\ufeff")).toBe(true);
    const anchor = /card-[0-9a-f]{16}/.exec(
      vault.files.get(`05 Literature/${KEY}/cards/card_BOM_卡片.md`)!,
    )![0];
    // Only the anchor was appended; the BOM and every other byte survive.
    expect(after).toBe(sourceText.replace(SELECTION, `${SELECTION} ^${anchor}`));
  });

  it("lowercases paper_id from the canonical note (Finding 5)", async () => {
    const sourceText = `# Figure \U0001f9ec\n\n${SELECTION}\n`;
    const vault = new FakeVault(sourceText);
    const app = makeApp(vault);
    // An uppercase UUID in frontmatter, as pydantic would canonicalise.
    vault.files.set(
      MAIN_NOTE,
      `---\npaper_id: 1B4E28BA-2FA1-4DCF-9E0C-8B0A6E4C7A11\n---\n`,
    );
    const editor = makeEditor(sourceText, SELECTION);

    captureSubmit();
    await makePlugin(app).onload();
    const command = registeredCommandObjects.find((c) => c.id === "create-literature-card");
    await command.editorCheckCallback(false, editor, { file: { path: FIGURE_NOTE }, app });
    await settle();
    await capturedSubmit!("\u5927\u5199 UUID \u5361\u7247");

    const card = vault.files.get(`05 Literature/${KEY}/cards/card_大写_UUID_卡片.md`)!;
    expect(card).toContain("paper_id: 1b4e28ba-2fa1-4dcf-9e0c-8b0a6e4c7a11");
    expect(card).not.toContain("1B4E28BA");
  });
});

describe("cardStemOf", () => {
  it("is the filename the CLI derives the anchor hash from", () => {
    expect(cardStemOf(KEY, "多模态基准突破")).toBe("card_多模态基准突破");
    expect(cardStemOf(KEY, "a/b")).toBe("card_a_b");
  });
});
