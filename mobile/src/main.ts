/**
 * Paper Notes Mobile — companion plugin (ADR 0006 / 0007).
 *
 * Mobile is a **second, separate plugin** in this monorepo. It shares only the
 * read-only data layer under `src/shared/` and never imports any desktop code
 * (`src/services/`, `src/views/`, `src/modals/`) or Node/Electron API — those
 * cannot run on Obsidian Mobile.
 *
 * Per ADR 0007 the mobile plugin is **exempt from the CLI-sole-writer rule**:
 * writes go straight through Obsidian's vault API (`vault.create` /
 * `vault.modify`), while the desktop plugin keeps routing every managed write
 * through the `paper-notes` CLI. The format contract that keeps the two
 * writers byte-identical lives in `src/shared/card-format.ts`.
 *
 * Scope: reading a Figure Interpretation Note, creating a Literature Card from
 * a selection, and cycling Reading Status. It does not read PDFs, export, run
 * MinerU, or use the Browser Connector.
 */

import {
  Editor,
  Notice,
  Plugin,
  type MarkdownFileInfo,
  type MetadataCache,
  type TAbstractFile,
  type TFile,
} from "obsidian";

import {
  applyAnchorInsertion,
  buildAnchorInsertion,
  cardAnchorLink,
  cardAnchorName,
  cardRelativePath,
  computeSelectionByteOffsets,
  findPositionAfterHeading,
  formatCardContent,
  LITERATURE_ROOT,
  parseFigureSource,
  type FigureSourceInfo,
} from "../../src/shared/card-format";
import {
  nextReadingStatus,
  readingStatusOf,
  type ReadingStatus,
} from "../../src/shared/library-table";
import { CardTitleModal } from "./modals/card-title-modal";

/**
 * Command ids must stay stable: they are what the user can bind hotkeys to.
 */
const CYCLE_READING_STATUS_COMMAND = "cycle-reading-status";
const CREATE_LITERATURE_CARD_COMMAND = "create-literature-card";

/** The trailing heading every card carries; the cursor lands right after it. */
const EXTENSION_HEADING = "## 扩展";

/** `paper_id` must be a well-formed UUID, exactly as the CLI requires. */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Minimal vault surface the card creation flow depends on. */
interface CardVault {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  cachedRead(file: TFile): Promise<string>;
  read(file: TFile): Promise<string>;
  create(path: string, data: string): Promise<TFile>;
  createFolder(path: string): Promise<unknown>;
  modify(file: TFile, data: string): Promise<void>;
}

/** Minimal workspace / leaf surface used to open the new card. */
interface CardLeaf {
  openFile?: (file: TFile) => Promise<void>;
  view?: { editor?: Editor };
}

interface CardWorkspace {
  getLeaf(newLeaf?: boolean | "tab" | "split"): CardLeaf;
}

/** Minimal metadata-cache surface the card creation flow depends on. */
interface CardMetadataCache {
  getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null;
}

/**
 * Reading status of the active note, read from Obsidian's frontmatter cache.
 *
 * Uses the shared normalizer so an unknown / missing value is treated exactly
 * like the desktop plugin treats it (missing → `unread`).
 */
function currentReadingStatusOf(file: TFile, cache: MetadataCache): ReadingStatus | undefined {
  return readingStatusOf(cache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined);
}

export default class PaperNotesMobilePlugin extends Plugin {
  async onload(): Promise<void> {
    // Reading Status cycle. The `icon` lets mobile users pin this command to the
    // editor toolbar (Settings → Mobile → Manage toolbar), giving a one-tap
    // trigger without opening the command palette. `editorCallback` gates the
    // command on there being an active Markdown note and gives us its file.
    this.addCommand({
      id: CYCLE_READING_STATUS_COMMAND,
      name: "Cycle reading status (unread → reading → read)",
      icon: "book-open-check",
      editorCallback: (_editor: Editor, ctx: MarkdownFileInfo) => {
        void this.cycleReadingStatus(ctx.file);
      },
    });

    // Create Literature Card from selection. Same toolbar story: the `icon`
    // makes it pinnable on mobile. `editorCheckCallback` hides the command
    // unless the active note is a Figure Interpretation Note with a non-empty
    // selection, mirroring the desktop plugin's gating.
    this.addCommand({
      id: CREATE_LITERATURE_CARD_COMMAND,
      name: "Create Literature Card from selection",
      icon: "scissors",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const file = ctx.file;
        if (!file) {
          return false;
        }
        const figureInfo = parseFigureSource(file.path, LITERATURE_ROOT);
        if (!figureInfo) {
          return false;
        }
        const selection = editor.getSelection();
        if (!selection || selection.trim().length === 0) {
          return false;
        }
        if (!checking) {
          void this.createLiteratureCardFromSelection(ctx, editor, figureInfo, selection);
        }
        return true;
      },
    });

    // Ribbon (left-sidebar) entries as a second, always-visible trigger. On
    // mobile the ribbon lives behind the left drawer; the toolbar-pinned command
    // icons above are the primary one-tap path.
    this.addRibbonIcon("book-open-check", "Cycle reading status", () => {
      void this.runCommandOnActiveEditor(CYCLE_READING_STATUS_COMMAND);
    });
    this.addRibbonIcon("scissors", "Create Literature Card from selection", () => {
      void this.runCommandOnActiveEditor(CREATE_LITERATURE_CARD_COMMAND);
    });
  }

  /**
   * Re-dispatch a registered editor command against the active editor, so the
   * ribbon icon behaves exactly like the toolbar/command-palette entry. Returns
   * without notice when no Markdown editor is active (the command's own gating
   * still applies for the card command).
   */
  private runCommandOnActiveEditor(commandId: string): void {
    const info = this.app.workspace.activeEditor;
    const file = info?.file;
    const editor = info?.editor;
    if (!file || !editor) {
      new Notice("请先打开一篇 Markdown 笔记。");
      return;
    }
    if (commandId === CYCLE_READING_STATUS_COMMAND) {
      void this.cycleReadingStatus(file);
      return;
    }
    // Card command: apply the same gating as the editorCheckCallback.
    const figureInfo = parseFigureSource(file.path, LITERATURE_ROOT);
    const selection = editor.getSelection();
    if (!figureInfo) {
      new Notice("当前笔记不是 Figure 解读笔记（路径不匹配）。");
      return;
    }
    if (!selection || selection.trim().length === 0) {
      new Notice("请先选择需要创建卡片的文本。");
      return;
    }
    void this.createLiteratureCardFromSelection(
      { file } as MarkdownFileInfo,
      editor,
      figureInfo,
      selection,
    );
  }

  /**
   * Advance the active note's `reading_status` one step around the shared
   * cycle and write it back through the vault API (ADR 0007 exemption).
   *
   * Never throws into the command dispatcher: failures surface as a Notice.
   */
  private async cycleReadingStatus(file: TFile | null): Promise<void> {
    if (!file) {
      new Notice("Paper Notes Mobile: no active note.");
      return;
    }
    const next = nextReadingStatus(currentReadingStatusOf(file, this.app.metadataCache));
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["reading_status"] = next;
      });
    } catch (error) {
      new Notice(
        `Paper Notes Mobile: could not update reading status (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    new Notice(`Reading status → ${next}`);
  }

  /**
   * Create a Literature Card from the current selection (ADR 0007 exemption).
   *
   * The desktop plugin saves the editor, shells out to the CLI and lets the
   * CLI insert the anchor. On mobile there is no CLI, so the whole flow is
   * re-implemented here against the vault API — but every formatting decision
   * is delegated to `src/shared/card-format.ts`, which the CLI is held to
   * byte-for-byte by `tests/core-contract.integration.test.ts`.
   *
   * Never throws into the command dispatcher: every failure surfaces as a
   * Notice. When the anchor cannot be inserted the card is still written, but
   * without its `> 参见` line, so no dead link is ever created.
   */
  private async createLiteratureCardFromSelection(
    ctx: MarkdownFileInfo,
    editor: Editor,
    figureInfo: FigureSourceInfo,
    selection: string,
  ): Promise<void> {
    const key = figureInfo.key;
    const from = this.cursorOf(editor, "from");
    const to = this.cursorOf(editor, "to");

    // Flush the editor buffer so the on-disk bytes match what the user
    // selected; the byte offsets are only meaningful against saved content.
    // On mobile the view is the only thing that owns `save()`.
    const view = ctx as unknown as { save?: () => Promise<void> };
    if (typeof view.save === "function") {
      try {
        await view.save();
      } catch {
        // A failed save is not fatal: the vault read below is still the best
        // available snapshot, and the selection check catches a real mismatch.
      }
    }

    const file = ctx.file;
    if (!file) {
      new Notice("未找到当前笔记文件。");
      return;
    }

    const savedText = await this.readSourceText(file);
    if (savedText === null) {
      new Notice("无法读取源笔记内容，卡片创建已终止。");
      return;
    }

    let range;
    try {
      range = computeSelectionByteOffsets(savedText, from, to, selection);
    } catch (error) {
      new Notice(
        `选区映射失败，未创建卡片：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const paperId = this.paperIdOf(key);
    if (!paperId) {
      new Notice(`未找到 ${key} 的 paper_id，无法创建卡片。`);
      return;
    }

    const modal = new CardTitleModal(this.app, {
      excerpt: selection,
      onSubmit: async (title) => {
        if (!title) {
          return false;
        }
        try {
          return await this.writeLiteratureCard({
            key,
            paperId,
            title,
            sourceFile: file,
            savedText,
            range,
          });
        } catch (error) {
          new Notice(
            `创建卡片异常：${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      },
    });
    modal.open();
  }

  /**
   * Write the card note, insert its anchor into the source note, and open the
   * card with the cursor parked after `## 扩展`.
   *
   * Returns `true` when the card was written (the modal then closes), `false`
   * when it failed (the modal stays open so the title can be edited).
   */
  private async writeLiteratureCard(params: {
    key: string;
    paperId: string;
    title: string;
    sourceFile: TFile;
    savedText: string;
    range: {
      startByte: number;
      endByte: number;
      selectionText: string;
      selectionBytes: Uint8Array;
    };
  }): Promise<boolean> {
    const { key, paperId, title, sourceFile, savedText, range } = params;
    const vault = this.app.vault as unknown as CardVault;

    // Re-read the note: the user may have edited it while the modal was open,
    // and the anchor must be inserted against the bytes that are on disk now.
    const currentText = await this.readSourceText(sourceFile);
    const effectiveText = currentText ?? savedText;
    const effectiveBytes = new TextEncoder().encode(effectiveText);

    // Re-verify the byte range against the fresh bytes, exactly as the CLI
    // does before it plans any write (`cards.py:2229-2239`): the range must be
    // in bounds AND still contain the very bytes that were selected. If the
    // note changed underneath the modal, fail closed — zero source writes, and
    // the card is written without its `> 参见` line so no dead link is created.
    const stale =
      range.endByte > effectiveBytes.length ||
      range.startByte >= range.endByte ||
      !bytesEqual(
        effectiveBytes.subarray(range.startByte, range.endByte),
        range.selectionBytes,
      );
    if (stale) {
      new Notice("源笔记在输入标题期间发生变化，未插入锚点（已避免死链）。");
    }

    const anchorName = await cardAnchorName(cardStemOf(key, title));
    const plan = stale
      ? {
          status: "failed" as const,
          reason: "source note changed while the title was entered; anchor not inserted",
          newline: "\n" as const,
          insertByte: null,
          insertBytes: null,
        }
      : buildAnchorInsertion(effectiveBytes, range.startByte, range.endByte, anchorName);

    if (plan.status === "failed") {
      new Notice(`卡片提示：${plan.reason ?? "anchor not inserted"}`);
    }

    // A `failed` anchor must never produce a backlink, so the card has no dead
    // link to a block that was not annotated.
    const anchorLink = plan.status === "failed" ? null : cardAnchorLink(key, anchorName);
    const content = formatCardContent({
      paperId,
      citationKey: key,
      selection: range.selectionText,
      anchorLink,
    });

    const cardPath = cardRelativePath(key, title);
    if (vault.getAbstractFileByPath(cardPath)) {
      new Notice(`卡片已存在：${title}`);
      return false;
    }

    const cardsDir = `${LITERATURE_ROOT}/${key}/cards`;
    if (!vault.getAbstractFileByPath(cardsDir)) {
      try {
        await vault.createFolder(cardsDir);
      } catch (error) {
        // A race with another writer (or an already-created folder) is benign.
        if (!/exist/i.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      }
    }

    // Anchor first: if the source write fails, no card exists to link to it.
    if (plan.status === "inserted" && plan.insertByte !== null && plan.insertBytes) {
      const nextBytes = applyAnchorInsertion(effectiveBytes, plan.insertByte, plan.insertBytes);
      // `ignoreBOM: true` keeps a leading BOM in the text handed to
      // `vault.modify`. The default decoder strips it, which would silently
      // rewrite the note's first three bytes and break the CLI's "reverting the
      // anchor restores the exact original byte stream" invariant
      // (core-contract.integration.test.ts).
      const nextText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(nextBytes);
      await vault.modify(sourceFile, nextText);
    }

    const cardFile = await vault.create(cardPath, content);
    await this.openCardAtExtension(cardFile);

    if (plan.status === "failed") {
      new Notice("卡片创建成功，但源笔记未插入锚点（已避免死链）。");
    } else if (plan.status === "existing") {
      new Notice(`已创建卡片：${title}（锚点已存在）`);
    } else {
      new Notice(`已创建卡片：${title}`);
    }
    return true;
  }

  /**
   * Open the new card in a leaf and place the cursor right after `## 扩展`,
   * so the user can start typing their notes immediately.
   */
  private async openCardAtExtension(cardFile: TFile): Promise<void> {
    const workspace = this.app.workspace as unknown as CardWorkspace;
    const leaf = workspace.getLeaf?.("tab");
    await leaf?.openFile?.(cardFile);
    const editor = leaf?.view?.editor;
    if (!editor) {
      return;
    }
    const position = findPositionAfterHeading(editor.getValue(), EXTENSION_HEADING);
    if (position) {
      editor.setCursor(position);
      editor.focus();
    }
  }

  /**
   * Read the note's current text through the vault API.
   *
   * `cachedRead` is preferred: on mobile it is served from the local index and
   * is the same read path that stays consistent with what `vault.modify`
   * writes. `vault.read` is the fallback for a file the index has not picked
   * up yet. Neither needs `getBasePath()`, a temp file, or any Node API.
   */
  private async readSourceText(file: TFile): Promise<string | null> {
    const vault = this.app.vault as unknown as CardVault;
    try {
      return await vault.cachedRead(file);
    } catch {
      // fall through to the direct read
    }
    try {
      return await vault.read(file);
    } catch {
      return null;
    }
  }

  /**
   * The paper's UUID from the canonical note's frontmatter — the same value the
   * CLI writes into `paper_id`.
   *
   * Normalised to lowercase: the CLI resolves the key through a pydantic UUID
   * field, which canonicalises to the lowercase hyphenated form. An uppercase
   * UUID in frontmatter would otherwise make a mobile-written card differ
   * byte-for-byte from a CLI-written one.
   */
  private paperIdOf(key: string): string | undefined {
    const file = this.app.vault.getAbstractFileByPath(`${LITERATURE_ROOT}/${key}/${key}.md`);
    if (!file) {
      return undefined;
    }
    const frontmatter = (this.app.metadataCache as unknown as CardMetadataCache)
      .getFileCache(file as TFile)?.frontmatter;
    const value = frontmatter?.paper_id;
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      return undefined;
    }
    return value.toLowerCase();
  }

  /**
   * Editor cursor, tolerating editors that only expose one of the two names.
   * `editorCallback` always provides an `Editor`, so this is defensive only.
   */
  private cursorOf(editor: Editor, which: "from" | "to"): { line: number; ch: number } {
    const getCursor = editor.getCursor as unknown as (
      w: "from" | "to" | "head" | "anchor",
    ) => { line: number; ch: number };
    return getCursor.call(editor, which);
  }
}

/** Byte-for-byte comparison, used to re-verify a selection after a re-read. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The card stem for a title, i.e. the value whose SHA-256 names the anchor:
 * `card_<slug(title)>`.
 */
export function cardStemOf(key: string, title: string): string {
  return cardRelativePath(key, title).replace(/^.*\//, "").replace(/\.md$/, "");
}
