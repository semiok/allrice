import {
  claimNativeSubagentControl,
  recordNativeSubagentControlResult,
  type RunDeliveryAuthority,
} from '@allrice/database';
import type { NativeSubagentControlResult } from '@allrice/contracts';
import type { HarnessAdapter } from '../harness/adapter.js';

/** One claim, one dispatch. DSH owns pending admission and Inbox execution. */
export async function pollNativeSubagentControl(input: {
  authority: RunDeliveryAuthority;
  ownerId: string;
  sessionId: string;
  adapter: HarnessAdapter;
  open(): boolean;
  revoke(error: unknown): void;
}) {
  if (!input.open() || !input.adapter.nativeSubagentControl) return false;
  let request;
  try {
    request = await claimNativeSubagentControl(input.authority);
  } catch (error) {
    if (input.open()) input.revoke(error);
    throw error;
  }
  if (!request) return false;
  const principal = {
    ...input.authority.scope,
    actor: { type: 'user' as const, id: input.ownerId },
  };
  // Never join this promise in the command pump: cold prompt admission must
  // leave root question answers and another child's Stop independently usable.
  void (async () => {
    let result: NativeSubagentControlResult;
    try {
      result = input.open()
        ? {
            status: 'accepted',
            acceptance: await input.adapter.nativeSubagentControl!(request),
            source: { kind: 'native_ack' },
          }
        : { status: 'rejected', code: 'RUN_COMPLETING' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      result = [
        'RUN_NOT_ACTIVE',
        'RUN_COMPLETING',
        'NATIVE_CONTROL_CHILD_UNVERIFIED',
        'NATIVE_CONTROL_GRANT_EXPIRED',
        'NATIVE_CONTROL_SCOPE_MISMATCH',
        'NATIVE_CONTROL_RUN_MISMATCH',
      ].includes(code)
        ? { status: 'rejected', code }
        : { status: 'unknown' };
    }
    // A late positive ACK belongs to this immutable request, even after close.
    await recordNativeSubagentControlResult(
      principal,
      input.sessionId,
      request,
      result,
    );
  })().catch(() => {
    console.error('[M5] Native child control receipt unavailable', {
      sessionId: input.sessionId,
      requestId: request.input.requestId,
    });
  });
  return true;
}
