import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DshRuntimeOwnedObservationSchema,
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
  type DshCloseContext,
  type DshCloseObservationDetails,
} from '@allrice/database';
import { checkedDshNativeLaunch } from './dsh-native-artifact.js';
import { closeDshClientAfterFailure } from './dsh-client-cleanup.js';
import {
  DshProtocolClient,
  type DshProtocolLaunch,
} from './dsh-protocol-client.js';

let worker:
  | { workerId: string; workerBootId: string; serviceManifestDigest: string }
  | undefined;
/** Called once by Worker bootstrap after build/native verification, before
 * producers. No HTTP/model/prompt path installs this private write authority. */
export function installDshCloseObservationIdentity(
  input: NonNullable<typeof worker>,
) {
  if (worker) throw Error('DSH_CLOSE_OBSERVER_ALREADY_INSTALLED');
  // Use the same constrained identity fields as the persisted owner schema.
  DshRuntimeOwnedObservationSchema.pick({
    workerId: true,
    workerBootId: true,
    serviceManifestDigest: true,
  }).parse(input);
  worker = Object.freeze({ ...input });
}

/** One existing async factory boundary: reserve and exact readback precede
 * spawning. This helper does not close/retry a process or select another model.
 * A close fence after reserve is recorded as never-spawned by this factory only. */
export async function createObservedDshClient(input: {
  launch: DshProtocolLaunch;
  context: DshCloseContext;
  runtimeId?: string;
  assertAdmissionOpen?: () => void;
  authorizationTransport?: true;
  ownClient?: (client: DshProtocolClient) => void;
}) {
  const runtimeId = input.runtimeId ?? randomUUID();
  if (!worker) {
    if (process.env.ALLRICE_SERVICE_ROLE === 'worker')
      throw Error('DSH_CLOSE_OBSERVER_REQUIRED');
    // Standalone protocol fixtures have neither native approval nor SQL power.
    input.assertAdmissionOpen?.();
    const client = new DshProtocolClient(input.launch);
    try {
      input.ownClient?.(client);
    } catch (error) {
      return closeDshClientAfterFailure(client, error);
    }
    return client;
  }
  let args = input.launch.args;
  if (input.authorizationTransport) {
    if (
      args.length !== 3 ||
      args[0] !== '--import' ||
      args[1] !==
        resolve(
          import.meta.dirname,
          '../../dsh/allrice-codex-auth-transport.mjs',
        ) ||
      args[2] !==
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs')
    )
      throw Error('DSH_CLOSE_OBSERVER_AUTH_LAUNCH_INVALID');
    args = [args[2]];
  }
  const native = checkedDshNativeLaunch({
    command: input.launch.command,
    args,
    profile: input.launch.environment.DSH_CORDIS_CONFIG ?? '',
  });
  if (!native) throw Error('DSH_CLOSE_OBSERVER_NATIVE_UNVERIFIED');
  const owner = await reserveDshRuntimeOwner(
    DshRuntimeOwnedObservationSchema.parse({
      version: 1,
      kind: 'owned',
      runtimeId,
      ...worker,
      ...native,
      context: input.context,
      observedAt: new Date().toISOString(),
    }),
  );
  const observe = async (details: DshCloseObservationDetails) => {
    await recordDshRuntimeCloseObservation(owner, {
      ...details,
      version: 1,
      runtimeId,
      workerBootId: owner.owner.workerBootId,
      ownerDigest: owner.ownerDigest,
      observedAt: new Date().toISOString(),
    });
  };
  try {
    input.assertAdmissionOpen?.();
  } catch (error) {
    try {
      await observe({
        kind: 'process_closed',
        fact: {
          source: 'never_spawned',
          spawnAttempted: false,
          reason: 'admission_closed_before_spawn',
        },
      });
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'DSH unspawned owner observation remains unconfirmed',
      );
    }
    throw error;
  }
  // No await between the final fence and construction. A constructor throw
  // cannot be called "never spawned": retain its owned/unknown record because
  // spawn() may already have been attempted. Do not invent a child-close event.
  const client = new DshProtocolClient({
    ...input.launch,
    observeClose: observe,
  });
  try {
    input.ownClient?.(client);
  } catch (error) {
    return closeDshClientAfterFailure(client, error);
  }
  return client;
}
