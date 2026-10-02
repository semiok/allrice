# MET164 / MET166: M5 native execution

The M5-Max.local acceptance device runs macOS 26.6.2 on arm64. Building an ARM
archive on Intel did not make the previous release usable: PDF registration and
managed Python preparation were both limited to macos-x64.

Bridge 0.6.0-dev.20 registers architecture-specific PDF resources and the native
ARM managed Python archive. Preparation selects the matching pinned Colima,
Lima, Docker and guest image. Device readiness still requires actual native
execution, immutable resource checks and observed process termination.

The existing PDF reader is reused unchanged: pdf-parse 2.4.5, PDF.js 5.4.296 and
canvas 0.1.80, with the same fixed Seatbelt guardian. Real M5 checks passed for
Chinese page selection, the original table strings, malformed input rejection,
host read/write/network/process isolation and physical cancellation.

Office still uses the original @deepseek-ai/dsh-skill-office@0.1.7-alpha.2
checker and the existing 21 pinned Python packages. Its native ARM image is
`sha256:236473556f8fd8eeaddd0f48a12c609c409d278e4d1c03aaf5333a1074db1b45`.
The reviewed archive is 148679127 bytes, with checksum
`sha256:4c6ad570743d7d3607d57c127d274e8348c1af5e5504ac9b3d3117410ec660e8`.
Actual managed VM preparation, DOCX/XLSX/PPTX, Chinese PNG and Python cancellation
passed on M5. Formula recalculation and Office-to-PDF retain their existing cloud
integration; this change does not claim a new local converter.

Native release building exposed two operator defects: the local probe required a
cloud-only runsc installation, and Docker cache hits omitted the build-step stdout
used as its proof. The operator now uses the local OCI runtime and verifies the
persisted image proof with the real native probe. Checks on dependencies,
licenses, generated files, read-only execution and resource limits remain active.

Acceptance evidence is retained under the private delivery record
`m5-arm-validation-20261002`, including the original failures. A test fixture that
declared three Office outputs was corrected to the existing one-output contract;
the product contract was not widened. Snow's occupied pairing was preserved.

This supplements the Intel acceptance. Windows and the later MET164/MET166 work
remain outside this delivery. Dev end-to-end acceptance is recorded in the issue
after the merged release is deployed.
