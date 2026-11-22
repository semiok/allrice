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

/** Join actual queries and the whole driver's transaction. A callback error
 * must be recorded before a distinct rollback failure can replace it. */
async function joined<T>(
  signal: AbortSignal,
  work: (
    query: <R>(pending: Pending<R>) => Promise<R>,
    recordFailure: (error: unknown) => void,
  ) => Promise<T>,
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
    const result = await work(query, (error) => failures.push(error));
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
      return joined(signal, async (query, recordFailure) => {
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
        const prepared = await db.begin(
          'isolation level repeatable read read only',
          async (tx) => {
            try {
              const [binding] = await query(
                personalSkillPinState(context, pin, tx),
              );
              assertPinState(binding, pin);
              const [version] = await query(tx<
                {
                  version: number;
                  definition: unknown;
                  definition_checksum: string;
                  resource_manifest: unknown;
                  package_checksum: string | null;
                }[]
              >`select version,definition,definition_checksum,resource_manifest,package_checksum
                from allrice_personal_skill_versions where id=${pin.versionId}
                  and installation_id=${pin.installationId} and organization_id=${context.organizationId}
                  and owner_id=${context.actor.id}`);
              if (!version) return unavailable();
              const definition = PersonalSkillDefinitionSchema.parse(
                version.definition,
              );
              const bodyBytes = new TextEncoder().encode(definition.content);
              const bodyChecksum = skillBytesChecksum(bodyBytes);
              if (
                version.definition_checksum !== pin.definitionChecksum ||
                (version.package_checksum ?? undefined) !==
                  pin.packageChecksum ||
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
              return {
                pin,
                installationVersion: version.version,
                definition,
                bodyBytes,
                bodyChecksum,
                manifest,
              };
            } catch (error) {
              recordFailure(error);
              throw error;
            }
          },
        );
        signal.throwIfAborted();
        await requireCurrent(signal);
        signal.throwIfAborted();
        // A new transaction sees revocation that happened during current IO.
        await db.begin(
          'isolation level repeatable read read only',
          async (tx) => {
            try {
              const [binding] = await query(
                personalSkillPinState(context, pin, tx),
              );
              assertPinState(binding, pin);
            } catch (error) {
              recordFailure(error);
              throw error;
            }
          },
        );
        return prepared;
      });
    },
  };
}
