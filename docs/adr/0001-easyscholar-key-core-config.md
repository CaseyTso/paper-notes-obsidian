# ADR 0001 — EasyScholar Key 由核心 CLI 私有配置持有，插件不管理

- 日期：2026-08-15
- 状态：Accepted（用户确认，grill-with-docs 第 2 轮）

## 背景

EasyScholar 开放接口（`/open/getPublicationRank`）需要 SecretKey 才能查询 CAS / JCR / IF / JCI。
核心仓的适配器读取用户本地私有配置
`~/Library/Application Support/paper-notes/config.json`（0600 权限），
并支持 `paper-notes config easyscholar import-zotero` 从 Zotero prefs 导入 key。

用户提出「插件没有 Obsidian 设置页，是否需要配置分区/IF 的 key 的地方」，
并担心 key 硬编码在项目里、开源仓库会泄露。

## 已核实事实（2026-08-15）

- 插件仓 `src/` 中所有 easyscholar 引用都是注释，无任何 key。
- 核心仓 Python/文档无硬编码 key；`tests/test_easyscholar.py` 使用伪造测试 key。
- vault 插件 `data.json` 的键列表中没有 key 字段（只有 `metricsCache` 等）。
- 真实 key 只存在于用户本地 `~/Library/Application Support/paper-notes/config.json`，不进任何 git 仓库。
- 两个仓库现在即可安全开源，不存在 key 泄露路径。

## 决策

1. 插件**不持有、不展示、不录入** EasyScholar key。
2. 插件设置页（新增）中只放一行**只读状态**（已配置 / 未配置，由最近一次 metrics 结果推断），
   并附一行说明：key 由核心 CLI 私有配置持有，用
   `paper-notes config easyscholar import-zotero` 配置。
3. 若未来确需插件侧录入 key，唯一可接受路径是插件把 key 写入自己的私有配置文件，
   并在每次调用 CLI 时通过 `PAPER_NOTES_CONFIG` 环境变量指向该文件（核心 Python 不改），
   且需重新评估并更新本 ADR。

## 后果

- 正向：key 不进 git、不进 vault、不随插件分发；0600 私有配置比 data.json 更安全；
  插件与核心仓的「所有受管写入走 CLI」边界不破。
- 负向：key 的配置入口在 CLI/文档而非插件 GUI，插件内不能直接修改 key；
  设置页只能显示状态，不能提供编辑。
