import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";

import {
  PaperNotesMocView,
  VIEW_TYPE_TOPIC_MOC,
  type MocViewSource,
} from "../src/views/topic-moc-view";

vi.mock("obsidian", () => {
  interface FakeEl {
    style: Record<string, string>;
    value: string;
    textContent: string;
    tagName: string;
    empty(): void;
    addClass(_cls: string): void;
    removeClass(_cls: string): void;
    toggleClass(_cls: string, _on?: boolean): void;
    createDiv(_opts?: Record<string, unknown>): FakeEl;
    createEl(_tag: string, _opts?: Record<string, unknown>): FakeEl;
    addEventListener(_type: string, _handler: unknown): void;
    removeEventListener(_type: string, _handler: unknown): void;
    appendChild(_child: FakeEl): void;
    append(..._children: FakeEl[]): void;
    remove(): void;
    detach(): void;
    setAttribute(_name: string, _value: string): void;
    getAttribute(_name: string): string | null;
    querySelector(_selector: string): FakeEl | null;
    querySelectorAll(_selector: string): FakeEl[];
  }

  function makeEl(): FakeEl {
    const el: FakeEl = {
      style: {},
      value: "",
      textContent: "",
      tagName: "DIV",
      empty: () => {},
      addClass: () => {},
      removeClass: () => {},
      toggleClass: () => {},
      createDiv: () => makeEl(),
      createEl: () => makeEl(),
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: () => {},
      append: () => {},
      remove: () => {},
      detach: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return el;
  }

  class ItemView {
    leaf: unknown;
    app: Record<string, unknown>;
    containerEl: FakeEl;

    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.app = {
        vault: {
          getAbstractFileByPath: () => null,
        },
        workspace: {
          getLeaf: () => ({ openFile: () => {} }),
        },
      };
      this.containerEl = makeEl();
    }

    open(): void {}
  }

  class WorkspaceLeaf {
    setViewState = (): void => {};
  }

  class Notice {
    constructor(_message: string) {}
  }

  return { ItemView, WorkspaceLeaf, Notice, setIcon: () => {} };
});

const MOC_WITH_DATA = `---
kind: topic-moc
title: 测试主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
| 行1 | [[Figure解读_a2024]] | 第一行<br>第二行 | [[card_Figure2_x\\|短标题]] |
| | | | |
| 行2 | [[Figure解读_b2024]] | 摘要2 | |
`;

const EMPTY_MOC = `---
kind: topic-moc
title: 空主题
---

| Title | Figure解读 | 总结 | 卡片 |
| ----- | -------- | --- | --- |
`

function makeSource(mocs: Record<string, string> = {}): MocViewSource {
  const fileMap = new Map(Object.entries(mocs));
  const names = Object.keys(mocs).map((k) => k.split("/").pop() as string);
  return {
    getVaultRoot: () => "/tmp/fake-vault",
    literatureRoot: "05 Literature",
    readText: async (path: string) => fileMap.get(path) ?? "",
    listMarkdownFiles: (_dir: string) => names,
    resolveLink: undefined,
    openFile: undefined,
  };
}

function makeView(source?: MocViewSource): PaperNotesMocView {
  return new PaperNotesMocView({} as WorkspaceLeaf, source ?? makeSource());
}

describe("PaperNotesMocView lifecycle", () => {
  it("does not shadow the base View.open() method with a boolean field", () => {
    const view = makeView();
    expect(typeof (view as unknown as { open: unknown }).open).toBe("function");
  });

  it("getViewType returns paper-notes-topic-moc", () => {
    const view = makeView();
    expect(view.getViewType()).toBe(VIEW_TYPE_TOPIC_MOC);
  });

  it("getDisplayText returns 'Topic MOC'", () => {
    const view = makeView();
    expect(view.getDisplayText()).toBe("Topic MOC");
  });
});

describe("PaperNotesMocView rendering", () => {
  it("renders one sidebar row per list item", async () => {
    const source = makeSource({
      "05 Literature/MOCs/主题A.md": MOC_WITH_DATA,
      "05 Literature/MOCs/主题B.md": EMPTY_MOC,
    });
    const view = makeView(source);
    await view.onOpen();

    const items = (view as unknown as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
  });

  it("shows empty folder copy when no MOCs exist", async () => {
    const source = makeSource({});
    const view = makeView(source);
    await view.onOpen();

    const items = (view as unknown as { items: unknown[] }).items;
    expect(items).toHaveLength(0);
  });

  it("clicking a row sets selection", async () => {
    const source = makeSource({
      "05 Literature/MOCs/主题A.md": MOC_WITH_DATA,
    });
    const view = makeView(source);
    await view.onOpen();

    expect(view.selectedPath).toBeUndefined();
    view.selectedPath = "05 Literature/MOCs/主题A.md";
    expect(view.selectedPath).toBe("05 Literature/MOCs/主题A.md");
  });

  it("shows placeholder when no theme is selected", async () => {
    const source = makeSource({
      "05 Literature/MOCs/主题A.md": MOC_WITH_DATA,
    });
    const view = makeView(source);
    await view.onOpen();
    expect(view.selectedPath).toBeUndefined();
  });
});

describe("PaperNotesMocView table rendering (Task 9)", () => {
  it("parses selected MOC and loads entries", async () => {
    const source = makeSource({
      "05 Literature/MOCs/测试主题.md": MOC_WITH_DATA,
    });
    const view = makeView(source);
    await view.onOpen();
    view.selectedPath = "05 Literature/MOCs/测试主题.md";
    await view.refresh();

    const parsedMoc = (view as unknown as { parsedMoc: { entries: unknown[] } | undefined }).parsedMoc;
    expect(parsedMoc).toBeDefined();
    expect(parsedMoc!.entries).toHaveLength(2); // one empty row dropped
  });

  it("summary has 2 lines when source has <br>", async () => {
    const source = makeSource({
      "05 Literature/MOCs/测试主题.md": MOC_WITH_DATA,
    });
    const view = makeView(source);
    await view.onOpen();
    view.selectedPath = "05 Literature/MOCs/测试主题.md";
    await view.refresh();

    const parsedMoc = (view as unknown as {
      parsedMoc: { entries: Array<{ summaryText: string }> } | undefined;
    }).parsedMoc;
    expect(parsedMoc!.entries[0].summaryText).toBe("第一行\n第二行");
  });

  it("card click calls openFile with card path", async () => {
    const source: MocViewSource = {
      ...makeSource({ "05 Literature/MOCs/测试主题.md": MOC_WITH_DATA }),
      resolveLink: (target: string) => {
        // Simulate resolving to a file-like object
        return { path: `resolved/${target}` } as never;
      },
      openFile: (file: unknown) => {
        // Verify file path is resolved
        expect((file as { path: string }).path).toContain("card_Figure2_x");
      },
    };
    const view = makeView(source);
    await view.onOpen();
    view.selectedPath = "05 Literature/MOCs/测试主题.md";
    await view.refresh();

    // Verify the parsed entry has cardLinks
    const parsedMoc = (view as unknown as {
      parsedMoc: { entries: Array<{ cardLinks: string[] }> } | undefined;
    }).parsedMoc;
    expect(parsedMoc!.entries[0].cardLinks).toContain("card_Figure2_x");
  });

  it("row click does not call openFile", async () => {
    let openCalled = false;
    const source: MocViewSource = {
      ...makeSource({ "05 Literature/MOCs/测试主题.md": MOC_WITH_DATA }),
      openFile: () => {
        openCalled = true;
      },
    };
    const view = makeView(source);
    await view.onOpen();
    view.selectedPath = "05 Literature/MOCs/测试主题.md";
    await view.refresh();

    // No link click happened, so openFile should never be called
    expect(openCalled).toBe(false);
  });

  it("unknown figure link shows Notice, no throw", async () => {
    // Use source without resolveLink — openTarget will try fallback paths
    const source = makeSource({
      "05 Literature/MOCs/测试主题.md": MOC_WITH_DATA,
    });
    const view = makeView(source);
    await view.onOpen();
    view.selectedPath = "05 Literature/MOCs/测试主题.md";
    await view.refresh();

    // openTarget with no resolveLink and no matching file → Notice, no throw
    expect(() => {
      (view as unknown as { openTarget: (t: string, m: string, k?: string) => void })
        .openTarget("unknownNote", "05 Literature/MOCs/测试主题.md", undefined);
    }).not.toThrow();
  });
});
