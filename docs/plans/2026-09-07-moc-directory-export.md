# MOC directory and bibliography export repair

## Approved scope

- Replace the standalone rendered MOC panel with an MOC directory page inside the existing plugin navigation. Keep the plugin directory visible while opening native Markdown in the main editing area.
- List Topic MOC names only: existing literature-root/MOCs directory and kind: topic-moc identity; frontmatter title with filename fallback; existing zh-CN name sorting. Empty/nonstandard body tables do not exclude notes.
- Normal click reuses the main editing leaf, not the plugin leaf; Cmd/Ctrl click opens a new main tab. Handle missing notes without creating phantom files.
- Keep CLI-backed new theme creation. Refresh the directory and open the created note. Remove secondary rendering and Edit action. Route legacy commands/buttons/restored view entries to the internal page.
- Preserve original bibliography metadata and all ISSNs; serialize ISSN as a Pandoc-compatible scalar string only at the export boundary. Keep Typst and Nature settings; do not discard papers to hide errors.
- Test all shared export paths, especially real Pandoc with multiple ISSNs and Typst PDF.

## Execution and ownership

Parent owns decisions, review disposition, final source inspection and Obsidian deployment. One implementation writer in this checkout; two independent read-only reviewers after writing completes. No concurrent source writers. Strong-model children use openai-codex/gpt-6-astra with high thinking. Runtime fallback, if used, is restricted by the user to gemini-3.8-flash; final recovery/rechecks ran on that allowed weak model. No unrelated browser connector/core changes, commits, pushes, or settings changes.

1. Implement MOC page/navigation/lifecycle and focused regression tests, following the existing UI theme and keyboard interaction conventions.
2. Repair export conversion; correct the old array assertion and add real integration coverage demonstrating the failure and repair.
3. Run typecheck, full tests and production build. Record baseline failures separately.
4. Independent UI/navigation and export/regression reviews. Address concrete in-scope blockers and rerun affected tests; repeat review if nontrivial fixes are needed.
5. Parent checks final diff and verification evidence. Locate the actual installed vault/plugin from local app configuration. Back up current deployable files; install only main.js, styles.css and manifest.json, preserving data.json and notes. Verify deployed hashes; reload plugin only through a supported available mechanism.
6. Report deployed destination, test results, remaining manual checks and ask user to accept in Obsidian.

## Acceptance checks

- Internal MOC navigation remains reachable; legacy entry does not spawn a second content-rendering panel.
- Lists only marked themes, with title fallback and name order; no standard table needed.
- Native navigation normal/modifier click, no plugin leaf overwrite, creation success/cancel/failure, rename/delete/refresh and closing during async refresh covered as appropriate.
- No body/table/card rendering or redundant Edit action.
- CSL JSON preserves multiple ISSNs in a scalar and source records remain unchanged. Real Pandoc bibliography parsing succeeds; shared DOCX/Markdown/PDF paths covered where supported.
- Production build and typecheck pass; tests or explicit environment limitations are reported honestly.
- Deployment changes only plugin artifacts, preserves configuration, and is backed up. Live UI validation and any unavailable automation are distinguished from unit-test evidence.

## Baseline

Before implementation: CONTEXT.md contains this interview's approved terminology edits. Pre-existing untracked .hermes/, docs/handoff/, and docs/adr/0003-browser-connector-loopback-bridge.md must be preserved. Do not stage or clean unrelated files.

## Completion evidence

- Independent export review approved; real Pandoc 3.8 negative control reproduced exit 25 with ISSN arrays. Repaired Nature CSL Markdown, DOCX and Typst 0.15.1 PDF paths passed, with independent PDF artifact inspection.
- Initial UI review found deferred-leaf activation and pending creation/background metrics refresh races. Both fixed with five added regression tests and approved on recheck.
- Parent final `git diff --check && npm run verify`: typecheck, 700 tests passed / 12 skipped, production build passed.
- Deployed only main.js, styles.css and manifest.json to `/Users/juicewrld/Downloads/obsidian/知识库/.obsidian/plugins/paper-notes/`; byte hashes match build. data.json hash unchanged during deployment.
- Backup: `.bak-2026-09-07-035627-moc-export/` under that installed plugin directory.
- Launched Obsidian and successfully ran `plugin:reload id=paper-notes` in 知识库. Live command routing selected internal MOC page, 13 theme entries loaded, and the old restored MOC leaf redirected and detached.
- Live DOM click smoke: normal click opened the expected native note while directory stayed visible; no preview table existed; Cmd-click added a new native Markdown tab for the expected note. No note contents were modified.
- Remaining user acceptance: visual layout, physical keyboard/mouse interaction, create-theme file-watcher behavior, and re-export of the originally failing note. No commit/push performed.

