# ADR 0004 — PDF acquisition runs through the paper-fetch CLI; paper-notes stays the only vault writer

- 日期：2026-08-18
- 状态：Accepted（用户确认，grill-with-docs 第 3 轮）

The Fetch PDF action obtains a PDF outside the vault with `paper-fetch fetch --json --no-zotero`, verifies the returned identity against the paper's metadata, then attaches the file as the Primary PDF through the existing paper-notes CLI (`item attach-pdf`). Extending the paper-notes CLI with a fetch subcommand was rejected: acquisition sources (open access, institution proxy, Sci-Hub, ableSci) and their browser/cookie flows belong to the separate paper-fetch tool, and merging them would blur paper-notes' role as the single managed writer. Delegating the happy path to the paper-fetch skill/agent was also rejected, because the source cascade and PDF validation are already implemented deterministically inside the CLI.

## Consequences

- The plugin now depends on two CLIs (`paper-notes` and `paper-fetch`), each behind its own configured path.
- The plugin never writes `~/.paper-fetch/config.json`; any future config change needs an explicit consent surface and an update to this ADR.
- Structured edge states (`challenge_required`, `authentication_required`, `pending`, `poll_timeout`, `all_sources_failed`) surface as notices with actions instead of being silently retried; `all_sources_failed` points to the paper-fetch skill fallback ladder.
- Fetch PDF remains disabled for items that already have a Primary PDF, and for items whose only identifiers are arXiv or a plain URL (paper-fetch supports DOI/PMID/PMCID/title/citation/Zotero key).
