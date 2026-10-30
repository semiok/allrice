import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeSubagentSummarySchema } from '@allrice/contracts';
import type { NativeSubagentQueryTarget } from '@allrice/database';
import { configuredDshRuntimeRoot } from './dsh/runtime-pool.js';
import { currentDshNativeLaunch } from './dsh-native-artifact.js';
import type { HarnessAdapter } from './adapter.js';
import { getHarnessRouter } from './router.js';

export function nativeSubagentQuerySource(target: NativeSubagentQueryTarget) {
  const pin = target.descriptor;
  const expected = resolve(
    configuredDshRuntimeRoot(),
    target.organizationId,
    target.workspaceId,
    target.ownerId,
    target.sessionId,
    'sessions',
  );
  const launch = currentDshNativeLaunch(pin.profileId);
  if (
    pin.storageNamespace !== expected ||
    launch.generation !== pin.distributionGeneration
  )
    throw Error('NATIVE_QUERY_READER_UNAVAILABLE');
  return { expected, launch };
}

/** Prefer this Worker's exact live owner; otherwise a persisted prefix, never
 * evidence that another Host stopped. Neither read grants execution authority. */
export async function readAuthorizedNativeSubagentSummary(
  target: NativeSubagentQueryTarget,
  signal: AbortSignal,
  liveOnly = false,
  adapter: Pick<
    HarnessAdapter,
    'nativeSubagentSummary'
  > = getHarnessRouter().resolve('dsh'),
) {
  signal.throwIfAborted();
  const pin = target.descriptor;
  const { expected, launch } = nativeSubagentQuerySource(target);
  const live = await adapter.nativeSubagentSummary?.(target, signal, liveOnly);
  signal.throwIfAborted();
  if (live) return NativeSubagentSummarySchema.parse(live);
  if (liveOnly) return null;
  const reader = await import(
    pathToFileURL(join(dirname(launch.args[0]!), 'allrice-native-query.mjs'))
      .href
  );
  const summary = NativeSubagentSummarySchema.parse(
    await reader.withNativeQueryReader(expected, (ctx: unknown) =>
      reader.readNativeSubagentSummary(ctx, pin.nativeSessionId, signal),
    ),
  );
  if (
    summary.rootId !== pin.nativeSessionId ||
    summary.root.source !== 'prepared' ||
    summary.descendants.some(
      (row) =>
        row.kind === 'child' &&
        (row.activity !== 'unknown' ||
          row.running !== null ||
          row.observation.source !== 'prepared'),
    )
  )
    throw Error('NATIVE_QUERY_SOURCE_MISMATCH');
  signal.throwIfAborted();
  return summary;
}
