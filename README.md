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

## Browser Connector (V1)

The plugin ships a Chromium (Chrome/Edge) MV3 Browser Connector that
captures one current `article-journal` or `preprint` page into the library.

- **How it works**: after a toolbar click, the extension extracts only
  allowlisted bibliographic evidence (Highwire, JSON-LD, Dublin Core,
  OpenGraph, DOI scan) and submits it to the Obsidian plugin's Capture
  Bridge at `http://127.0.0.1:27124/v1/capture`. The paper-notes core CLI
  remains the single writer: it validates, queries official sources,
  deduplicates, and either creates the item or opens a field-by-field
  Import Review in Obsidian.
- **Permissions**: the extension requests only `activeTab`, `scripting`,
  and the exact loopback host permission for `http://127.0.0.1:27124/*`.
  No cookies, history, downloads, `<all_urls>`, persistent content
  scripts, or native messaging. Only the clicked page is read, and only
  structured bibliographic fields are transmitted — never page body text,
  tags, cookies, HTML, or paths.
- **Obsidian must be running** for a capture to complete. Chrome may show
  a one-time Local Network Access prompt for the loopback connection;
  allow it.
- **Settings**: enable/disable the Capture Bridge from the plugin settings
  tab (`Browser Connector` section). The status row shows
  `running | disabled | port_conflict | error`. If port `27124` is already
  in use, the bridge records `port_conflict` and every other plugin
  feature stays usable.
- **V1 scope**: Chromium only — no Safari, no Firefox, no batch capture.

### Build and load the unpacked extension

```bash
npm run build:connector      # builds browser-connector/dist/
```

Then in Chrome/Edge:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select
   `browser-connector/dist/`.
4. Keep Obsidian running, pin the Paper Notes extension, and click the
   toolbar icon on a supported paper page.

### Connector development

```bash
npm run test:connector       # vitest (protocol + extraction)
npm run typecheck:connector  # tsc --noEmit
npm run build:connector      # esbuild -> browser-connector/dist/
```

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
