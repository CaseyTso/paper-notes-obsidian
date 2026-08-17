# Topic MOC notes are created only through the paper-notes CLI

The plugin's Topic MOC View offers a "Create Topic MOC" action in the UI,
but the file is written by `paper-notes moc create`. This keeps the rule
that managed vault writes have one engine (validation, conflict detection,
atomic create). See also the core ADR
[`0001-moc-create-via-cli.md`](../../paper-notes/docs/adr/0001-moc-create-via-cli.md).

The rejected alternative was `vault.create` inside the plugin: shorter for
v1, but it would be a second writer and would have to be re-done the moment
rows or cards become writable from the panel.
