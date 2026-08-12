# paper-notes Library UX + Metrics batch (2026-08-12)

Frozen via grill-with-docs. Glossary: `CONTEXT.md` at plugin repo root.

## Repos

| Role | Path |
|---|---|
| Plugin (primary product code) | `/Users/juicewrld/Downloads/Hermes Agent/paper-notes-obsidian` |
| Core CLI + skill docs | `/Users/juicewrld/Downloads/Hermes Agent/paper-notes` |
| Vault (manual GUI only; no agent drive) | `/Users/juicewrld/Downloads/obsidian/知识库` |

## In scope (must implement)

1. **Row activation**: single-click selects row **and opens Detail Drawer**; double-click opens **Primary PDF only**.
2. **Missing PDF on double-click**: Notice only (no drawer, no Figure note).
3. **Open Folder** in Detail Drawer: reveal Canonical Paper Directory in Obsidian file explorer (API style C — open explorer if needed). Not Finder.
4. **Reading status**: remove `Reading: x → y` button; table + drawer chips are clickable; cycle `unread → reading → read → unread` via CLI `item update`; **chip-local click** (no bubble to open drawer).
5. **Journal Metrics (EasyScholar, same source as Zotero zotero-style)**:
   - Fix empty cache / refresh so CAS/JCR/IF/JCI columns reliably populate.
   - Detail: Refresh metrics + visible stale/failure state.
   - Metric badge styling (partition colors + IF scale), still UI-only, never write metrics into Markdown.
6. **Horizontal scroll safe area**: bottom padding so scrollbar is not covered by Obsidian status bar.
7. **Docs**: update `paper-notes` SKILL (and thin related notes) for new click/folder/reading/metrics UX.

## Out of scope (this board)

- paper-fetch / auto PDF for Figure解读
- Word bibliography number spacing (accepted as CSL-normal)
- Finder open folder
- Double-click opens Figure解读
- Zotero retirement

## Facts for implementers

- Zotero IF/quartile UI = Ethereal Style (zotero-style) + EasyScholar API.
- paper-notes already has EasyScholar CLI + plugin MetricsCache; live CLI query works; plugin `data.json` currently has `metricsEnabled: true` but **no `metricsCache` entries** — treat as wiring/refresh bug first.
- Index maps `fm.journal` only (not `publication_title`); most notes have `journal`.
- Plugin primary writer: **dev-frontend** (Obsidian TS/CSS). Skill/docs and any pure Python CLI fix: **dev-coder** (Pi). Same-card review: **dev-reviewer**. Merge: **dev-integrator**.

## Acceptance themes

- Automated: vitest/typecheck/build for plugin; core unittest if CLI touched; no metrics in Markdown.
- Manual GUI (user Gate): click/dblclick, open folder, reading chips, metrics visible + colored, horizontal scroll usable above status bar.
- No push/publish without explicit user ask.

## Language

Kanban titles/bodies/comments in concise Chinese; code/paths/commands/English terms preserved.
