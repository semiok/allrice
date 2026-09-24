# PowerPoint presentations

Adapted from DeepSeek Harness Office PPTX guidance; source and MIT notice are in `references/provenance.md` and `references/LICENSE.dsh` in this bundle.

## Available workflow

- Read a source PPTX with `workspace_document_read` and preserve slide labels. Text extraction does not inspect positioning, animation, embedded workbooks or visual balance.
- For a new PPTX, call `workspace_export_create` with `format: "pptx"`. Set complete text in `content`; `#` and `##` headings start slides, with following lines used as the slide body.
- Plan one main point per slide. Keep titles concise, bodies readable, and Chinese punctuation and numeric units consistent. Keep sources and unverified assumptions explicit.
- The current generator supports text slides, up to 50 slides and 5,000 body characters per slide. Stay well below those limits; do not silently lose content. Native charts, tables, media and preserved templates are not supplied by this text export.
- Return the actual download link after export. Use `parentObjectId` and `changeSummary` to version a revised generated deck. A new version is not a binary-preserving edit of the old deck.

## Principles for richer editing

Upstream recommends inspecting slide shapes, layouts and related parts before targeted edits. Preserve runs where possible, use native editable charts/tables for new content, and keep chart data consistent with embedded workbooks. Rebuilding a deck can discard animation, SmartArt, notes and other features.

Render and inspect slides before claiming visual quality when a renderer becomes available. At present, tool success and extracted text alone do not prove correct spacing, fonts, alignment or absence of overflow.
