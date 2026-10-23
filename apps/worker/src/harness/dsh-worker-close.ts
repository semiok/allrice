import {
  readDshRuntimeCloseCoverage,
  finalizeWorkerDshRuntimeInventory,
} from '@allrice/database';
import type {
  HarnessRuntimeClosureSnapshot,
  HarnessRuntimeProcessSnapshot,
} from './adapter.js';

type Coverage = Awaited<ReturnType<typeof readDshRuntimeCloseCoverage>>;
export interface DshWorkerCloseSummary {
  workerId: string;
  workerBootId: string;
  observedRuntimes: number;
  confirmed: number;
  neverSpawned: number;
  physicalExited: string[];
  liveOrUnknown: string[];
  unconfirmed: string[];
  readbackConfirmed: boolean;
  physicalRegistryUpdated: boolean;
  legacyHistory: 'not_reclassified';
}
export class DshWorkerCloseError extends AggregateError {
  readonly code = 'DSH_WORKER_CLOSE_UNCONFIRMED';
  constructor(
    readonly summary: DshWorkerCloseSummary,
    errors: readonly unknown[],
  ) {
    super(errors, 'Worker native closure remains unconfirmed');
  }
}

/** Called only after producers and all client-close attempts have settled.
 * Registry offline describes witnessed physical exit, never successful flush.
 * The append-only observation table remains the semantic/retirement evidence. */
export async function verifyWorkerDshRuntimeClosure(input: {
  workerId: string;
  workerBootId: string;
  serviceManifestDigest: string;
  runtimeInventory(): readonly HarnessRuntimeProcessSnapshot[];
  closureInventory(): readonly HarnessRuntimeClosureSnapshot[];
}) {
  const errors: unknown[] = [];
  let live: readonly HarnessRuntimeProcessSnapshot[] | undefined;
  let closure: readonly HarnessRuntimeClosureSnapshot[] | undefined;
  let coverage: Coverage | undefined;
  try {
    live = input.runtimeInventory();
  } catch (error) {
    errors.push(error);
  }
  try {
    closure = input.closureInventory();
  } catch (error) {
    errors.push(error);
  }
  try {
    coverage = await readDshRuntimeCloseCoverage(undefined, {
      workerBootId: input.workerBootId,
    });
  } catch (error) {
    errors.push(error);
  }
  const matching: Coverage = [];
  const seen = new Set<string>();
  for (const item of coverage ?? []) {
    const owner = item.owner;
    if (
      owner.workerBootId !== input.workerBootId ||
      owner.workerId !== input.workerId ||
      owner.serviceManifestDigest !== input.serviceManifestDigest ||
      seen.has(owner.runtimeId)
    ) {
      errors.push(Error('DSH_CLOSE_BOOT_IDENTITY_MISMATCH'));
      continue;
    }
    seen.add(owner.runtimeId);
    matching.push(item);
  }
  const byId = new Map(matching.map((item) => [item.owner.runtimeId, item]));
  const active = new Set((live ?? []).map((item) => item.id));
  for (const item of closure ?? [])
    if (item.processState !== 'exited') active.add(item.id);
  const exited = new Set(
    matching
      .filter((item) => item.physical === 'exited')
      .map((item) => item.owner.runtimeId),
  );
  for (const item of closure ?? [])
    if (item.processState === 'exited') exited.add(item.id);
  const registryExited = new Set(
    matching
      .filter((item) => item.physical === 'exited')
      .map((item) => item.owner.runtimeId),
  );
  let registryInputValid = true;
  const unconfirmed = new Set(
    matching
      .filter(
        (item) =>
          item.physical !== 'never_spawned' && item.publicClose !== 'confirmed',
      )
      .map((item) => item.owner.runtimeId),
  );
  for (const item of live ?? []) {
    const owner = byId.get(item.id)?.owner,
      c = owner?.context;
    if (
      !c ||
      c.kind !== 'context' ||
      c.organizationId !== item.organizationId ||
      c.workspaceId !== item.workspaceId ||
      c.ownerId !== item.ownerId ||
      (c.contextKind === 'chat' && c.contextId !== item.sessionId)
    ) {
      registryInputValid = false;
      unconfirmed.add(item.id);
      errors.push(Error('DSH_CLOSE_PHYSICAL_OWNER_MISMATCH'));
    }
  }
  for (const item of closure ?? []) {
    const stored = byId.get(item.id);
    if (
      !stored ||
      stored.owner.artifactId !== item.nativeArtifactId ||
      (item.processState === 'exited' && !item.stdioClosed)
    ) {
      // Keep the physical observation in the summary; it cannot authorize a
      // write to a different boot/artifact's persistent inventory row.
      registryInputValid = false;
      registryExited.delete(item.id);
      unconfirmed.add(item.id);
      errors.push(Error('DSH_CLOSE_PHYSICAL_OWNER_MISMATCH'));
    }
    if (
      (item.processState === 'exited' && stored?.physical !== 'exited') ||
      !item.stdioClosed ||
      item.processState !== 'exited'
    ) {
      registryExited.delete(item.id);
      unconfirmed.add(item.id);
    }
  }
  // Contradictory or still-live facts never get converted to offline.
  for (const id of active) {
    registryExited.delete(id);
    if (exited.delete(id))
      errors.push(Error('DSH_CLOSE_PHYSICAL_EVIDENCE_CONFLICT'));
    unconfirmed.add(id);
  }
  // A durable owner whose close never arrived may be outside the chat pool
  // (authorization/search/image). Absence from the pool does not prove exit.
  const liveOrUnknown = new Set(active);
  for (const item of matching)
    if (item.physical === 'unknown' && !exited.has(item.owner.runtimeId))
      liveOrUnknown.add(item.owner.runtimeId);
  const summary: DshWorkerCloseSummary = {
    workerId: input.workerId,
    workerBootId: input.workerBootId,
    observedRuntimes: matching.length,
    confirmed: matching.filter((item) => item.publicClose === 'confirmed')
      .length,
    neverSpawned: matching.filter((item) => item.physical === 'never_spawned')
      .length,
    physicalExited: [...exited].sort(),
    liveOrUnknown: [...liveOrUnknown].sort(),
    unconfirmed: [...unconfirmed].sort(),
    readbackConfirmed:
      coverage !== undefined && matching.length === coverage.length,
    physicalRegistryUpdated: false,
    legacyHistory: 'not_reclassified',
  };
  // Unknown inventory is not an empty inventory. If it could not be captured,
  // leave the heartbeat registry untouched instead of overwriting it.
  if (
    live !== undefined &&
    closure !== undefined &&
    summary.readbackConfirmed &&
    registryInputValid
  ) {
    try {
      await finalizeWorkerDshRuntimeInventory({
        workerId: input.workerId,
        workerBootId: input.workerBootId,
        serviceManifestDigest: input.serviceManifestDigest,
        runtimes: live.flatMap((item) =>
          item.sessionId === null
            ? []
            : [{ ...item, sessionId: item.sessionId }],
        ),
        exitedRuntimeIds: [...registryExited].sort(),
      });
      summary.physicalRegistryUpdated = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (summary.unconfirmed.length)
    errors.push(Error('DSH_CLOSE_BOOT_UNCONFIRMED'));
  if (errors.length) throw new DshWorkerCloseError(summary, errors);
  return summary;
}
