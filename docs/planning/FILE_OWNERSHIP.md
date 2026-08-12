# Library UX + Metrics · 文件所有权

规则：实现期同一热点文件只允许一个 writer 卡；allowlist 外禁止改动；指标永不写 vault Markdown。

## 仓库

| 仓 | 路径 | 本批角色 |
|---|---|---|
| Plugin | `/Users/juicewrld/Downloads/Hermes Agent/paper-notes-obsidian` | UI/TS/CSS/tests 主实现 |
| Core | `/Users/juicewrld/Downloads/Hermes Agent/paper-notes` | 仅 `SKILL.md`（+ 可选极薄 README 交叉链） |
| Vault | `/Users/juicewrld/Downloads/obsidian/知识库` | **禁止** agent 写入；仅用户 GUI |

## 按卡 allowlist

### `ux-interaction` · dev-frontend

**可写：**

- `src/views/literature-library-view.ts`
- `src/services/item-actions.ts`（仅当 Open PDF / Open Folder 纯函数 helper 需要；优先 view 内私有方法）
- `tests/library-shell-batch1.test.ts`
- `tests/cards-block.test.ts`（若仍依赖 dblclick→drawer 语义，改为 click）
- `tests/item-actions.test.ts`（仅当 helper 变更）
- 必要时最小 CSS **仅** chip 可点态：优先 defer 到 `css-polish`；若必须本卡可点，限 `.paper-notes-status-chip` cursor/button 角色，并在卡评论声明 hotspot

**禁止：** `metrics-cache.ts`、`metric-cell.ts`、核心仓、`main.js` 手改（由 build 产出）

**行为归属：**

- 单击行：`selectedPath` + `openDetailDrawer()`
- 双击行：`openAsset("pdf")` 或等价；无 PDF → `Notice`，不开 drawer、不开 Figure
- 移除 action bar `Reading: x → y` 按钮
- 表单元格 + drawer header 的 reading chip：`click` → `cycleReadingStatus`；`stopPropagation`
- Open Folder：Canonical Paper Directory（`05 Literature/<key>/`）在 Obsidian file explorer reveal；explorer 未开则打开（共识 API style C）

### `metrics-engine` · dev-frontend

**可写：**

- `src/services/metrics-cache.ts`
- `src/components/metric-cell.ts`
- `tests/metrics-cache.test.ts`
- 若诊断需要 journal 映射修复：`src/services/library-index.ts`、`src/types/paper.ts`（**仅**当证实 `fm.journal` 缺失或需受控回退；默认不扩 ISSN）
- 若 bridge 注释/getMetrics 桩误导：`src/main.ts` 中 **LibraryViewSource 相关最小行**（注释与 `getMetrics` 说明）；禁止借机大改插件生命周期

**禁止：** `literature-library-view.ts`（留给 ux / metrics-drawer-ui）、`styles.css`（留给 css-polish）

**诊断顺序（写入卡 body）：**

1. `metricKeyOf(record)` 是否对库内多数记录为 `journal:…`
2. `getMetricsCache` bridge（client/load/save）是否在 view 生命周期可用
3. `metricsFromEnvelope` 与 CLI `metrics query` 成功 envelope 是否一致
4. `data.json` merge-save 是否丢 `metricsCache`
5. `metricsEnabled` / TTL / backoff 是否导致永久跳过

### `css-polish` · dev-frontend

**可写：**

- `src/styles.css`（及 build 同步的根 `styles.css` **仅当**项目惯例由 build 生成——实现卡应改 `src/styles.css`，由 verify/build 生成产物；**不要**手改与 src 分叉的 root 副本 unless build 管线要求）

**范围：**

- `.paper-notes-library-table-host` 底部 padding / safe area（避开 status bar 挡横滑条）
- Metric badge：**分区色**（CAS/JCR 档位）与 **IF 刻度**（数值区间），仍 UI-only
- 可点 reading chip 的 hover/focus（若 ux 卡未做）
- stale/failure 视觉 token（供 drawer 复用）

**禁止：** 任意 `.ts` 业务逻辑

### `skill-docs` · dev-coder

**可写（核心仓）：**

- `SKILL.md`
- 可选：`README.md` / `README.zh-CN.md` 中指向 Library UX 的一行交叉链接（非必须）

**禁止：** `paper_notes/**/*.py`、配置密钥、vault、插件 `src/`

**内容要点：** Row Activation、Open Folder（非 Finder）、Reading chip cycle、`item update`、Journal Metrics UI-only + EasyScholar、与 Zotero zotero-style 同源说明。

Symlink：`~/.hermes/skills/research/paper-notes` → 核心仓；改 `SKILL.md` 即同步 Hermes skill。

### `metrics-drawer-ui` · dev-frontend

**可写：**

- `src/views/literature-library-view.ts`（metrics detail 段、Refresh 控件、stale/failure 文案；**不重写** ux-interaction 已落地的 click/chip/folder）
- 相关测试：扩展 `tests/library-shell-batch1.test.ts` 或新增 `tests/metrics-drawer-ui.test.ts`
- **不**改 `metrics-cache.ts` / `styles.css` 除非 review 发现引擎/CSS 缺口——缺口回对应卡 `request_changes`

**Parents：** `ux-interaction`, `metrics-engine`, `css-polish`

### `integrate-library-ux` · dev-integrator

**可写：**

- 合并分支 / 解决冲突
- 根 `main.js` / `styles.css` 仅经 `npm run build` 生成
- 不改产品语义；冲突以 FILE_OWNERSHIP 与共识为准

**验证：** `npm run test`、`npm run typecheck`、`npm run build`（插件）；若 skill 有测则核心仓既有 unittest（本批默认无 py 改动）

### `gui-gate-library-ux`

**可写：** 无产品代码。仅卡评论与验收勾选。

## 共享只读

所有卡只读：

- `docs/planning/CONSENSUS_2026-08-12.md`
- `CONTEXT.md`
- 本目录其余规划文件
- 核心仓 `references/*`、CLI 协议（metrics 契约对照）

## 明确禁止全局

- 修改 vault 笔记 / frontmatter 写入 metrics
- push、发布、改依赖版本（除非 integrator 经用户授权）
- 与 reading-notes 共用 worktree
- 双 writer 同时改 `literature-library-view.ts` 或 `styles.css`
