# AllRice license decision

> Decision: **Apache License 2.0**
>
> Status: **Adopted for the repository**
>
> Date: **2026-08-05**
>
> Linear: **MET-40**

## Decision

AllRice source authored in this repository is distributed under the Apache License 2.0. The canonical terms are in the root [`LICENSE`](../../LICENSE) file, and the root package declares the SPDX identifier `Apache-2.0`.

## Rationale

- OpenRice is Apache-2.0, so the same license minimizes friction for any future file-level extraction that passes the MET-40 provenance gate.
- Apache-2.0 permits internal, hosted, self-hosted and commercial use without forcing downstream applications to publish unrelated source.
- Its explicit patent grant and contribution terms are preferable for an enterprise AI product with multiple contributors.
- AllRice remains an independent work. Selecting the same license does not authorize wholesale OpenRice copying or remove file-level attribution and dependency review.

## Attribution policy

- Every copied or modified upstream file must record repository, commit, path, license, dependencies, modifications, tests and maintenance owner in its pull request.
- Required copyright, patent, trademark and attribution notices must be retained. Modified Apache-licensed files must be marked as changed.
- OpenRice has no root `NOTICE` file at the audited commit. If a future source or dependency includes one, AllRice must preserve the applicable notices and introduce an AllRice `NOTICE` file before distribution.
- Skills, generated assets, datasets and third-party packages keep their own licenses; the AllRice license does not replace them.

## Current dependency review

The 0.1 production dependency inventory is predominantly MIT, Apache-2.0, ISC, BSD, 0BSD and Unlicense. Two transitive distribution items require their existing terms to be preserved:

- `@img/sharp-libvips-darwin-x64` is LGPL-3.0-or-later and is an optional platform binary pulled through the Web image/toolchain;
- `caniuse-lite` data is CC-BY-4.0.

Neither changes the license of AllRice-authored source. Release packaging must retain third-party license notices and should generate an SBOM/license report. New GPL, custom or unknown dependencies remain review gates.

## Scope

This is an engineering license decision and dependency inventory, not legal advice. Branding and trademarks are not granted by Apache-2.0. Customer data, generated content and separately licensed Skills are outside the repository source-license grant.
