# Fixed synthetic Office conversion inputs

`fixed.docx`, `fixed.xlsx`, and `fixed.pptx` were authored using AllRice's existing `createOffice` with synthetic Chinese labels, identifier `00123`, and amount `210.5`. They contain no user or company data.

`fixed.doc`, `fixed.xls`, and `fixed.ppt` are unchanged binary fixtures from the official Harness commit `687f282e8625c6b8d11ff58211a90524be2e4317` (`apps/web/tests/fixtures/office/preview.*`). Their original README says they contain `Office preview 中文文档` and were exported from Harness-authored OOXML using LibreOffice 26.8.0.3's Office 97 filters. These three source documents retain the Harness MIT license in `LICENSE.harness`. The original fixtures also live in <https://github.com/deepseek-ai/dsh-libreoffice-kit>.

`provenance.json` records exact source hashes. The compiled acceptance command is `node scripts/acceptance/office-to-pdf.mjs`; it checks actual conversion, selectable Chinese/numbers, fixed-version cache reuse and reader cancellation. It does not call a model, use a company account, start the managed Office VM, or claim complex-document fidelity. XLS/XLSX conversion here exercises the existing PDF provider; their workbench preview remains the spreadsheet viewer.
