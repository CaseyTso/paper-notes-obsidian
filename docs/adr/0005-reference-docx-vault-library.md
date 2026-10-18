# ADR 0005: Reference DOCX 从单一路径迁移到 Vault 管理的模板库

## Status
Accepted

## Context

初始设计（Task 29）将 Reference DOCX 存储为 `settings.referenceDocx` 中的一个绝对路径字符串，原地引用磁盘上的文件。这个模型在只有一份模板时足够简单，但一旦用户希望"每次可以选择不同模板"，单一路径就变成了限制。

对比已有的 CSL Style Manager（Task 28）：CSL 样式是多文件管理场景，被设计为 vault 资产（`.paper-notes/csl/`），支持导入/删除/列表。Reference DOCX 现在面临同样的需求——用户希望管理多个 Word 模板并在其中切换。

## Decision

将 Reference DOCX 升级为 vault 管理的**模板库**：

- 模板存储在 `.paper-notes/reference-docx/` 下（vault-relative）。
- 导入时通过文件选择器复制模板进 vault。
- 设置页维护一个"模板库管理"弹窗（与 CSL Style Manager 对称），支持导入、列表、设为默认、删除。
- 全局默认模板用 `settings.referenceDocx` 字段存储文件名（非路径），和 CSL 的 `selectedCsl` 对称。
- 升级时自动迁移：检测到旧版绝对路径非空且文件存在 → 复制进模板库并设为默认。

## Consequences

- **Positive**：vault 同步时模板跟着走；换电脑不丢失；UI 模式与 CSL Style Manager 一致，学习成本低；导出确认弹窗可以显示友好文件名而非绝对路径。
- **Negative**：模板复制进 vault，占用 vault 空间；旧路径迁移产生副本。
- **Migration**：首次加载插件时检查旧 `referenceDocx`（包含 `/` 或 `\\` 的绝对路径特征），自动复制到 `.paper-notes/reference-docx/` 并清空旧字段。迁移失败不阻塞启动，静默降级为"空"（Pandoc 默认）。

## Alternatives considered

- **保留单一路径**：不满足"多个模板可选"的需求。
- **路径列表（原地引用）**：实现简单但换电脑/路径移动后全部失效，和 CSL 管理体验不一致。
- **导出时选择（per-export）**：用户场景更偏向"按论文选模板"，但当前 UI 契约是全局默认；per-export 需要改导出确认弹窗和数据模型，推迟到后续迭代。
