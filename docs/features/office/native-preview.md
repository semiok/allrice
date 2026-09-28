# DSH document preview

ChatFlow delivery tabs and workspace file tabs use DSH's pinned
`0.1.7-rc.1` document renderers. The PDF and Excel JavaScript chunks are served
unchanged; image zoom and HTML packing/isolation come from the same source
revision. `apps/web/app/dsh-upstream/upstream.json` records hashes and the small
host type/import patches. Run `pnpm dsh-ui:verify --source <dsh-checkout>` to
verify the source replay.

| File                                 | Reader                                                             | Native default                                            |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| PNG, JPEG, GIF, WebP, BMP, ICO, SVG  | Native image, fit width and zoom                                   | 32 MiB complete-file read                                 |
| PDF                                  | Native PDF.js, selectable text and zoom                            | 32 MiB input; 16,777,216 bitmap pixels per page           |
| DOC/DOCX, PPT/PPTX                   | Native `office-to-pdf`, then the same PDF reader                   | 50 MiB input, 100 MiB PDF output, 60 second conversion    |
| XLS/XLSX, CSV/TSV                    | Native spreadsheet worker and sheet selection                      | 16 MiB, 250,000 cells, 15 second parse                    |
| Markdown, UTF-8 text and source code | Markdown or native CodeBlock with incremental loading              | 5,000 lines / 2 MiB per page                              |
| HTML/HTM                             | Native sanitized static iframe; optional opaque interactive iframe | 32 MiB bundle; native asset caps of 64 files / 4 MiB each |

Audio, video, archives and upstream-listed unsupported binaries remain downloads.
SVG/HTML/CSV/TSV also expose their text source. The old 512 KB whole-text,
8 MB image/Office and eight-page preview limits no longer determine sidebar
admission. Native limits still apply; this is not unlimited file rendering.

AllRice supplies authorized immutable object bytes, verifies size/SHA-256 and
rechecks access after reads and conversions. Each text page is streamed and
hashed without retaining the full object. This object-storage adapter retains
the existing storage-read deadline; it does not expose DSH host filesystem APIs.
Versions and original-file downloads remain AllRice operations. A preview never
changes or recalculates the stored original.

HTML defaults to DSH's static mode. Interactive mode uses the native packer and
an opaque iframe with `allow-scripts`, without `allow-same-origin` or a host
bridge. Self-contained HTML works. Resolving sibling `.js`/`.css` files needs an
explicit object-storage relationship, which AllRice does not yet store: such
interactive previews fail rather than reading arbitrary workspace files. Native
DSH additionally supports those finite local dependencies when its session
filesystem reader supplies them. This is a remaining host-adapter difference.

The Office preview provider is exported through `@allrice/office-runtime/preview`
so the older Worker runtime does not load the newer DSH provider accidentally.
It owns conversion queueing, cache and cancellation. Existing isolated Office
generation checks and formula validation still run in the export workflow;
spreadsheet viewing does not claim to recalculate formulas or validate business
results.

Verification includes immutable-content/auth regressions, real native DOCX
conversion, simultaneous PDF/Excel tabs, sheet switching, mobile SVG/GIF,
static/interactive iframe behavior, and text paging under React StrictMode.
Dev acceptance must also verify actual stored files through authenticated routes.
