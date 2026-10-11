# Paper Notes Obsidian — Agent Instructions

## Deployment

After any feature update, deploy the built plugin to the local Obsidian vault:

```sh
cp main.js manifest.json styles.css "/Users/juicewrld/Downloads/obsidian/知识库/.obsidian/plugins/paper-notes/"
```

Build first with `npm run build` to regenerate `main.js` and `styles.css`.

## Testing

- Full suite: `npm test`
- TypeScript check: `npm run typecheck`
- Focused filter chain: `npm test -- tests/library-shell-batch1.test.ts tests/library-view-lifecycle.test.ts tests/library-filter-view.test.ts tests/library-filter-panel.test.ts tests/library-filter-form.test.ts tests/library-filter-draft.test.ts tests/library-query.test.ts tests/library-layout.test.ts`

## Project Structure

- `src/views/literature-library-view.ts` — main library view (filter toolbar, drawer, table)
- `src/components/library-filter-panel.ts` — anchored filter popup overlay
- `src/components/library-filter-form.ts` — filter form with draft state
- `src/components/library-filter-draft.ts` — draft validation and matching logic
- `src/components/library-filters.ts` — filter types and CAS/JCR rank matching
- `tests/library-filter-*.test.ts` — unit and integration tests
