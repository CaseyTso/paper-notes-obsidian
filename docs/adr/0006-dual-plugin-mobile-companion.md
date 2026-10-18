# Mobile support ships as a second, separate plugin in the same repo

The plugin was desktop-only (`isDesktopOnly: true`) because its managed
writes and exports all run through the `paper-notes` CLI, which cannot run
on Obsidian Mobile. To support a mobile workflow, we ship a **second,
separate plugin** (`paper-notes-mobile`) rather than adding
`Platform.isMobile` branches throughout the existing one. Both plugins live
in this same repository (monorepo) and share a read-only data layer under
`src/shared/` (library parsing, frontmatter reading, CAS/JCR matching —
pure functions that touch no Node APIs).

The rejected alternative was a single plugin with `isDesktopOnly: false`
plus runtime `Platform.isMobile` branching everywhere. That was initially
preferred for "less maintenance," but first-principles analysis flipped it:
the mobile surface is not a degraded subset of the desktop plugin but a
self-contained workflow with its own physical environment, so two clean
plugins beat one plugin riddled with platform `if`s. Isolation — each
plugin compiles and loads only what it needs — is the primary source of
maintainability here, and the mobile plugin can simply never import
`child_process` / `fs` / Pandoc / MinerU.

The two plugins stay in one repo (not two) because the cost we most want to
avoid is *format drift*: card format, Card Anchor rules, and `reading_status`
values must stay byte-identical across both, which is far easier when the
shared read layer and the two writers sit side by side.

## Consequences

- Two build outputs, two `manifest.json` files, two deploy commands, and —
  if published — two separate Obsidian marketplace submissions. This
  operational cost is accepted.
- Mobile scope is deliberately narrow: reading a Figure Interpretation
  Note, creating a Literature Card from a selection, and cycling Reading
  Status. It does **not** read PDFs, export, run MinerU, or use the
  Browser Connector.
