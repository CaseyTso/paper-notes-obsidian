# Paper Notes Obsidian Plugin

Obsidian desktop plugin that presents the vault-native literature library and routes managed mutations through the paper-notes CLI.

## Language

**Literature Library**:
The full-width table view of canonical paper items under the literature root.
_Avoid_: Zotero pane, item list, browser

**Detail Drawer**:
The right-side overlay panel that shows one selected paper’s read-only detail and actions.
_Avoid_: detail pane, inspector, sidebar detail, split detail

**Canonical Paper Directory**:
The vault folder `05 Literature/<citation_key>/` that owns one paper’s main note, PDF, and derived notes.
_Avoid_: Zotero storage folder, attachment folder, title folder

**Open Folder**:
Reveal the selected paper’s Canonical Paper Directory in Obsidian’s file explorer (in-app), not Finder.
_Avoid_: Show in Finder, reveal in OS, open externally

**Reading Status**:
The paper frontmatter field `reading_status` with values `unread | reading | read`.
_Avoid_: 状态, read flag, progress

**Reading Status Cycle**:
Clicking a Reading Status control advances `unread → reading → read → unread` through the CLI `item update`.
_Avoid_: Reading shortcut button, unread→reading one-shot

**Primary PDF**:
The main PDF at `<citation_key>/<citation_key>.pdf` inside the Canonical Paper Directory.
_Avoid_: attachment, fulltext, Zotero PDF

**Journal Metrics**:
Volatile UI-only CAS / JCR / IF / JCI values from EasyScholar, never written into Markdown.
_Avoid_: impact factor fields in YAML, zotero-style tags, rank tags on notes

**EasyScholar**:
The external journal-rank API used as the sole source for Journal Metrics (same data family as Zotero’s Ethereal Style / zotero-style plugin).
_Avoid_: Web of Science direct, manual IF table, style plugin as a separate data source

**Horizontal Scroll Safe Area**:
Bottom padding in the table host so the horizontal scrollbar stays above Obsidian’s status bar.
_Avoid_: floating scrollbar, detached scroll track (unless padding fails)

**Row Activation**:
Single-click selects a row and opens its Detail Drawer; double-click opens only the Primary PDF (missing PDF → notice only).
_Avoid_: double-click for drawer, double-click opens Figure note

**Item Context Menu**:
The shared native-style menu opened either by right-clicking a Literature Library row or by the Detail Drawer’s `⋯` button. It contains row-scoped Open, Copy, Manage, and Delete actions; unavailable artifacts stay visible but disabled, and right-click selects the target row without opening a closed Drawer.
_Avoid_: Detail Drawer action bar, row action buttons, hidden unavailable actions

**Deletion Preview**:
The confirmation surface for permanently deleting a Canonical Paper Directory; it opens immediately in a scanning state, then shows the file count, total size, and external references before enabling Delete.
_Avoid_: citation-key typing gate, silent deletion scan, list-only deletion

**Chip-Local Click**:
A click on a Reading Status chip cycles status only and does not open the Detail Drawer or change row selection beyond the chip’s row if already selected; event does not bubble as a row activation.
_Avoid_: chip click opens drawer

**Metric Badge Styling**:
Visual rank/IF cues on Journal Metrics badges (partition color and IF scale), still UI-only and EasyScholar-backed.
_Avoid_: writing colored ranks into notes, Zotero tag coloring

**EasyScholar Key**:
The private EasyScholar SecretKey used for Journal Metrics; configured in the core CLI's user-local private config (`~/Library/Application Support/paper-notes/config.json`, mode 0600), never in the plugin or vault `data.json`. The plugin settings surface shows only a read-only configured/unconfigured status.
_Avoid_: plugin settings key field, storing the key in data.json, showing the key value anywhere

**Plugin Settings**:
The Obsidian settings tab exposing plugin configuration persisted in `data.json` (CLI path, export directory, Pandoc path, PDF engine, reference DOCX, selected CSL, metric TTL, metrics toggle). The literature root is display-only and cannot be edited from the tab.
_Avoid_: settings in Markdown, hidden config file editing, editable literature root

**Drawer Toggle**:
Single-clicking the Literature Library row whose Detail Drawer is already open closes the Drawer; single-click on another row still switches the Drawer, and double-click still opens only the Primary PDF (drawer-open included).
_Avoid_: click-anywhere-to-close, toggle on double-click, closing the Drawer when switching rows

**Drawer Text Selection**:
The Detail Drawer's read-only content (title, bibliography, abstract) is selectable and copyable; interactive chrome (buttons, chips, menus) stays non-selectable.
_Avoid_: whole-drawer user-select none, contenteditable, selection inside buttons
