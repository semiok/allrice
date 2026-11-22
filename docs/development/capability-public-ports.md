# Capabilities: builtin Skill source port

MET-285 first slice exposes reviewed repository source content for later module
assembly. It does not install, register, load into a model, authorize, or execute a
Skill. DSH remains the Skill registry/loader and slash invocation owner.

This slice belongs to **MET-285 alone in batch/4.0-n5**, fixed base
`6eab934e51721a13f9b2537eca670ccffe0cb31d` / tree
`4405b347c306dbd2993f748b71525a150b50a729`. This supersedes older node-6 placement
in the historical preparation plan. No upstream dependency cherry-pick is needed.

## Public allowlist

These are the source-content subset of the proposed CapabilitiesPort, not its
complete employee catalog, installation, plugin, schedule, or management API.
The module owns the existing reviewed `skills/catalog.json`, bodies, bundles and
source resources. It creates no tables or runtime state. It does not read dynamic
tenant packages, employee publications, private storage, or another owner's SQL.

| Public entry         | Allowed symbols                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@allrice/contracts` | `BuiltinSkillSourceSelectorSchema`, `BuiltinSkillSourceResourceQuerySchema`, `BuiltinSkillSourceSelector`, `BuiltinSkillSourceResourceQuery`                                                                  |
| `@allrice/database`  | `createBuiltinSkillSourcesPort`, `BuiltinSkillSourcesPort`, `BuiltinSkillSourceDescriptor`, `BuiltinSkillSourceCatalog`, `BuiltinSkillSourcePackage`, `BuiltinSkillSourceResource`, `BuiltinSkillSourceError` |

Consumers must use these root exports. The internal `platform-content` reader,
parser, SQL helpers, and the rest of the database barrel are not newly allowed.
Existing `SkillBundleSchema` / `SkillResourcePathSchema` define bundle version,
resource format, checksum, path and size rules. No limits or engines are relaxed.
The public contract inherits the existing API-v1/ContractVersion-1 context; it
does not declare a new DSH generation or a network protocol.

```ts
createBuiltinSkillSourcesPort(rootDirectory?: string): BuiltinSkillSourcesPort
port.listSources(signal: AbortSignal): Promise<BuiltinSkillSourceCatalog>
port.readPackage(selector: unknown, signal: AbortSignal): Promise<BuiltinSkillSourcePackage>
port.readResource(query: unknown, signal: AbortSignal): Promise<BuiltinSkillSourceResource>
```

`rootDirectory` is trusted host composition, never a guest path. The default is
the existing repository source root. Neither source descriptors nor errors add
host absolute paths. Original source bodies retain their existing text, including
historical runtime path examples; that text does not configure a 4.0 runtime.

## Identity and results

The strict package selector requires `id`, exact `version`, `contentChecksum`,
and `bundleChecksum`. Explicit null means no bundle; omission is invalid.
Resource queries add the existing relative resource `path` and exact byte
`checksum`. Extra identity, employee, tenant, approval or filesystem fields are
rejected. Names and latest versions are not substitute selectors.

`listSources` returns the current source catalog schema/checksum and descriptors:
the selector, name/description, source and license/review provenance, original
declared tool references and resource metadata. `sourceEnabled` is only the
repository source flag. It is not enterprise permission or employee enablement.
The directory contains no bodies or resource bytes. `readPackage` returns that
exact body's canonical text and its original SkillBundle, or explicit null.
`readResource` returns real `Uint8Array` bytes with path/media type/byte length/
checksum and the package selector, not merely a receipt or metadata.

Every call reuses the existing reader, without a new cache. Complete body/bundle
pins must match; the reader revalidates source digest/governance, path, resource
bytes, size, symlinks/hardlinks, special files and opened-file identity. Scripts
are inert resources. Returning a package grants no execution permission.

There is no write, CAS, operation ID, event projection, lease, or persistent
stream. Source reads are storage-backend adaptation only; tenant gatekeeping,
installation approval and model-use audit remain with their actual owners.
The signal reaches real file reads. Cancellation waits for those operations and
the actual handle-close Promise; it does not race detached work or infer closure
from an abort flag. The public port preserves the caller's cancellation reason.
If a read/close failure prevents normal cancellation completion, it rejects an
AggregateError retaining that reason and a controlled source-unavailable error;
it does not claim closure. Owner-internal read/close errors preserve both causes.

`BuiltinSkillSourceError.code` is `source_unavailable`, `source_not_found`,
`pin_mismatch` or `resource_not_found`. Invalid inputs remain Zod validation
errors. Raw filesystem failures become `source_unavailable`, without path or
cause in the public error. Existing owner-internal reader diagnostics remain
unchanged. These are source errors, not MCP isError results or an API envelope.

## Preserved content and remaining composition

All 14 platform source bodies/versions, 17 resources and exact package pins stay
unchanged. Office `check_office.py`, charts, provenance and license remain
readable; operations-review's charts reference is not removed. Finance scripts
and sample CSV bytes are preserved without executing them. Native Office's seven
skills must be bound at the locked rc.2 generation and actual quality/resource
equivalence verified before duplicate content or the old checker is removed.

MET-272 v1 at `13c1b201da4f04acdf35359785f59b4f0cedd3f8` has only referenceRead,
memoryRead and deliverableCreate callbacks. This port adds none and registers no
second MCP server. MET-273's current qualification/config producer and a formally
published 272 extension are still needed for employee mounting; production stays
unmounted without them. Test doubles do not establish those production facts.
The installed employee directory must still intersect current enterprise,
employee, resource/operation permissions and explicit scene configuration.

No UI changes belong to this source slice; MET-286 owns presentation. No schedule
or wakeup implementation is included. No Skill-dedup, model-use, deployment or
acceptance claim follows from source reads or from the tests in this slice.
