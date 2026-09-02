import { ChatFlowWakeupSchema, type ChatFlowWakeup } from '@allrice/contracts';
import type postgres from 'postgres';

import { registerDatabaseCloseHook } from '../core/client.ts';

type Sql = ReturnType<typeof postgres>;
type Listener = (wakeup: ChatFlowWakeup) => void;

const listeners = new Map<string, Set<Listener>>();
let listenRequest: Awaited<ReturnType<Sql['listen']>> | null = null;

export function parseChatFlowWakeup(payload: string) {
  return ChatFlowWakeupSchema.parse(JSON.parse(payload));
}

export async function subscribeChatFlowWakeups(
  sql: Sql,
  runId: string,
  listener: Listener,
) {
  const runListeners = listeners.get(runId) ?? new Set<Listener>();
  runListeners.add(listener);
  listeners.set(runId, runListeners);
  if (!listenRequest) {
    listenRequest = await sql.listen('allrice_run_events', (payload) => {
      try {
        const wakeup = parseChatFlowWakeup(payload);
        for (const callback of listeners.get(wakeup.runId) ?? []) {
          callback(wakeup);
        }
      } catch (error) {
        console.error('[ChatFlow] Ignored invalid PostgreSQL wakeup', {
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    runListeners.delete(listener);
    if (runListeners.size === 0) listeners.delete(runId);
  };
}

export async function closeChatFlowWakeups() {
  listeners.clear();
  const current = listenRequest;
  listenRequest = null;
  await current?.unlisten();
}

registerDatabaseCloseHook(closeChatFlowWakeups);
