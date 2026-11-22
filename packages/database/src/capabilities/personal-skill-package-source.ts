import {
  EmployeeModuleScopeSchema,
  PersonalSkillDefinitionSchema,
  PersonalSkillPinSchema,
  RequestContextSchema,
  type PersonalSkillDefinition,
  type PersonalSkillPackage,
  type PersonalSkillPin,
  type RequestContext,
} from '@allrice/contracts';
import type { Sql } from 'postgres';
import type { z } from 'zod';
import { DataAccessError } from '../data.ts';
import {
  personalSkillPinState,
  unavailable,
  validPackage,
} from '../employees/personal-skill-model.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { skillBytesChecksum } from '../skill-bundles.ts';

export type PersonalSkillPackageRead = {
  pin: PersonalSkillPin;
  installationVersion: number;
  definition: PersonalSkillDefinition;
  bodyBytes: Uint8Array;
  bodyChecksum: string;
  /** Descriptors only: this read does not open the archive or its resources. */
  manifest: PersonalSkillPackage | null;
};
type Host = {
  context: RequestContext;
  scope: z.infer<typeof EmployeeModuleScopeSchema>;
  /** Host-only closure bound to the same RC/target/scope. It must await the
   * owner's currentEmployeeBusiness call, including actual cancellation. */
  requireCurrent(signal: AbortSignal): Promise<void>;
};
type Pending<T> = PromiseLike<T> & { cancel(): void };

/** Join actual SELECT/current promises. No driver transaction scope is started. */
async function joined<T>(
  signal: AbortSignal,
  work: (query: <R>(pending: Pending<R>) => Promise<R>) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const failures: unknown[] = [];
  const query = async <R>(pending: Pending<R>): Promise<R> => {
    const cancel = () => pending.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const result = await pending;
      signal.throwIfAborted();
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  try {
    const result = await work(query);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
    const errors = failures.filter(
      (item, index) =>
        failures.indexOf(item) === index &&
        (!signal.aborted || item !== signal.reason),
    );
    if (signal.aborted) errors.push(signal.reason);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'personal_skill_package_read_failed', {
      cause: errors[0],
    });
  }
}

function assertPinState(
  row:
    | { definition_checksum: string; package_checksum: string | null }
    | undefined,
  pin: PersonalSkillPin,
) {
  if (
    !row ||
    row.definition_checksum !== pin.definitionChecksum ||
    (row.package_checksum ?? undefined) !== pin.packageChecksum
  )
    return unavailable();
}

/** Concrete owner storage source, not a production identity/provider mount.
 * The host supplies current authority; parsing context/pins grants no rights.
 * Caller retains its SQL client. This factory opens no background resources. */
export function createPostgresPersonalSkillPackageSource(db: Sql, host: Host) {
  const scope = EmployeeModuleScopeSchema.parse(host.scope);
  const originalContext = RequestContextSchema.parse(host.context);
  const requireCurrent = host.requireCurrent;
  const context = { ...originalContext, workspaceId: scope.workspaceId };
  return {
    async readPackage(
      input: unknown,
      signal: AbortSignal,
    ): Promise<PersonalSkillPackageRead> {
      return joined(signal, async (query) => {
        const pin = PersonalSkillPinSchema.parse(input);
        if (context.actor.type !== 'user')
          throw new DataAccessError('authentication_required');
        if (
          originalContext.workspaceId !== null &&
          originalContext.workspaceId.toLowerCase() !== scope.workspaceId
        )
          throw new DataAccessError('authorization_denied');
        if (
          pin.organizationId.toLowerCase() !==
            context.organizationId.toLowerCase() ||
          pin.ownerId.toLowerCase() !== context.actor.id.toLowerCase() ||
          pin.instanceId.toLowerCase() !== scope.instanceId ||
          typeof requireCurrent !== 'function'
        )
          return unavailable();
        await requireCurrent(signal);
        signal.throwIfAborted();
        // Binding eligibility and exact body share one statement snapshot.
        // Retain the compact guard predicates and the prior body owner scope.
        const [version] = await query(db<
          {
            version: number;
            definition: unknown;
            definition_checksum: string;
            resource_manifest: unknown;
            package_checksum: string | null;
          }[]
        >`select v.version,v.definition,v.definition_checksum,v.resource_manifest,v.package_checksum
          from allrice_personal_skill_bindings b
          join allrice_personal_skill_installations i on i.id=b.installation_id and i.state='installed'
          join allrice_personal_skill_versions v on v.installation_id=i.id and v.id=${pin.versionId}
          where b.id=${pin.bindingId} and b.instance_id=${pin.instanceId} and b.installation_id=${pin.installationId}
            and b.organization_id=${context.organizationId} and b.workspace_id=${context.workspaceId} and b.owner_id=${context.actor.id}
            and b.enabled and b.epoch=${pin.bindingEpoch}
            and v.organization_id=${context.organizationId} and v.owner_id=${context.actor.id}
            and v.installation_id=${pin.installationId}`);
        if (!version) return unavailable();
        assertPinState(version, pin);
        const definition = PersonalSkillDefinitionSchema.parse(
          version.definition,
        );
        const bodyBytes = new TextEncoder().encode(definition.content);
        const bodyChecksum = skillBytesChecksum(bodyBytes);
        if (
          runtimePolicyDigest(definition) !== pin.definitionChecksum ||
          bodyChecksum !== definition.checksum
        )
          return unavailable();
        const manifest =
          validPackage(
            version.resource_manifest,
            version.package_checksum,
            version.definition_checksum,
          ) ?? null;
        const prepared = {
          pin,
          installationVersion: version.version,
          definition,
          bodyBytes,
          bodyChecksum,
          manifest,
        };
        signal.throwIfAborted();
        await requireCurrent(signal);
        signal.throwIfAborted();
        // A separate statement sees revocation during current IO, without a
        // private begin()/rollback scope that can outlive its returned promise.
        const [binding] = await query(personalSkillPinState(context, pin, db));
        assertPinState(binding, pin);
        return prepared;
      });
    },
  };
}
