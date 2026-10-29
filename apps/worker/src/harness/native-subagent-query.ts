import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeSubagentSummarySchema } from '@allrice/contracts';
import type { NativeSubagentQueryTarget } from '@allrice/database';
import { configuredDshRuntimeRoot } from './dsh/runtime-pool.js';
import { currentDshNativeLaunch } from './dsh-native-artifact.js';

/** A persisted prefix even while another Host writes. Never execution/closure authority. */
export async function readAuthorizedNativeSubagentSummary(
  target: NativeSubagentQueryTarget,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
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
        (row.activity !== 'unknown' || row.observation.source !== 'prepared'),
    )
  )
    throw Error('NATIVE_QUERY_SOURCE_MISMATCH');
  signal.throwIfAborted();
  return summary;
}
