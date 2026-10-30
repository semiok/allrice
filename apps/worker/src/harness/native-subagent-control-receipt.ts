import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NativeSubagentControlResultSchema,
  type RequestContext,
} from '@allrice/contracts';
import {
  getNativeSubagentControl,
  getSessionNativeSubagentTarget,
  recordNativeSubagentControlResult,
} from '@allrice/database';
import { nativeSubagentQuerySource } from './native-subagent-query.js';

/** Read an existing ticket; recovery grants no native execution authority. */
export async function readNativeSubagentControlTicket(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  requestId: string,
  signal: AbortSignal,
) {
  const principal = { ...context, workspaceId };
  const saved = await getNativeSubagentControl(principal, sessionId, requestId);
  if (
    !saved ||
    saved.ticket.result.status !== 'unknown' ||
    saved.ticket.kind !== 'prompt'
  )
    return saved?.ticket ?? null;
  const { request } = saved;
  const target = async () => {
    const pin = await getSessionNativeSubagentTarget(
      context,
      workspaceId,
      sessionId,
    );
    // A newer business generation never relabels this original request. Only
    // the same root origin/storage source may prove its original acceptance.
    if (
      pin.rootOriginDigest !== request.scope.rootOriginDigest ||
      pin.descriptor.nativeSessionId !== request.scope.nativeRootId ||
      pin.descriptor.storageNamespace !== request.scope.storageNamespace
    )
      throw Error('NATIVE_CONTROL_RECEIPT_SOURCE_CHANGED');
    return pin;
  };
  const { expected, launch } = nativeSubagentQuerySource(await target());
  const reader = await import(
    pathToFileURL(join(dirname(launch.args[0]!), 'allrice-native-query.mjs'))
      .href
  );
  const result = await reader.withNativeQueryReader(expected, (ctx: unknown) =>
    reader.readNativeSubagentControlReceipt(ctx, request, signal),
  );
  signal.throwIfAborted();
  await target();
  signal.throwIfAborted();
  return result
    ? recordNativeSubagentControlResult(
        principal,
        sessionId,
        request,
        NativeSubagentControlResultSchema.parse(result),
      )
    : saved.ticket;
}
