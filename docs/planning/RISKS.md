# Library UX + Metrics · 风险与已知坑

## R1 — 空 `metricsCache`（高）

**现象：** `metricsEnabled: true` 但 `data.json` 无/空 `metricsCache`；表 metrics 列空白。  
**已有代码：** `MetricsCache`、`onOpen`→`refreshAllExpired`、`getMetricsCache` bridge、CLI `metrics query` 现场可用。  
**嫌疑（按序）：**

1. `metricKeyOf` 对记录返回 `undefined`（无 `journal`/issn）→ 全员 `no_key`
2. bridge 缺 `client`/`loadData`/`saveData` → cache 未创建
3. `metricsFromEnvelope` 与真实 CLI `data.metrics` 形状不一致 → 当 `empty` 失败
4. persist merge 被其它 save 覆盖（历史 columnWidths 整对象写曾有此坑；现 merge-save）
5. backoff/enabled 边缘导致从不写入

**缓解：** `metrics-engine` 强制卡评论写根因 + 复现步骤；单测锁 envelope；禁止「调大 TTL 假装修好」。

## R2 — `journal` 字段覆盖（中）

Index 只读 `fm.journal`，不读 `publication_title`。多数笔记有 `journal`；少数只有别名时 metrics 永空。  
**缓解：** 引擎卡先统计/日志 no_key 比例；默认不扩字段；若比例高，最小回退方案写进卡评论并 `needs_input` 仅当改变 frontmatter 契约时。

## R3 — `literature-library-view.ts` 热点（高）

单击/双击、chip、Open Folder、Drawer metrics 同文件。双 writer → 合并地狱。  
**缓解：** `ux-interaction` → `metrics-drawer-ui` 严格串行；L0 其它卡禁止碰 view。

## R4 — `styles.css` 热点（中）

横滑 padding 与 badge 色同文件。  
**缓解：** 单一 `css-polish` writer；engine 只约定 class 名。

## R5 — 单击/双击时序（中）

浏览器 dblclick 前会触发两次 click → 可能先开 Drawer 再开 PDF。  
**缓解：** 实现需处理 click 延迟或接受「双击也会选中并开 drawer」是否违反共识。  
**共识字面：** 单击开 Drawer；双击开 PDF。若双重 click 导致闪 Drawer，应用 ~250–300ms click delay 或在 dblclick 路径抑制 drawer（实现卡验收写明策略）。**默认建议：** 使用短延迟区分 click/dblclick，避免 PDF 双击时 Drawer 闪烁。

## R6 — Open Folder API 碎片（中）

Obsidian 无单一稳定公开 `revealInFolder` 于所有版本；需 internal file-explorer 或 `workspace.revealLeaf` 变体。  
**缓解：** ux 卡调研当前桌面 API；失败则 Notice + 卡内记录版本；禁止降级为 Finder（共识明确排除）。

## R7 — Reading chip 与 row click 冒泡（中）

chip 在 `<td>` 内，冒泡会触发 row activation。  
**缓解：** 强制 `stopPropagation`；测试模拟冒泡。

## R8 — 状态栏遮挡横滑（中）

仅加 padding 可能不够（主题/安全区不同）。  
**缓解：** 先 padding；用户 G11 失败再考虑 `scrollbar-gutter` 已有前提下增大常量或 CSS 变量，不做浮动滚动条 unless padding 失败（CONTEXT 用语）。

## R9 — 双仓 skill 同步（低）

`~/.hermes/skills/research/paper-notes` → 核心仓 symlink；改 SKILL 即生效。若有人复制非 symlink 副本会漂。  
**缓解：** skill-docs 验证 symlink；不改插件仓假 SKILL。

## R10 — reading-notes 并发 worktree（中）

共识：reading-notes 板在跑。  
**缓解：** 本批独立 worktree/branch；integrate 用插件主仓 dir 时先 `git status` 无其它 agent 脏写。

## R11 — Review 误用 block（低·流程）

历史 stall：`review-required` block + Manager 子卡死锁。  
**缓解：** 同卡 `kanban_request_review(reviewer="dev-reviewer")`；integrator 仅父卡 done 后创建。

## R12 — 构建产物分叉（低）

根目录 `main.js`/`styles.css` 与 `src/` 双份。  
**缓解：** 只改 src；integrate 跑 build；禁止手编 main.js。

## R13 — 指标写回 Markdown 回归（高·原则）

任何「缓存到 frontmatter 方便搜索」提案直接拒绝。  
**缓解：** ACCEPTANCE A7；reviewer 检查项。

## R14 — GUI Gate 被模型代劳（高·原则）

非视觉模型不能判 G1–G12。  
**缓解：** Gate 卡 `human-visual-review-required`；orchestrator 不 complete 代签。
