# Third-party notices

## obsidian-pandoc (OliverBalfour)

The focused academic Pandoc exporter in `src/services/pandoc-export.ts`
(DOCX/PDF export flow for academic manuscripts) is inspired by the
MIT-licensed [OliverBalfour/obsidian-pandoc](https://github.com/OliverBalfour/obsidian-pandoc)
project. Only the academic DOCX/PDF slice was adapted; the HTML-rendering
export path and unrelated output formats were not ported, and two upstream
weaknesses were fixed:

- Upstream splits free-form argument strings on spaces
  (`extraParams.flatMap(x => x.split(' '))`), which breaks quoted paths.
  Here every CLI argument is a separate array element passed to
  `child_process.spawn()` verbatim — configured paths containing spaces
  stay intact and no shell string is ever built.
- Upstream auto-picks the PDF engine and resolves success by
  file-existence rather than the process exit code. Here the configured
  engine is used, the exit code decides success, output is written to a
  temporary file and atomically promoted only on exit 0, and a nonzero
  exit preserves the previous artifact while surfacing stderr.

### MIT License (upstream)

Copyright (c) Oliver Balfour

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
