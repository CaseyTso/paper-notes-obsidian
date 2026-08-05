# paper-notes-obsidian

Independent Obsidian plugin (desktop only) for the
[paper-notes](https://github.com/CaseyTso/paper-notes) literature system.

The plugin provides the Obsidian-side reader, library index, search and
export UI; all managed mutations go through the paper-notes CLI over a
versioned JSON protocol. This repository is standalone and never talks to
the core repository at build time.

## Features

- **Literature library view** — browse the vault's paper notes indexed from
  their frontmatter (`paper-notes-open-library`).
- **Citation picker** — insert a `[@key]` citation for a library item from
  the active note (`paper-notes-insert-citation`).
- **Focused Pandoc export (DOCX/PDF)** — export the active Markdown note as
  an academic DOCX or PDF (`paper-notes-export-docx`,
  `paper-notes-export-pdf`):
  - Markdown input keeps Pandoc citations intact.
  - A generated CSL-JSON `library.json` (current keys as ids), an alias Lua
    filter (legacy keys rewritten to current items before citeproc),
    `--citeproc` and the selected CSL style are passed to Pandoc.
  - DOCX uses the configured reference DOCX; PDF uses the configured engine.
  - All exports go to one required, user-configured global output directory
    (no same-directory fallback).
  - Unknown citation keys block the run before anything spawns; an existing
    target requires explicit confirmation.
  - Output is written to a temporary file and atomically promoted only on
    exit code 0; a nonzero exit preserves the previous artifact and shows
    stderr. Cancel stops the child process and cleans the temp output.
  - Success offers `Open file` and `Show in Finder`.
- **CSL style manager** — import, validate, and select CSL styles stored in
  the vault at `.paper-notes/csl/`.

## Settings

- `cliPath` — path to the paper-notes core CLI executable.
- `literatureRoot` — vault-relative root of the literature directories.
- `exportDirectory` — required global output directory for Pandoc exports.
- `pandocPath` — Pandoc binary used for DOCX/PDF export.
- `pdfEngine` — PDF engine passed to Pandoc (e.g. `xelatex`, `typst`).
- `referenceDocx` — reference DOCX used for export styling (optional).
- `selectedCsl` — globally selected CSL style file name (vault configuration,
  never paper metadata).
- `metricTtlDays` — EasyScholar metric cache lifetime in days.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # node esbuild.config.mjs production
npm run verify      # typecheck + test + build
```

The Pandoc integration tests run the real production export path against a
temporary fixture when a `pandoc` binary (and a PDF engine) is available on
`PATH`; they are skipped — never faked — when the binary is missing.

## License

MIT
