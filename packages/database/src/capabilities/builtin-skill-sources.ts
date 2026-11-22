import {
  BuiltinSkillSourceResourceQuerySchema,
  BuiltinSkillSourceSelectorSchema,
  type BuiltinSkillSourceSelector,
  type SkillBundle,
} from '@allrice/contracts';
import {
  loadPlatformContentCatalog,
  type ResolvedPlatformSkill,
} from '../platform-content/catalog.ts';

export type BuiltinSkillSourceDescriptor = Pick<
  ResolvedPlatformSkill,
  | 'name'
  | 'description'
  | 'source'
  | 'sourceRef'
  | 'license'
  | 'reviewStatus'
  | 'reviewedByLabel'
  | 'createdByLabel'
  | 'modelInvocable'
  | 'userInvocable'
> & {
  selector: BuiltinSkillSourceSelector;
  /** Source catalog flag, never an enterprise/employee enablement decision. */
  sourceEnabled: boolean;
  /** Original source dependencies, not a 4.0 tool catalog or permission. */
  declaredToolRefs: string[];
  resources: Omit<SkillBundle['resources'][number], 'contentBase64'>[];
};
export type BuiltinSkillSourceCatalog = {
  schemaVersion: 1 | 2;
  catalogChecksum: string;
  sources: BuiltinSkillSourceDescriptor[];
};
export type BuiltinSkillSourcePackage = {
  source: BuiltinSkillSourceDescriptor;
  content: string;
  bundle: SkillBundle | null;
};
export type BuiltinSkillSourceResource = Omit<
  SkillBundle['resources'][number],
  'contentBase64'
> & {
  source: BuiltinSkillSourceSelector;
  bytes: Uint8Array;
};
export interface BuiltinSkillSourcesPort {
  listSources(signal: AbortSignal): Promise<BuiltinSkillSourceCatalog>;
  readPackage(
    selector: unknown,
    signal: AbortSignal,
  ): Promise<BuiltinSkillSourcePackage>;
  readResource(
    query: unknown,
    signal: AbortSignal,
  ): Promise<BuiltinSkillSourceResource>;
}

/** Source-specific errors, not an MCP result or a new global API envelope.
 * Filesystem paths and raw read errors stay out of the public payload. */
export class BuiltinSkillSourceError extends Error {
  constructor(
    readonly code:
      | 'source_unavailable'
      | 'source_not_found'
      | 'pin_mismatch'
      | 'resource_not_found',
  ) {
    super(`builtin_skill_${code}`);
    this.name = 'BuiltinSkillSourceError';
  }
}

function describeSource(
  skill: ResolvedPlatformSkill,
): BuiltinSkillSourceDescriptor {
  return {
    selector: {
      id: skill.id,
      version: skill.version,
      contentChecksum: skill.checksum,
      bundleChecksum: skill.bundle?.checksum ?? null,
    },
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceRef: skill.sourceRef,
    license: skill.license,
    reviewStatus: skill.reviewStatus,
    reviewedByLabel: skill.reviewedByLabel,
    createdByLabel: skill.createdByLabel,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    sourceEnabled: skill.enabled,
    declaredToolRefs: [...skill.requiredToolRefs],
    resources: (skill.bundle?.resources ?? []).map(
      ({ path, mediaType, byteLength, checksum }) => ({
        path,
        mediaType,
        byteLength,
        checksum,
      }),
    ),
  };
}

/** Host-only repository root, never a guest path. Reads reuse the existing
 * reviewed source validator and join its actual file reads/handle closes.
 * No cache, mutable registry, tenant data, installation, or native mounting. */
export function createBuiltinSkillSourcesPort(
  rootDirectory?: string,
): BuiltinSkillSourcesPort {
  const load = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    try {
      const catalog = await loadPlatformContentCatalog(rootDirectory, signal);
      signal.throwIfAborted();
      return catalog;
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      const unavailable = new BuiltinSkillSourceError('source_unavailable');
      // A read/close failure concurrent with cancellation is still a failure.
      // Retain the caller's reason without exposing private filesystem errors.
      if (signal.aborted)
        throw new AggregateError(
          [signal.reason, unavailable],
          'builtin_skill_source_cancellation_failed',
        );
      throw unavailable;
    }
  };
  const select = async (input: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    const selector = BuiltinSkillSourceSelectorSchema.parse(input);
    const catalog = await load(signal);
    signal.throwIfAborted();
    const skill = catalog.skills.find((entry) => entry.id === selector.id);
    if (!skill) throw new BuiltinSkillSourceError('source_not_found');
    if (
      skill.version !== selector.version ||
      skill.checksum !== selector.contentChecksum ||
      (skill.bundle?.checksum ?? null) !== selector.bundleChecksum
    )
      throw new BuiltinSkillSourceError('pin_mismatch');
    return skill;
  };
  return {
    async listSources(signal) {
      const catalog = await load(signal);
      signal.throwIfAborted();
      return {
        schemaVersion: catalog.schemaVersion,
        catalogChecksum: catalog.catalogChecksum,
        sources: catalog.skills.map(describeSource),
      };
    },
    async readPackage(selector, signal) {
      const skill = await select(selector, signal);
      signal.throwIfAborted();
      return {
        source: describeSource(skill),
        content: skill.content,
        bundle: skill.bundle ?? null,
      };
    },
    async readResource(input, signal) {
      signal.throwIfAborted();
      const { path, checksum, ...selector } =
        BuiltinSkillSourceResourceQuerySchema.parse(input);
      const skill = await select(selector, signal);
      signal.throwIfAborted();
      const resource = skill.bundle?.resources.find(
        (entry) => entry.path === path,
      );
      if (!resource) throw new BuiltinSkillSourceError('resource_not_found');
      if (resource.checksum !== checksum)
        throw new BuiltinSkillSourceError('pin_mismatch');
      return {
        source: describeSource(skill).selector,
        path: resource.path,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        checksum: resource.checksum,
        bytes: Buffer.from(resource.contentBase64, 'base64'),
      };
    },
  };
}
