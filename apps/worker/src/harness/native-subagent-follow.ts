import {
  NativeSubagentFollowEventSchema,
  type NativeSubagentFollowEvent,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import { nativeChildViewLimits } from '@allrice/contracts/native-runtime';
import type { DshProtocolClient } from './dsh-protocol-client.js';

export interface NativeSubagentFollowInput {
  childId?: string;
  signal: AbortSignal;
  check(): Promise<void>;
  send(
    event: NativeSubagentFollowEvent | null,
    signal: AbortSignal,
  ): Promise<void>;
  terminal(): Promise<NativeSubagentSummary | null>;
}

/** A disposable observer on the existing stdio owner; never a runtime lease. */
export async function followNativeSubagent(
  client: DshProtocolClient,
  rootId: string,
  input: NativeSubagentFollowInput,
) {
  const abort = new AbortController(),
    signal = AbortSignal.any([input.signal, abort.signal]);
  type Display = Extract<NativeSubagentFollowEvent, { type: 'display' }>;
  type Mark = {
    id: string;
    seq?: number;
    instance?: string;
    revision?: number;
    epoch?: number;
    cursor?: number;
  };
  let pending: Mark[] = [],
    latest: Display | undefined,
    wake: (() => void) | undefined;
  let known = new Set([rootId]),
    cursors = new Map<string, number>(),
    baseline:
      { hostEpoch: number; instanceId: string; revision: number } | undefined;
  const binding = (hostEpoch: number, display: Display['display']) => ({
    hostEpoch,
    instanceId: display.instanceId,
    revision: display.revision,
  });
  let finished = false,
    verified = false,
    heartbeatBusy = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const fail = (error: unknown) => {
    abort.abort(error);
    notify();
  };
  const read = async <T>(operation: () => Promise<T>) => {
    signal.throwIfAborted();
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      return await Promise.race([operation(), stopped]);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  const emit = async (event: NativeSubagentFollowEvent | null) => {
    await read(input.check);
    signal.throwIfAborted();
    await input.send(
      event && NativeSubagentFollowEventSchema.parse(event),
      signal,
    );
  };
  const unsubscribe = client.subscribe(({ method, params }) => {
    if (signal.aborted) return;
    try {
      const id = String(params.sessionId ?? params.parentSessionId ?? '');
      if (id !== input.childId && !known.has(id)) return;
      let mark: Mark = { id };
      if (method === 'session.assistant-stream') {
        if (!input.childId || id !== input.childId) return;
        const display = NativeSubagentFollowEventSchema.parse({
          type: 'display',
          rootId,
          childId: id,
          hostEpoch: params.hostEpoch,
          display: params.display,
        }) as Display;
        const d = display.display;
        if (
          !latest ||
          latest.hostEpoch !== display.hostEpoch ||
          latest.display.instanceId !== d.instanceId ||
          latest.display.revision <= d.revision
        )
          latest = display;
        mark = {
          id,
          instance: d.instanceId,
          revision: d.revision,
          epoch: display.hostEpoch,
          cursor: d.cursor,
        };
      } else if (method === 'session.event') {
        const seq = (params.event as { seq?: unknown } | undefined)?.seq;
        if (!Number.isInteger(seq) || (seq as number) < 0)
          throw Error('NATIVE_FOLLOW_SEQ');
        mark.seq = seq as number;
      } else if (
        !['session.status', 'subagent.started', 'subagent.finished'].includes(
          method,
        )
      )
        return;
      if (
        method === 'subagent.finished' &&
        params.childSessionId === input.childId &&
        known.has(id)
      )
        finished = true;
      if (pending.length >= nativeChildViewLimits.events)
        throw Error('NATIVE_FOLLOW_OVERFLOW');
      pending.push(mark);
      notify();
    } catch (error) {
      fail(error);
    }
  });
  const unsubscribeFailure = client.onFailure(fail);
  signal.addEventListener('abort', notify, { once: true });
  // Authentication also runs while a slow client is waiting for drain.
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void emit(null)
      .catch(fail)
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 15_000);
  const directory = async () => {
    const summary = await read(() =>
      client.nativeSubagentSummary(rootId, true),
    );
    if (summary.rootId !== rootId || summary.root.source !== 'live')
      throw Error('NATIVE_QUERY_SOURCE_MISMATCH');
    known = new Set([rootId]);
    cursors = new Map([[rootId, summary.root.cursor]]);
    for (const row of summary.descendants)
      if (row.kind === 'child') {
        known.add(row.id);
        cursors.set(row.id, row.observation.cursor);
      }
    verified ||= Boolean(input.childId && known.has(input.childId));
    await emit({ type: 'directory', summary });
  };
  const snapshot = async () => {
    const s = await read(() =>
      client.nativeSubagentSnapshot(rootId, input.childId!),
    );
    if (s.rootId !== rootId || s.childId !== input.childId)
      throw Error('NATIVE_QUERY_CHILD_UNVERIFIED');
    baseline = binding(s.hostEpoch, s.stream);
    cursors.set(s.childId, s.observation.cursor);
    verified = true;
    await emit({ type: 'snapshot', snapshot: s });
  };
  try {
    signal.throwIfAborted();
    await directory();
    if (input.childId) {
      if (!verified) throw Error('NATIVE_QUERY_CHILD_UNVERIFIED');
      try {
        await snapshot();
      } catch (error) {
        if (!finished) throw error;
      }
    }
    while (true) {
      signal.throwIfAborted();
      if (finished && input.childId && verified) {
        const summary = await read(input.terminal).catch(() => null);
        await emit({ type: 'terminal', childId: input.childId, summary });
        return;
      }
      if (!pending.length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const batch = pending;
      pending = [];
      const display = latest;
      latest = undefined;
      let changed = false,
        gap = false,
        revision = baseline?.revision;
      for (const mark of batch) {
        if (mark.revision !== undefined) {
          if (
            !baseline ||
            mark.instance !== baseline.instanceId ||
            mark.epoch !== baseline.hostEpoch
          ) {
            gap = true;
            continue;
          }
          if (mark.revision <= revision!) continue;
          gap ||=
            mark.revision !== revision! + 1 ||
            mark.cursor !== cursors.get(mark.id);
          revision = mark.revision;
        } else if (mark.seq !== undefined) {
          const cursor = cursors.get(mark.id);
          if (cursor !== undefined && mark.seq <= cursor) continue;
          gap ||= cursor !== undefined && mark.seq !== cursor + 1;
          cursors.set(mark.id, mark.seq);
          changed = true;
        } else changed = true;
      }
      batch.length = 0;
      if (gap) await emit({ type: 'clear', reason: 'resync' });
      if (changed || gap) await directory();
      if (input.childId && (changed || gap)) {
        try {
          await snapshot();
        } catch (error) {
          if (!finished) throw error;
        }
      } else if (display && revision! > (baseline?.revision ?? -1)) {
        baseline = binding(display.hostEpoch, display.display);
        await emit(display);
      }
    }
  } finally {
    abort.abort();
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeFailure();
    signal.removeEventListener('abort', notify);
    pending = [];
    latest = undefined;
    baseline = undefined;
    known.clear();
    cursors.clear();
  }
}
