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

**Attach PDF**:
The Item Context Menu action that opens the native system file picker for one local PDF and attaches it as the paper’s Primary PDF through the paper-notes CLI.
_Avoid_: manual path entry, folder picker, supplementary upload

**MinerU Conversion**:
The CLI-backed cloud conversion of a paper’s Primary PDF into `minerUmd_<citation_key>.md` plus extracted images under that paper’s `attachments/`. It does not create Figure解读 or final high-resolution assets under `figures/`.
_Avoid_: MinerU scan, Figure解读 generation, high-resolution figure rendering, plugin-direct MinerU call

**MinerU Conversion Queue**:
The session-bound FIFO list of requested MinerU Conversions: one paper runs at a time, later requests wait in order, and quitting or reloading Obsidian discards the pending queue.
_Avoid_: parallel conversion, persistent worker queue, restart-resumable job

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

**MinerU Key**:
The private token used for MinerU Conversion. It is entered through Plugin Settings but stored only in the core CLI’s user-local private config (`~/Library/Application Support/paper-notes/config.json`, mode 0600), never in the vault or plugin `data.json`.
_Avoid_: vault-synced token, persisted plugin setting, command-line token, displayed saved token

**Plugin Settings**:
The Obsidian settings tab exposing plugin configuration persisted in `data.json` (CLI path, export directory, Pandoc path, PDF engine, reference DOCX, selected CSL, metric TTL, metrics toggle). The literature root is display-only and cannot be edited from the tab.
_Avoid_: settings in Markdown, hidden config file editing, editable literature root

**Drawer Toggle**:
Single-clicking the Literature Library row whose Detail Drawer is already open closes the Drawer; single-click on another row still switches the Drawer, and double-click still opens only the Primary PDF (drawer-open included).
_Avoid_: click-anywhere-to-close, toggle on double-click, closing the Drawer when switching rows

**Drawer Text Selection**:
The Detail Drawer's read-only content (title, bibliography, abstract) is selectable and copyable; interactive chrome (buttons, chips, menus) stays non-selectable.
_Avoid_: whole-drawer user-select none, contenteditable, selection inside buttons

## Browser Capture

**Browser Connector**:
The Paper Notes browser extension that submits metadata from one current paper page to the Obsidian Plugin.
_Avoid_: Zotero Connector, Obsidian Plugin, Zotero runtime

**Capture Bridge**:
The Obsidian Plugin-owned loopback endpoint through which the Browser Connector submits a Web Capture.
_Avoid_: public API, `obsidian://` payload transport, native-messaging host, core writer

**Web Capture**:
A candidate bibliographic record extracted from one current journal-article or preprint webpage before core validation and deduplication.
_Avoid_: user-confirmed metadata, authoritative Paper, Zotero item

**Captured Bibliography**:
The source-supplied publication facts in a Web Capture, excluding core-generated identity, workflow, artifact, and metric fields.
_Avoid_: full frontmatter, confirmed metadata, tags, page body

**Verified Capture**:
A Web Capture backed by a successful authoritative identifier lookup, complete critical bibliography, and no material source conflict; it may create a Paper without Import Review.
_Avoid_: trusted webpage, user-confirmed metadata, unchecked complete record

**Import Review**:
The field-by-field Obsidian confirmation surface for a Web Capture that has missing or conflicting metadata, a possible duplicate, or an explicit metadata-update proposal for an existing Paper.
_Avoid_: import inbox, mandatory preview, silent conflict resolution, automatic metadata update

**Supported Paper Page**:
A webpage describing one journal article or preprint and exposing enough structured metadata or a strong identifier for a Web Capture.
_Avoid_: search-results page, multi-item page, book page

## Topic MOC

**Topic MOC**:
A markdown note that collects papers around one research theme. One note is one theme; it is not a Canonical Paper Directory and does not live inside one.
_Avoid_: 文献总览 section, mega-overview heading, generic Obsidian MOC, theme tag

**MOC Folder**:
The dedicated directory `05 Literature/MOCs/` that holds Topic MOC notes. It is not a Canonical Paper Directory.
_Avoid_: Topic MOCs next to paper folders, vault-root MOC, `10 Projects`

**MOC Marker**:
The frontmatter field `kind: topic-moc` that identifies a note in the MOC Folder as a Topic MOC. An optional `title` is the display name; if absent, the filename stem is used. Notes in that folder without this `kind` are ignored by MOC View.
_Avoid_: `type: topic-moc`, `moc: true`, “any markdown in the folder”, heading-only detection, settings whitelist

**Create Topic MOC**:
The MOC View action that asks for a theme name and calls the paper-notes CLI to write a new Topic MOC: `kind: topic-moc`, optional `title`, filename equal to the typed name, and an empty Topic Table. Duplicate names are rejected. It does not add papers or attach cards.
_Avoid_: plugin `vault.create`, creating a theme by adding a `##` section, adding rows from the panel

**MOC View**:
The independent plugin view, opened in the center leaf, that lets the user pick a Topic MOC and read its Topic Table. It is not the Literature Library (which stays in the right leaf). Clicks follow Figure解读 Links and Attached Cards only; a row is not an activation target and does not open the Detail Drawer.
_Avoid_: Library tab, theme filter, overview preview, merged library-and-moc table, row activation, right-leaf MOC

**Overview Archive**:
The retired mega-overview note after its topic tables have been split into Topic MOCs. It is moved to `40 Archive/` and is no longer a live source for MOC View.
_Avoid_: keeping 文献总览 as a second live table, leaving an index in `05 Literature`

**Topic Table**:
The markdown table inside a Topic MOC. One row is one paper in that theme. Columns are Title, Figure解读, Topic Summary, and Card Column.
_Avoid_: column-per-paper table, Literature Library table

**Card Column**:
The fourth Topic Table column, titled `卡片`. It lists Attached Cards as wikilinks; it does not embed card bodies.
_Avoid_: embedding card text, auto-listing every file in `cards/`

**Topic Summary**:
The theme-oriented note in the 总结 column: what this paper contributes to this theme, not a paper abstract.
_Avoid_: abstract, 全文摘要, Overview, Figure解读 body

**Topic Entry**:
One paper’s membership in a Topic MOC — title, Figure解读 link, Topic Summary, and any Attached Cards.
_Avoid_: Library row, Paper Record, citation

**Attached Card**:
An existing literature card from that paper’s `cards/` that has been hung on a Topic Entry because it is relevant to this theme. Not every card of the paper, and not a card created inside the Topic MOC.
_Avoid_: all cards of the paper, inline card body, new card authored in the MOC

**Figure解读 Link**:
The wikilink in the Figure解读 column. In the first version, its target filename is how a Topic Entry is bound to a paper.
_Avoid_: citation_key column, title-as-identity
