import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeUpdateInstaller } from './update-installer.js';
import type { UpdateEnvironment, VerifiedUpdate } from './trusted-update.js';

export interface UpdateOwnedChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
}
export interface UpdateMonitorInput {
  createInstaller: (quiescent: () => Promise<void>) => BridgeUpdateInstaller;
  acquireOwner: () => Promise<{ close(): void }>;
  launch: (app: string, transactionId?: string) => Promise<UpdateOwnedChild>;
  verifyRollback: (app: string, update: VerifiedUpdate) => Promise<void>;
  app: string;
  sourceApp: string;
  sourceVersion: string;
  update: VerifiedUpdate;
  metadata: Uint8Array;
  archive: Buffer;
  environment: UpdateEnvironment;
  recovery: boolean;
  // Bounded clock ports allow fault tests without a 60-second simulated wait.
  sleep?: (ms: number) => Promise<void>;
  healthAttempts?: number;
  stopAttempts?: number;
}
function fail(code: string): never {
  throw Error(code);
}

/** The native adapter proves old-host exit before entry. This coordinator
 * still acquires the same OS config owner before every replacement/rollback. */
export async function monitorBridgeUpdate(input: UpdateMonitorInput) {
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  let owner: { close(): void } | null = await input.acquireOwner();
  let child: UpdateOwnedChild | null = null;
  let commitAttempted = false;
  let failureCode: string | null = null;
  const engine = input.createInstaller(async () => {
    if (!owner) fail('UPDATE_STOP_UNCONFIRMED');
  });
  try {
    if (input.recovery) {
      const current = await engine.state();
      if (
        !current ||
        current.sequence !== input.update.release.sequence ||
        current.version !== input.update.release.version ||
        ['healthy', 'rolled-back'].includes(current.phase)
      )
        fail('UPDATE_RECOVERY_UNCONFIRMED');
      await engine.recover();
    } else {
      await engine.install(input.metadata, input.archive, input.environment);
      const state = (await engine.state())!;
      owner.close();
      owner = null;
      child = await input.launch(input.app, state.id);
      for (let n = 0; n < (input.healthAttempts ?? 240); n++) {
        const current = await engine.state();
        if (current?.id !== state.id) fail('UPDATE_HEALTH_MISMATCH');
        if (current.phase === 'ready-health') {
          commitAttempted = true;
          await engine.confirmHealthy(state.version, state.id);
          child.unref();
          return { status: 'healthy' as const, failureCode: null };
        }
        if (child.exitCode !== null || child.signalCode !== null)
          fail('UPDATE_LAUNCH_FAILED');
        await sleep(250);
      }
      fail('UPDATE_HEALTH_TIMEOUT');
    }
  } catch (error) {
    if (input.recovery) throw error;
    if (commitAttempted) {
      // A write can become visible before its final fsync throws. New Core
      // might already be running; never kill it based on a lost commit ACK.
      child?.unref();
      fail('UPDATE_HEALTH_UNCONFIRMED');
    }
    if (child) {
      child.kill('SIGTERM');
      for (
        let n = 0;
        n < (input.stopAttempts ?? 120) &&
        child.exitCode === null &&
        child.signalCode === null;
        n++
      )
        await sleep(250);
      if (child.exitCode === null && child.signalCode === null)
        fail('UPDATE_STOP_UNCONFIRMED');
    }
    owner ??= await input.acquireOwner();
    await engine.recover();
    failureCode =
      error instanceof Error ? error.message : 'UPDATE_INSTALL_FAILED';
  } finally {
    owner?.close();
    owner = null;
  }
  const restored = await engine.state();
  const rollback = restored?.previous ? input.app : input.sourceApp;
  await input.verifyRollback(rollback, {
    ...input.update,
    release: { ...input.update.release, version: input.sourceVersion },
  });
  (await input.launch(rollback)).unref();
  return { status: 'rolled-back' as const, failureCode };
}
