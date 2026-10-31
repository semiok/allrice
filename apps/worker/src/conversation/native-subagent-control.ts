import {
  claimNativeSubagentControl,
  authorizeNativeSubagentControlImages,
  recordNativeSubagentControlResult,
  type RunDeliveryAuthority,
} from '@allrice/database';
import {
  NativeSubagentControlWireSchema,
  type NativeSubagentControlResult,
} from '@allrice/contracts';
import { loadHarnessImages } from '../harness/prompt-images.js';
import type { HarnessAdapter } from '../harness/adapter.js';
import { NativeSubagentControlRefusal } from '../harness/dsh-protocol-client.js';

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
    let dispatch = false;
    try {
      const images = request.images ?? [];
      if (images.length)
        await authorizeNativeSubagentControlImages(
          principal,
          input.sessionId,
          request,
        );
      const bytes = images.length ? await loadHarnessImages(images) : [];
      if (images.length)
        await authorizeNativeSubagentControlImages(
          principal,
          input.sessionId,
          request,
        );
      const wire = NativeSubagentControlWireSchema.parse({
        scope: request.scope,
        input:
          request.input.kind === 'interrupt'
            ? request.input
            : {
                ...request.input,
                content: request.input.content.map((part) =>
                  part.type === 'text'
                    ? part
                    : {
                        type: 'image',
                        ...bytes[
                          images.findIndex(
                            (image) => image.object.id === part.objectId,
                          )
                        ],
                      },
                ),
              },
      });
      dispatch = input.open();
      result = input.open()
        ? {
            status: 'accepted',
            acceptance: await input.adapter.nativeSubagentControl!(wire),
            source: { kind: 'native_ack' },
          }
        : { status: 'rejected', code: 'RUN_COMPLETING' };
    } catch (error) {
      if (!dispatch) {
        result = {
          status: 'rejected',
          code: 'NATIVE_CONTROL_IMAGE_UNAVAILABLE',
        };
      } else if (error instanceof NativeSubagentControlRefusal) {
        result = { status: 'rejected', code: error.code };
      } else {
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
