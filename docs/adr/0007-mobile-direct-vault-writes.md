# Mobile plugin writes the vault directly, exempt from the CLI-sole-writer rule

The desktop plugin enforces a strict invariant — *the CLI is the sole
writer*: no plugin code calls `vault.create` / `vault.modify`; every managed
mutation (Literature Card create, `reading_status` update, Topic MOC
create, …) goes through the `paper-notes` CLI so validation, formatting,
and conflict handling live in one engine (see ADR
[`0002-topic-moc-create-via-cli.md`](0002-topic-moc-create-via-cli.md)).

The CLI cannot run on Obsidian Mobile, and the mobile usage scenario
(reading on the move, computer off) rules out delegating writes to a
running desktop. We therefore grant the **mobile plugin an explicit
exemption**: it writes the vault directly via Obsidian's vault API —
`app.fileManager.processFrontMatter()` for `reading_status`, and direct
file writes for creating a Literature Card and inserting its Card Anchor.

This makes the system **two-writer**: the desktop plugin keeps writing via
the CLI (unchanged), while the mobile plugin re-implements the same write
logic in TypeScript. Card frontmatter format, Card Anchor rules, and
`reading_status` values must be kept byte-identical between the CLI and the
TS re-implementation, which is why both live in the same repo (see ADR
[`0006-dual-plugin-mobile-companion.md`](0006-dual-plugin-mobile-companion.md)).

## Considered Options

- **Queue intent on mobile, apply on next desktop session** — keeps the
  sole-writer rule and is simplest, but rejected: the user explicitly
  requires card creation and status cycling to take effect *immediately*
  on the phone, not after returning to a desktop.
- **Route mobile writes to a running desktop over the network** — keeps
  the CLI as the one engine, but rejected: the user's computer is off
  during mobile reading, so there is nothing to route to.
- **Lift the write logic into a shared core used by both the CLI and the
  plugin** — cleanest long-term (one writer again, one format), but
  rejected for v1: it reframes "add a mobile mode" as "refactor the core
  write layer," too large a blast radius. Remains the right eventual
  direction.

## Consequences

- Two write paths exist permanently; any change to card format, anchor
  rules, or `reading_status` values must be mirrored in both the CLI and
  the TS re-implementation, or the desktop CLI may choke on mobile-written
  files.
- The Card Anchor's UTF-8 byte-offset insertion, done on desktop via
  `view.save()` + a temp file + `adapter.getBasePath()`, must be
  re-implemented on mobile with pure vault APIs (`getBasePath()` returns
  `undefined` on mobile) and verified against mobile editor selection and
  save behaviour — the main technical risk.
