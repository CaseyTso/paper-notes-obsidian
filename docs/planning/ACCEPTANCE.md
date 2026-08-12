# Library UX + Metrics · 验收清单

## A. 自动化（agent / CI）

插件仓（`paper-notes-obsidian`）：

| # | 检查 | 命令 / 条件 | 负责卡 |
|---|---|---|---|
| A1 | 单测 | `npm run test`（基线参考：≥432 passed，skip≤1；以合入时全绿为准） | 各 FE + integrate |
| A2 | 类型 | `npm run typecheck` | 各 FE + integrate |
| A3 | 构建 | `npm run build`；`main.js`/`styles.css` 由构建生成 | integrate |
| A4 | Row/Reading/Folder 行为测 | 更新后的 `library-shell-batch1` 等：click→drawer、dblclick→pdf、chip cycle 不冒泡 | ux-interaction |
| A5 | Metrics 测 | `tests/metrics-cache.test.ts`：refresh、envelope、stale、persist、dedupe | metrics-engine |
| A6 | Drawer metrics UI 测 | Refresh 入口与 stale 展示（新测或扩展壳测） | metrics-drawer-ui |
| A7 | 无 Markdown 写指标 | 代码审阅：metrics 路径仅 `metrics query` + `data.json` metricsCache | reviewer + integrate |
| A8 | 核心文档 | SKILL 含新 UX 表述；无密钥 | skill-docs |

核心仓：本批默认无 Python 变更；若有，则 `pytest`/既有 unittest 全绿。

## B. 用户 GUI Gate（不可代理）

**环境：** 用户本机 Obsidian + 已部署/热重载的插件；vault `知识库`。  
**标记：** `human-visual-review-required` — DeepSeek 与非视觉模型**不得**勾选通过。

| # | 场景 | 期望 | 通过 |
|---|---|---|---|
| G1 | 单击某一文献行 | 行选中高亮，**Detail Drawer 打开** | ☐ |
| G2 | Drawer 已开时单击另一行 | 选中切换，Drawer 内容换为新条目 | ☐ |
| G3 | 双击有 Primary PDF 的行 | **只打开 PDF**（不额外依赖「先开 Drawer」）；不打开 Figure解读 | ☐ |
| G4 | 双击无 PDF 的行 | **仅 Notice**；不打开 Drawer（若已开可保持原状但不因双击新开 Figure） | ☐ |
| G5 | Drawer → Open Folder | Obsidian **左侧文件列表**定位到 `05 Literature/<key>/`；**不是** macOS Finder | ☐ |
| G6 | 表中 Reading chip 单击 | 状态 unread→reading→read→unread 循环；主笔记 frontmatter `reading_status` 经 CLI 更新；**不**因 chip 单击而误开/切换 Drawer 逻辑（chip-local） | ☐ |
| G7 | Drawer 内 Reading chip 单击 | 同上循环；无「Reading: x → y」按钮 | ☐ |
| G8 | 库表 CAS/JCR/IF/JCI | 对有 journal 的条目，刷新后**列有徽章**（非长期全空） | ☐ |
| G9 | 徽章颜色 | 分区（CAS/JCR）与 IF 刻度有可辨色差；仍为 UI 徽章 | ☐ |
| G10 | Drawer Metrics | 可见 Refresh；刷新后有成功/失败/stale 反馈 | ☐ |
| G11 | 横滑 | 列很宽时底栏横滑条可点到，**不被** Obsidian 状态栏挡住 | ☐ |
| G12 | 回归 | 创建/Attach/Delete/导出等未在本批声明的能力无严重回归（抽查） | ☐ |

## C. Gate 流程

1. `integrate-library-ux` done 且 A1–A8 证据在卡评论。
2. 播种/放行 `gui-gate-library-ux`：`blocked` + `needs_input` + 正文引用本表。
3. 用户在 Obsidian 点验，结果写回卡评论（可逐项 G1…）。
4. 全部 ☐→☑ 后 complete Gate；任一项失败 → `kanban_request_changes` 或新建**有界** repair 卡（parent=repair，child=gate），禁止静默改共识。

## D. 明确不验收（本批）

- paper-fetch / 自动 PDF  
- Word 参考文献空格  
- Finder 打开文件夹  
- 双击打开 Figure解读  
- Zotero 退役  
