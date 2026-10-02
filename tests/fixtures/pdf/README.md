# Synthetic PDF reader fixtures

These six immutable PDFs contain synthetic Chinese names, dates and ledger rows.
They were authored with pdfkit 0.17.2 before the reader implementation. The
independently authored `expected-source.json` supplies the page anchors and cell
matrices; it was not populated from parser output. `manifest.json` records the
original input sizes and SHA-256 checksums.

| File                               | Pages | Expected behavior                                                                                                                                                     |
| ---------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-chinese-multipage-digital.pdf` | 3     | A request for page 2 returns its Chinese text and no content from pages 1 or 3.                                                                                       |
| `02-ruled-invoice-table.pdf`       | 1     | Preserve all five columns as strings, including `00123`, `-200.00` and the missing value `—`. The independently authored total is 1400.50 across three valid amounts. |
| `03-cross-page-ruled-table.pdf`    | 2     | Preserve two physical page fragments and repeated headers. Do not automatically merge them into a confirmed table.                                                    |
| `04-scanned-image-only.pdf`        | 2     | Contains only raster images of the first two digital pages. Report no extractable text; do not claim OCR.                                                             |
| `05-password-protected.pdf`        | 1     | Report a password requirement, not a malformed document or empty success. Its password in the annotation is public synthetic test data.                               |
| `06-borderless-layout.pdf`         | 1     | Preserve text and explain that no table structure was detected. The manual visual matrix is an expectation, not a license to invent columns.                          |

The generated PDF content and annotations are contributed under the repository's
Apache-2.0 license. The PDFs embed a subset of Noto Sans CJK SC from
NotoSansCJK-Regular.ttc, SHA-256
`b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`.
The upstream font license and notices are preserved in `FONT-LICENSE.txt`.
Font provenance and the original generator checksum are in the manifest. The
full font, raster previews, generator dependencies and report-conversion inputs
are deliberately excluded from this small fixture directory.

Tests may use the manual annotation to verify extraction. A real employee
acceptance Run must receive only the PDF attachments, not these answers. Actual
StorageObject and artifact-version identifiers must come from the platform;
none are invented here. These parser fixtures do not prove native Bridge or Dev
acceptance.
