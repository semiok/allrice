# Office provenance and integration

Upstream: https://github.com/deepseek-ai/deepseek-harness

Pinned revision: `00102833dfaee1da9f48a3a8eae9d34005a75218`.
Package: `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`, MIT.
The exact upstream license is preserved in `references/LICENSE.dsh`.
The DSH engine is unchanged. This package version is explicitly alpha; reuse is verified against real files rather than inferred from its release label.

## Reused unchanged

The package's three `assets/office-{docx,xlsx,pptx}/SKILL.md` files are copied byte-for-byte to `references/{docx,xlsx,pptx}.md`. Its `assets/scripts/check_office.py` is copied byte-for-byte to `scripts/check_office.py` and actually executed after each native export. Resource checksums in the bundle record the exact bytes. These three guides remain internal resources of **one Office Skill**, not three administrator-facing Skills.

The native workflow uses python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2 and pandas 2.3.3, installed when building `infra/docker/Dockerfile.office-sandbox`. The image digest is pinned in the Worker. No dependency installation occurs in a document task. Package licenses remain in the image's installed distributions.

## Thin Allrice adapter

`workspace_export_create.python` maps authorized storage objects into an isolated task workspace and returns the resulting document through the existing export pipeline. It selects a ready Bridge's managed Python VM first, with the existing cloud sandbox as authorized fallback. Both reuse their existing lifecycle, cancellation, resource limits and watchdog. They expose no arbitrary host files, credentials or network. There is no new document operation DSL and no new model or upstream engine fork.

Office 1.6 adds the canonical `python_execute` tool for local-first calculations and PNG delivery, reusing the same fixed Python libraries, Matplotlib, Pillow checker and CJK fonts. It adds a checksum-bound PNG report and uses existing file versions and downloads, then passes the exact same PNG object into the unchanged upstream DOCX/PPTX workflows. The canonical tool is independent of legacy Node cloud commands. Previously frozen Skill versions and their original tool authority remain unchanged. No second chart renderer, dependency installer or separate Office Skill is introduced.

Office 1.7 reuses the already installed `@deepseek-ai/dsh-office-to-pdf@0.1.7-rc.1` provider through `@allrice/office-runtime/preview`. The provider owns Office conversion, admission, cache and cancellation; Allrice only supplies the exact authorized DOCX/XLSX/PPTX source and publishes the returned PDF bytes. `workspace_export_create.officePdf` retains the Office object/checksum as its immediate source and starts a separate PDF version series. It neither regenerates the report nor replaces the original Office file. Real `missingFonts` are preserved even when the system fallback renders readable text; successful conversion is not a layout or business-data certification.

PDF reading uses the same pinned `pdf-parse@2.4.5`/PDF.js reader on the Worker and supported Bridge. The Bridge's read-only PDF capability is independent of its Python runtime. Office-to-PDF is a separate capability: the current Bridge reader/Python runtime does not claim to provide that converter. A ready Bridge performs the steps it supports; only the required conversion uses the authorized server provider, unless the original task requires local-only processing or non-migratable local inputs. Selection uses the existing frozen Run, original user message, job lease and execution-choice rules, not a model-supplied override of data authority.

Allrice contributes tenant file authorization, source/version history, downloads, formula-cache updates and page previews. The root Skill explains this environment and the upstream guides' supported fallback paths. It also retains the prior document-reading and non-Office delivery workflows. Generic cloud command execution retains its separate existing policy and ledger; a managed Office export only publishes the requested document through the existing managed-write tool.

Previously frozen Office 1.0–1.2 employee packages retain their legacy export compatibility handler. Office 1.3 and later use native Python by default. Legacy typed editing is no longer developed as a parallel implementation; compatibility can be removed once no published package or active run refers to it. Historical artifacts are ordinary stored files and need no old editor to view or download.

## Checks and previews

Upstream's checker validates package structure, relationships and requested string/count assertions; it does not calculate formulas or judge appearance. Allrice's existing LibreOffice/Poppler renderer recalculates normal/shared formulas and supplies bounded page previews. It does not certify business accuracy, native Excel appearance, or visual review. Formula errors and unavailable checks are reported honestly. The native workflow adds workbook print-area/scaling instructions to prevent the extra chart page found in the comparison.

The renderer runs conversion copies with macros and external updates disabled and without IP sockets. Formula caches are patched into the workbook; DOCX/PPTX source bytes are retained. Renderer code, download/version UI and the fixed renderer image remain reusable platform integration, not replacement Office editors.

## Verification and rollback

The comparison used the same three source documents and model configuration. Native Office handled Word styling, Excel conditional formatting/charts, and PowerPoint chart/notes changes which the old typed edit interface could not perform. Native formula-cache and print-layout gaps are handled by the existing Allrice quality pipeline and workflow instructions. One comparison is not a statistical speed or reliability claim.

Roll back application and catalog together if needed. Already published employee versions are frozen and must be revised explicitly; neither catalog synchronization nor rollback silently mutates a published snapshot.
