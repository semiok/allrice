import { setTimeout as delay } from 'node:timers/promises';
import {
  cloudStableId,
  executionResourceObserver,
  RuntimePolicyError,
} from '@allrice/database';
import type { RiceToolExecutionInput } from '../types.js';

/** Retry admission of the same call only. Executed actions and unknown
 * outcomes remain in the existing Bridge operation journal/ledger. */
export async function waitForLocalAdmission<T>(
  input: RiceToolExecutionInput,
  admit: () => Promise<T>,
) {
  const observer = input.managedBrowserJobLeaseToken
    ? executionResourceObserver({
        context: input.context,
        leaseToken: input.managedBrowserJobLeaseToken,
        attemptId: cloudStableId(
          `local-admission:${input.context.runId}:${input.call.id}`,
        ),
        callId: input.call.id,
      })
    : null;
  let waiting = false;
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      try {
        const result = await admit();
        if (waiting) await observer!.observe({ stage: 'completed' });
        return result;
      } catch (error) {
        if (
          !(error instanceof RuntimePolicyError) ||
          ![
            'local_runner_busy',
            'local_runner_preparing',
            'local_browser_profile_busy',
            'local_browser_preparing',
          ].includes(error.code) ||
          !observer
        )
          throw error;
        const reason = error.code.endsWith('preparing')
          ? 'local_preparing'
          : 'local_busy';
        await observer.observe({
          stage: waiting ? 'waiting' : 'queued',
          reason,
        });
        waiting = true;
        await delay(500, undefined, { signal: input.signal });
      }
    }
  } catch (error) {
    if (waiting)
      await observer!
        .observe({ stage: input.signal?.aborted ? 'canceled' : 'failed' })
        .catch(() => undefined);
    throw error;
  }
}
