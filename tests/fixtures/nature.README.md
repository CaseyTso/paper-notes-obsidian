# Nature CSL regression fixture

`nature.csl` is an unmodified copy of the public Citation Style Language
Nature style, retrieved from:
https://raw.githubusercontent.com/citation-style-language/styles/master/nature.csl

Style ID: http://www.zotero.org/styles/nature
Upstream `<updated>`: 2026-08-07T18:26:21+00:00
SHA-256: cb69522b83d8eee0eab9a06d1255ea40fe2cc1bbd85b22bbf94097129119dc0e

Authors/contributors and the CC BY-SA 3.0 attribution/license declaration
are preserved in the XML. License: https://creativecommons.org/licenses/by-sa/3.0/
This fixture is used only by offline synthetic export regression tests;
it neither installs nor changes the user's selected CSL style.

To retain real export evidence in a fresh temporary fixture directory:

```sh
PANDOC_TEST_ARTIFACTS=/tmp/paper-notes-export-evidence npx vitest run tests/pandoc-issn.integration.test.ts
```

The suite reports the generated directory, containing the original source
records, legacy invalid array bibliography, repaired whole-library CSL JSON,
Nature CSL, Markdown, DOCX, Typst source, PDF, extracted text (when
`pdftotext` is available), and command/result evidence. Without this environment
variable all temporary artifacts are removed. Pandoc and Typst tests are
explicitly skipped if those binaries are unavailable. All records are synthetic.
