# Default employee Skill catalog

New ordinary and custom employee Runs receive the enabled, reviewed Skills in
the platform's synchronized `skills/catalog.json` catalog. Employees no longer
need a separate binding for each foundation method. This is method availability;
it does not grant tools, file access, connectors, Bridge folders or executors.

`prepareEmployeeRunBinding` first computes the original publication's grants.
Only then does `freezeEmployeeBaseSkills` consistently read catalog metadata and
reviewed rows, verify contents/bundles, and merge the foundation methods. Catalog
IDs use the catalog version for new Runs; non-catalog employee-specific methods
retain their published version. Conflicting names or identities, inconsistent
metadata and count/byte budget overflow fail explicitly. Disabled or unreviewed
catalog entries are excluded, including copies in an older employee package.

The existing `execution_snapshot.baseSkillCatalog` stores catalog and resolved
snapshot checksums, Skill identity/version and governance. The existing
`native_skills` stores the corresponding immutable content and bundled resources.
The employee publication/package and historical Run JSON remain unchanged.
Deployments predating `content:sync` retain their existing package until their
first catalog synchronization; no default catalog is invented.

DSH still performs native progressive list/get loading. Only methods whose
required tools are both authorized and active in this turn enter the model's
directory. A default method unavailable under the current permissions does not
appear as a failed action. Initial registration says `Skill 已就绪`; only a real
native `skill` result says `Skill 已加载`, with frozen ID/version/content checksum
and catalog checksum in its existing event. Failed loads retain failure status.

Ordinary catalog updates, disables and review changes affect **new Runs**.
Existing Runs retain their frozen versions on replay/retry; malformed new
snapshots cannot fall back to legacy permission calculation. This catalog is
public platform content, not company/private knowledge. Existing instance and
resource authorization gates continue to apply. Scoped content/scene loading and
its current-authority checks belong to MET179 PR3b; this change does not claim
those are delivered or alter automatic repair/release behavior.

Deterministic coverage uses isolated PostgreSQL and native adapter fixtures:
ordinary/custom Runs, unchanged grants/publications, resources and historical
snapshots, catalog update/retry, rejection/collision/budget, and actual directory
versus native load events. Dev acceptance additionally uses ordinary accounts,
real model Skill loads, existing export tools, artifact pages and downloads.
