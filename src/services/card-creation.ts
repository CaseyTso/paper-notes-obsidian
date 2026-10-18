/**
 * Literature Card creation service (Card Selection feature).
 *
 * Implements exact byte range Literature Card creation from Figure interpretation
 * notes (Figure解读_<key>.md) via the core CLI `card create` command.
 *
 * Responsibilities:
 * - Strict source note identification: matches `${literatureRoot}/<key>/Figure解读_<key>.md`.
 * - View mode enforcement: Source Mode or Live Preview only; Reading View rejected.
 * - Selection capture & post-save UTF-8 byte range mapping:
 *   Awaits MarkdownView.save() to flush editor buffer to disk, reads saved binary
 *   bytes, verifies the selection is still present, and computes exact UTF-8 byte
 *   offsets [startByte, endByte).
 * - Freeze & concurrency lock: prevents concurrent card creation in the same plugin
 *   and source note editor interaction during execution; unfreezes in finally.
 * - Sole writer: never calls vault.create directly; all mutations happen via CLI.
 * - Post-creation: reloads source note to reflect the newly inserted anchor, opens the
 *   card in a new leaf/tab in the current pane, and positions cursor after `## 扩展`.
 * - Handles warnings and anchor failure (`anchor_status === "failed"`) cleanly
 *   without dead links.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CliClient } from "./cli-client";
import type { ProtocolEnvelope } from "../types/protocol";

// The pure format primitives live in `src/shared/card-format.ts` so the mobile
// companion plugin can reuse them without importing this Node-dependent
// service (ADR 0006 / 0007). They are re-exported here so every existing
// importer of `card-creation` keeps working unchanged.
import {
  CITATION_KEY_RE,
  computeSelectionByteOffsets,
  findPositionAfterHeading,
  parseFigureSource,
  type SelectionRangeResult,
} from "../shared/card-format";

export {
  CITATION_KEY_RE,
  computeSelectionByteOffsets,
  findPositionAfterHeading,
  parseFigureSource,
};
export type { SelectionRangeResult };
export type { FigureSourceInfo } from "../shared/card-format";

/**
 * Check if the active view is in Source Mode or Live Preview.
 * Reading View ('preview') is rejected.
 */
export function isSourceOrLivePreview(view: {
  getMode?(): string;
  getState?(): Record<string, unknown>;
}): boolean {
  if (typeof view.getMode === "function") {
    const mode = view.getMode();
    if (mode === "preview") {
      return false;
    }
    if (mode === "source") {
      return true;
    }
  }
  if (typeof view.getState === "function") {
    const state = view.getState();
    if (state && typeof state === "object") {
      const mode = (state as { mode?: unknown }).mode;
      if (mode === "preview") {
        return false;
      }
      if (mode === "source") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Position editor cursor after `## 扩展` and focus the editor.
 */
export function positionCursorAfterExtensionHeading(editor: {
  getValue(): string;
  setCursor(pos: { line: number; ch: number }): void;
  focus(): void;
}): boolean {
  const content = editor.getValue();
  const pos = findPositionAfterHeading(content, "## 扩展");
  if (pos) {
    editor.setCursor(pos);
    editor.focus();
    return true;
  }
  return false;
}

export function cardCreateArgs(options: {
  vaultRoot: string;
  key: string;
  title: string;
  selectionFilePath: string;
  sourceNote: string;
  sourceStartByte: number;
  sourceEndByte: number;
}): string[] {
  return [
    "card",
    "create",
    "--vault",
    options.vaultRoot,
    "--key",
    options.key,
    "--title",
    options.title,
    "--selection-file",
    options.selectionFilePath,
    "--source-note",
    options.sourceNote,
    "--source-start-byte",
    String(options.sourceStartByte),
    "--source-end-byte",
    String(options.sourceEndByte),
  ];
}

export interface CardCreateResultData {
  citation_key: string;
  paper_id: string;
  path: string;
  stem: string;
  anchor_name: string;
  anchor_status: "inserted" | "existing" | "failed";
  anchor_inserted: boolean;
  anchor_link: string | null;
  backlink_inserted: boolean;
}

export interface CardCreationEditorPort {
  getSelection(): string;
  getCursor(which: "from" | "to"): { line: number; ch: number };
  getValue?(): string;
  setCursor?(pos: { line: number; ch: number }): void;
  focus?(): void;
}

export interface CardCreationViewPort {
  file: { path: string } | null;
  editor: CardCreationEditorPort | null;
  getMode?(): string;
  getState?(): Record<string, unknown>;
  save?(): Promise<void>;
  containerEl?: { style: { pointerEvents: string } };
  leaf?: unknown;
}

export interface TempFileHandle {
  path: string;
  cleanup: () => Promise<void>;
}

export interface CardCreationServicePorts {
  client: CliClient;
  vaultRoot: string;
  readBinary(path: string): Promise<ArrayBuffer>;
  saveView(view: CardCreationViewPort): Promise<void>;
  reloadSourceNote(view: CardCreationViewPort, path: string): Promise<void>;
  freezeEditor(view: CardCreationViewPort): { unfreeze: () => void };
  openCard(path: string): Promise<{ editor?: { getValue(): string; setCursor(pos: { line: number; ch: number }): void; focus(): void } }>;
  showNotice(message: string, duration?: number): void;
  writeTempFile?(content: Uint8Array): Promise<TempFileHandle>;
}

export async function defaultWriteTempFile(content: Uint8Array): Promise<TempFileHandle> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-notes-card-"));
  const tempPath = path.join(tempDir, "selection.txt");
  await fs.writeFile(tempPath, content);
  return {
    path: tempPath,
    cleanup: async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    },
  };
}

export function defaultFreezeEditor(view: CardCreationViewPort): { unfreeze: () => void } {
  const container = view.containerEl;
  let prev = "";
  if (container) {
    prev = container.style.pointerEvents;
    container.style.pointerEvents = "none";
  }
  return {
    unfreeze: () => {
      if (container) {
        container.style.pointerEvents = prev;
      }
    },
  };
}

export class CardCreationService {
  private busy = false;

  constructor(private readonly ports: CardCreationServicePorts) {}

  isBusy(): boolean {
    return this.busy;
  }

  async createCard(params: {
    view: CardCreationViewPort;
    literatureRoot: string;
    title: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; data?: CardCreateResultData; error?: string }> {
    if (this.busy) {
      const msg = "卡片创建正在进行中，请稍候。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    const { view, literatureRoot, title, signal } = params;
    const file = view.file;
    if (!file) {
      const msg = "未找到当前文件。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    // 1. Strict figure source check
    const figureInfo = parseFigureSource(file.path, literatureRoot);
    if (!figureInfo) {
      const msg = "当前笔记不是 Figure 解读笔记（路径不匹配）。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    // 2. View mode check
    if (!isSourceOrLivePreview(view)) {
      const msg = "仅在源码模式或实时预览模式下可用，阅读视图不支持创建卡片。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    // 3. Selection existence check
    const editor = view.editor;
    if (!editor) {
      const msg = "无法获取当前编辑器。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    const editorSelection = editor.getSelection();
    if (!editorSelection || editorSelection.trim().length === 0) {
      const msg = "请先选择需要创建卡片的文本。";
      this.ports.showNotice(msg);
      return { ok: false, error: msg };
    }

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");

    // Acquire concurrency lock and freeze editor interaction
    this.busy = true;
    const freezeHandle = this.ports.freezeEditor(view);
    let tempFile: TempFileHandle | undefined;

    try {
      // 4. Save view first
      try {
        await this.ports.saveView(view);
      } catch (error) {
        const msg = `保存笔记失败，卡片创建已终止：${error instanceof Error ? error.message : String(error)}`;
        this.ports.showNotice(msg);
        return { ok: false, error: msg };
      }

      // 5. Read saved binary bytes and compute exact UTF-8 byte offsets
      let range: SelectionRangeResult;
      try {
        const arrayBuffer = await this.ports.readBinary(file.path);
        const savedBytes = new Uint8Array(arrayBuffer);
        // `ignoreBOM: true` keeps a leading BOM in the decoded text. The CLI
        // reads the note as raw bytes and keeps it too, so stripping it here
        // would shift every computed byte offset by three and make the CLI
        // reject the range as "does not match selection". `fatal` is retained:
        // it still rejects invalid UTF-8, which is a different, wanted error.
        const savedText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          savedBytes,
        );
        range = computeSelectionByteOffsets(savedText, from, to, editorSelection);
      } catch (error) {
        const msg = `选区映射失败，未调用核心命令：${error instanceof Error ? error.message : String(error)}`;
        this.ports.showNotice(msg);
        return { ok: false, error: msg };
      }

      // 6. Write temp selection file
      const writeTemp = this.ports.writeTempFile ?? defaultWriteTempFile;
      tempFile = await writeTemp(range.selectionBytes);

      // 7. Execute CLI card create
      const args = cardCreateArgs({
        vaultRoot: this.ports.vaultRoot,
        key: figureInfo.key,
        title,
        selectionFilePath: tempFile.path,
        sourceNote: figureInfo.sourceNote,
        sourceStartByte: range.startByte,
        sourceEndByte: range.endByte,
      });

      const runResult = await this.ports.client.run(args, { signal });
      const envelope = runResult.envelope as ProtocolEnvelope;

      if (envelope.status !== "success") {
        const errorMsg = envelope.errors.map((e) => e.message).join("; ") || "核心命令执行失败。";
        this.ports.showNotice(`创建卡片失败：${errorMsg}`);
        return { ok: false, error: errorMsg };
      }

      const data = envelope.data as unknown as CardCreateResultData;

      // 8. Reload source note so the inserted anchor is rendered
      try {
        await this.ports.reloadSourceNote(view, file.path);
      } catch {
        // reload error should not abort opening the card
      }

      // 9. Open card in new tab (vault-relative POSIX path directly from data.path)
      const opened = await this.ports.openCard(data.path);
      if (opened.editor) {
        positionCursorAfterExtensionHeading(opened.editor);
      }

      // 10. Handle notices and warnings
      if (envelope.warnings && envelope.warnings.length > 0) {
        for (const w of envelope.warnings) {
          this.ports.showNotice(`卡片提示：${w.message}`);
        }
      }

      if (data.anchor_status === "failed") {
        this.ports.showNotice("卡片创建成功，但源笔记未插入锚点（已避免死链）。");
      } else {
        this.ports.showNotice(`已创建卡片：${title}`);
      }

      return { ok: true, data };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.ports.showNotice(`创建卡片异常：${msg}`);
      return { ok: false, error: msg };
    } finally {
      if (tempFile) {
        await tempFile.cleanup().catch(() => {});
      }
      freezeHandle.unfreeze();
      this.busy = false;
    }
  }
}
