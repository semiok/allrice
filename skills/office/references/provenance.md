# Office provenance and adaptation

Upstream: https://github.com/deepseek-ai/deepseek-harness

Pinned revision: `00102833dfaee1da9f48a3a8eae9d34005a75218`.
Package: `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`, MIT.
The upstream copyright notice is preserved in `references/LICENSE.dsh`.
AllRice integration and original workflow use Apache-2.0; adapted guidance retains MIT attribution.

| AllRice resource     | Upstream path                                             | Upstream file SHA-256                                              |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `references/docx.md` | `packages/skill/skill-office/assets/office-docx/SKILL.md` | `6ffd5866a8b025dbb02638be193ac5fe9908148f6c2a557dea74347aad5e0dc2` |
| `references/xlsx.md` | `packages/skill/skill-office/assets/office-xlsx/SKILL.md` | `b8394b54de0d14c90e6377351c7cf871753cede404528c031abf8b056f96880a` |
| `references/pptx.md` | `packages/skill/skill-office/assets/office-pptx/SKILL.md` | `56c3eb3a6e1a8d9abebd245f6d117c2c7614b9cb87fb73d22939116d8288ceb3` |

## Modifications

The three upstream Skill entry points become internal references of one AllRice Office Skill. The root workflow incorporates AllRice document-analysis 1.0.1 and structured-deliverable 1.2.1, both Apache-2.0. Guidance is rewritten for AllRice's actual document reader, export tool, tenant storage, frozen bundles and artifact versions. It distinguishes current text-oriented generation from future binary-preserving editing.

No upstream Python script or runtime code is copied or executed in this release. DSH dependency-loading, Shell, render_document and present calls are not available in this integration and are not included as callable instructions. Source downloads were inspected at the pinned revision, not resolved at runtime.

## Runtime dependencies

Four existing broker tools: workspace.file.list, workspace.document.read, workspace.skill.read and workspace.export.create. Reading uses the existing PDF/text/image and Mammoth, ExcelJS and JSZip paths. Export uses the existing docx, ExcelJS, PptxGenJS and PDFKit dependencies at pnpm-lock.yaml versions. No Python, network installation, new package dependency or engine upgrade is introduced.

## Follow-up and rollback

MET-157 PR2 covers richer creation and targeted editing; PR3 covers formula and rendered visual checks. Structural or text extraction success must not be represented as those checks. Existing published and running packages keep their original Skill IDs, bodies and checksums. Restore the previous catalog and application version together to undo the default draft migration; already published Office packages remain frozen and require an explicit employee revision rollback.
