# Library UX + Metrics · 开放问题

规则：只列**会阻塞播种或改变允诺行为**的问题。能默认的已写入共识/本批默认，不在此重复 gril。

## 播种前：无阻塞项

当前 **无** 必须用户再答才能写 DAG 的问题。下列为已拍板默认（来自 CONSENSUS，此处仅备案）：

| 主题 | 默认 |
|---|---|
| 单击 | 选中 + 开 Detail Drawer |
| 双击 | 仅 Primary PDF；缺 PDF → Notice |
| Open Folder | Obsidian explorer，非 Finder |
| Reading | chip 循环；删 Reading 按钮 |
| Metrics 源 | EasyScholar（同 zotero-style 族） |
| Metrics 持久化 | 仅插件 `data.json` `metricsCache` |
| 指标进 MD | 永不 |
| 本批范围外 | paper-fetch、Word 空格、Finder、双击 Figure |

## 实现期可能升级为 needs_input（非播种阻塞）

### Q1 — 单击/双击消除冲突策略

若短延迟区分 click/dblclick 与「立即开 Drawer」手感冲突，由 **ux-interaction** 在实现中选一并在卡评论写明；仅当要**改共识语义**时 `needs_input`。  
**默认：** 允许 ~250–300ms click 延迟以避免双击闪 Drawer。

### Q2 — 无 `journal` 条目的 metrics

若大量 `no_key`，是否映射 `publication_title` 或其它 FM 字段。  
**默认：** 本批不改契约；engine 卡报告比例；若需改 frontmatter 契约再问用户。

### Q3 — Open Folder 在旧版 Obsidian 无 API

**默认：** 尽力 explorer reveal；失败 Notice + 记录版本；不降级 Finder。

### Q4 — 分区色/IF 刻度具体色板

**默认：** 实现者可参考 Zotero Ethereal/zotero-style 习惯与现有 kind 色，在 `css-polish` 自定可访问色板；**主观美感不阻塞播种**，最终以用户 G9 为准。

### Q5 — 集成后是否自动部署 vault 插件目录

**默认：** integrate **不**自动拷贝到 vault，除非用户明示（历史 Batch3 曾手动 cmp 部署）。GUI Gate 前由用户或明示部署步骤。

## 明确非问题（不要再打开）

- 是否写 IF 进 YAML — 否  
- 是否 Finder — 否  
- 是否双击 Figure — 否  
- 是否本批做 paper-fetch — 否  
- 是否与 reading-notes 共用 worktree — 否  

## 播种闸门

用户确认：

1. 已读 `DAG.md` + `TASK_MANIFEST.json`  
2. 回复 **「确认播种」**（或等价）  

此前 orchestrator **不得** `kanban_create` 实现卡。
