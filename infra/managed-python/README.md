# Fixed local Office and Python payload

This directory supplies the `managed-python-v1` image only. The existing cloud
Node, Python charts and Office images and their frozen mappings stay independent.
The client owns VM preparation, execution, leases and artifact transfer.

`requirements-{amd64,arm64}.lock` each fixes 21 wheel versions and one exact wheel
hash per package. The corresponding apt lock fixes the official Python base
child manifest, existing C++ library versions and the Noto font package bytes.
The Dockerfile installs from verified local inputs with build networking disabled.
It retains the original DSH Office checker, Pillow PNG checker and Noto Sans CJK
Regular font bytes, and generates the Agg font-cache seed after selecting that
font. `/opt/office` aliases `/opt/python`; the trusted checkers are available at
`/opt/allrice/check_office.py` and `/opt/allrice/check_png.py`.

Run the release operator from the repository root, with a fresh private output
directory and an explicit authorized Docker socket:

```sh
node scripts/build-managed-python-payload.mjs \
  --architecture amd64 \
  --socket unix:///absolute/managed/docker.sock \
  --output /absolute/private/runtime-payloads/amd64
```

The operator verifies downloaded bytes independently, builds its own image,
runs a named non-root probe with no network, a read-only root, 512 MiB memory and
64 PIDs, then saves a bounded gzip Docker archive and `source-proof.json`. The
probe checks real Chinese PNG generation and full Pillow decoding, rejects a
truncated PNG, reopens DOCX/XLSX/PPTX, runs the unmodified DSH checker and compares
the embedded Word/PPT image bytes. It also checks the spreadsheet formula and
retained package licenses. Noto, Python and DSH notices are retained alongside
wheel notices; two wheels lacking notices use their exact-version official source
archive licenses, recorded in `licenses/source.lock.json`.

The archive budget is 256 MiB; the unpacked image-layer budget is 512 MiB. On the
Docker 29 containerd store, the proof records compressed content, total image
storage and unpacked layers separately. The total store includes both compressed
and unpacked content. The release pins are the actual observed Engine image ID,
archive SHA/size, package lock, checkers and font, rather than a guessed pull tag.
The fixed inputs can be rebuilt, but legacy Docker build timestamps do not promise
a bit-identical new image ID. Keep the reviewed archive for the frozen release.

Only a byte-verified archive belongs in the static release allowlist. Its presence
does not imply runtime readiness: the client must verify the native architecture,
execute its real probe and confirm physical stop. ARM remains unsupported until
native execution is independently verified; a wheel lock or emulated build is
not that evidence. The client downloads only the server's fixed asset route.
