# Library UX + Metrics · 实现 DAG

依据：`CONSENSUS_2026-08-12.md`、`CONTEXT.md`。本文件只描述可播种依赖图；**用户确认「确认播种」前不得 create 实现卡**。

## 关键假设

1. 插件仓 `paper-notes-obsidian` 为 UI/TS/CSS 主写仓；核心仓 `paper-notes` 仅本批改 `SKILL.md`（及必要的薄交叉引用），默认不动 Python CLI（live `metrics query` 已可用）。
2. 空 `metricsCache` 优先按**插件接线/刷新/解析**缺陷排查，不先改 EasyScholar 后端。
3. Index 仅映射 `fm.journal`（无 `publication_title`）；多数笔记有 `journal`；ISSN 当前未进 `PaperRecord`，本批**默认不扩 ISSN 字段**，除非 metrics 卡诊断证明无 journal 导致全库 `no_key`。
4. reading-notes 板独立 worktree；本项目每卡独立 worktree 或串行 `dir:`，禁止抢同一 worktree。
5. 指标永不写 Markdown；Open Folder = Obsidian 内 file explorer（非 Finder）。
6. 本批不做：paper-fetch、Word 空格、Finder、双击 Figure解读。

## 现状 → 目标（关键路径）

| 能力 | 现状（代码） | 目标（共识） | 主路径 |
|---|---|---|---|
| Row Activation | `click` 仅选中；`dblclick` 开 Drawer | 单击选中+开 Drawer；双击仅 Primary PDF；无 PDF → Notice | `literature-library-view.ts` |
| Open Folder | 无 | Drawer 内按钮，reveal Canonical Paper Directory | `literature-library-view.ts` + Obsidian explorer API |
| Reading | Action bar `Reading: x → y`；chip 只读 | 去掉按钮；表/Drawer chip 可点循环；chip-local | `literature-library-view.ts` + 已有 `nextReadingStatus` / `updateReadingStatus` |
| Metrics 填充 | Cache 类齐全，`onOpen`→`refreshAllExpired`；现场常空 cache | CAS/JCR/IF/JCI 可靠出现 | `metrics-cache.ts` 诊断+修 + 既有 bridge |
| Metrics UI | Command 刷新；Drawer 无 Refresh；badge 按 kind 上色 | Drawer Refresh + stale/failure 可见；分区色+IF 刻度 | `metric-cell.ts` + `styles.css` + view detail |
| 横滑 safe area | `overflow:auto` + `scrollbar-gutter`，无底 padding | 底 padding 避开 status bar | `styles.css` `.paper-notes-library-table-host` |
| Docs | SKILL 有 metrics 原则，缺新 Library UX 交互说明 | 同步 click/folder/reading/metrics | 核心仓 `SKILL.md` |

## 任务节点（稳定 id）

| id | 标题 | assignee | 层 |
|---|---|---|---|
| `ux-interaction` | Row Activation + Reading chips + Open Folder | `dev-frontend` | L0 |
| `metrics-engine` | Metrics 空 cache 诊断修复 + badge 分区/IF 逻辑 | `dev-frontend` | L0 |
| `css-polish` | 横滑 safe area + metric badge 视觉 token | `dev-frontend` | L0 |
| `skill-docs` | SKILL / 薄文档同步新 UX | `dev-coder` | L0 |
| `metrics-drawer-ui` | Drawer Refresh + stale/failure 展示接线 | `dev-frontend` | L1 |
| `integrate-library-ux` | 合并 worktree、verify、一致性 | `dev-integrator` | L2 |
| `gui-gate-library-ux` | 用户 GUI 验收 Gate | `dev-orchestrator`（或人工） | L3 |

## 依赖图

```text
                    ┌─────────────────┐
                    │  skill-docs     │  (core SKILL.md)
                    └────────┬────────┘
                             │
┌─────────────────┐   ┌──────┴──────────┐   ┌─────────────────┐
│ ux-interaction  │   │ metrics-engine  │   │ css-polish      │
│ (view + actions)│   │ (cache+cell TS) │   │ (styles only)   │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         │            ┌────────┴────────┐            │
         └───────────►│ metrics-drawer  │◄───────────┘
                      │ -ui (view 段)   │  ※ 必须等 ux-interaction
                      └────────┬────────┘     完成（同一 view 文件单 writer）
                               │
                      ┌────────┴────────┐
                      │ integrate-…     │  全部 L0+L1 同卡 review 通过后
                      └────────┬────────┘
                               │
                      ┌────────┴────────┐
                      │ gui-gate-…      │  人工；不可由非视觉模型代劳
                      └─────────────────┘
```

### 边（parent → child）

| parent | child | 原因 |
|---|---|---|
| `ux-interaction` | `metrics-drawer-ui` | 共享 `literature-library-view.ts`；单 writer |
| `metrics-engine` | `metrics-drawer-ui` | Drawer 依赖 cache/badge API 稳定 |
| `css-polish` | `metrics-drawer-ui` | 软依赖：Drawer stale UI 复用 badge token；可改为 integrate 前合并，但默认挂上避免样式回退 |
| `ux-interaction` | `integrate-library-ux` | 集成扇入 |
| `metrics-engine` | `integrate-library-ux` | 集成扇入 |
| `css-polish` | `integrate-library-ux` | 集成扇入 |
| `skill-docs` | `integrate-library-ux` | 文档与代码同批交付 |
| `metrics-drawer-ui` | `integrate-library-ux` | 集成扇入 |
| `integrate-library-ux` | `gui-gate-library-ux` | 仅集成 verify 通过后人工点验 |

L0 四卡**可并行**（文件 allowlist 不重叠，见 `FILE_OWNERSHIP.md`）。

## 并行层摘要

| 层 | 卡 | 并发策略 |
|---|---|---|
| L0 | ux-interaction, metrics-engine, css-polish, skill-docs | 四卡并行；各独立 worktree/branch |
| L1 | metrics-drawer-ui | 串行；parents 全 done + 同卡 review 通过 |
| L2 | integrate-library-ux | 串行；全部实现卡 review 通过 |
| L3 | gui-gate-library-ux | 用户 Gate；`needs_input` / `human-visual-review-required` |

## 关键文件热点

| 热点 | 唯一 writer 序列 |
|---|---|
| `src/views/literature-library-view.ts` | `ux-interaction` → `metrics-drawer-ui` → integrator |
| `src/styles.css` | 仅 `css-polish`（实现期）；integrator 合入 |
| `src/services/metrics-cache.ts` | 仅 `metrics-engine` |
| `src/components/metric-cell.ts` | 仅 `metrics-engine` |
| `paper-notes/SKILL.md` | 仅 `skill-docs` |

## Review / 集成策略

- 每张实现卡结束：`kanban_request_review(reviewer="dev-reviewer")`（同卡）。
- 普通缺陷：`kanban_request_changes` 原卡返工，不拉 Manager 长链。
- **禁止**在实现卡上 `block review-required` 另开 Manager 子卡。
- `integrate-library-ux` 仅在全部前置实现 **done（含 review）** 后放行。
- `gui-gate-library-ux` 不自动 complete；用户勾选 `ACCEPTANCE.md` GUI 项后由 orchestrator/用户关闭。

## 播种时 workspace

| 卡 | workspace |
|---|---|
| 插件 FE 卡 | `worktree` @ paper-notes-obsidian，branch `paper-notes/<task-id>`，或确认串行时 `dir:` 主仓 |
| skill-docs | `worktree` 或 `dir:` @ `/Users/juicewrld/Downloads/Hermes Agent/paper-notes` |
| integrate | `dir:` 主插件仓（或集成专用 worktree），只读核心仓 |
| gui-gate | `dir:` 插件仓；**禁止** agent 驱动 vault |

## 非目标（图上不出现）

paper-fetch、Word CSL 空格、Finder Open Folder、双击开 Figure、Zotero 退役、核心 EasyScholar 适配器大改（除非 metrics-engine 证明 CLI 契约破裂——那时另开 coder 卡，不在本图默认路径）。
