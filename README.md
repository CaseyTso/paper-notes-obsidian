# paper-notes-obsidian

Independent Obsidian plugin (desktop only) for the
[paper-notes](https://github.com/CaseyTso/paper-notes) literature system.

The plugin provides the Obsidian-side reader, library index, search and
export UI; all managed mutations go through the paper-notes CLI over a
versioned JSON protocol. This repository is standalone and never talks to
the core repository at build time.

## Current status

Scaffold (Task 21): minimal plugin that registers the
`paper-notes-open-library` view type and an `Open literature library`
command. Functionality lands in subsequent tasks.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # node esbuild.config.mjs production
npm run verify      # typecheck + test + build
```

## License

MIT
