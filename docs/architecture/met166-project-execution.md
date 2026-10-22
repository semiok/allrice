# Saved project execution

`workspace.project` owns source versions and the canonical `execute` call. The Worker binds its call ID, exact source/lock version and original job attempt/lease to one recorded location and operation. Backend IDs, images, grants and receipts are server-owned fields, never model arguments.

Ready local project runtimes take priority. Busy or preparing runtimes wait. Missing, offline or unsupported runtimes may use the actual dedicated runsc cloud backend when the frozen employee has that backend and the user has allowed the source transfer. A model preference cannot override a real local-only instruction. A bound operation, installation error or uncertain execution never switches backend or creates another attempt.

`@allrice/project-runtime` contains the common release-pinned manager download, exact source validation, dependency preparation, bounded cache, staging and trusted supervisors. Bridge retains its existing local VM lifecycle. Cloud uses its existing slot, create/start, lease, stop, receipt and recovery lifecycle. The cloud command deadline includes manager/archive preparation, staging, installation and command execution and is capped at 60 seconds.

Cloud stages files after starting the trusted supervisor into a private 128 MiB tmpfs work volume. The final trusted marker permits installation and execution; tenant code runs as UID 1000 with no network or host bind mounts. Public package archives are hash verified before staging. Cache mutation and active use are fenced across Workers on the same daemon; cache identities include the tenant, owner, project, lock and runtime image.

Private physical receipts must match source, lock, platform, image, cache identity and installation state. Cancellation after installation preserves the measured installation result. Create/start acknowledgement uncertainty remains `unknown`, without replay. A missing physical attempt is not proof that an in-flight create completed: recovery retains that journal until a definite not-started fact or a physical attempt can be stopped and reclaimed. Named work volumes are explicitly deleted before cleanup is confirmed.

This slice executes the saved version without publishing build outputs or saving runtime edits. Build/test/fix delivery and persistent preview services are subsequent MET166 slices. macOS Intel and ARM use the same preparation module; Windows is deferred.

## Source package disclosure

`workspace.project` `deliver` publishes the exact immutable snapshot as `project-source.zip`. Its artifact entry includes `sourcePackage.kind = source-only`, the exact project reference and source digest, the published object/version/checksum, and every archived file's path, length and SHA-256. The inventory comes from the same authorized `snapshot.files` used to produce the ZIP. It does not read the execution directory or collect dependencies; generated files are present only if they were explicitly saved in that source version. Existing ZIP bytes, publication calls, parent lineage and replay behavior are unchanged.

The inventory describes what was shipped. It does not certify README claims, business correctness or complete user delivery. The project-development Skill requires comparing each package's claimed contents with its actual inventory, distinguishing shipped files from later build results and separately delivered artifacts, and naming a primary delivery and alternatives for the user's goal using exact receipts. A working download link, a source file that can regenerate an output, or a model's description of a package as complete cannot prove that the output was included in that package.
