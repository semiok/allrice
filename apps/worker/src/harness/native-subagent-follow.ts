import {
  NativeSubagentFollowEventSchema,
  type NativeSubagentFollowEvent,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import { nativeChildViewLimits } from '@allrice/contracts/native-runtime';
import type { DshProtocolClient } from './dsh-protocol-client.js';

export interface NativeSubagentFollowInput {
  childId?: string;
  liveOnly?: boolean;
  signal: AbortSignal;
  check(signal: AbortSignal): Promise<void>;
  send(
    event: NativeSubagentFollowEvent | null,
    signal: AbortSignal,
  ): Promise<void>;
  readSummary(): Promise<NativeSubagentSummary | null>;
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
    child?: string;
    ended?: boolean;
    seq?: number;
    instance?: string;
    revision?: number;
    epoch?: number;
    cursor?: number;
  };
  let pending: Mark[] = [],
    latest: Display | undefined,
    wake: (() => void) | undefined;
  let known = new Map([[rootId, '']]),
    cursors = new Map<string, number>(),
    baseline:
      { hostEpoch: number; instanceId: string; revision: number } | undefined;
  const binding = (hostEpoch: number, display: Display['display']) => ({
    hostEpoch,
    instanceId: display.instanceId,
    revision: display.revision,
  });
  let verified = false,
    heartbeatBusy = false;
  const ended = (mark: Mark) =>
    Boolean(
      input.childId &&
      mark.ended &&
      mark.child === input.childId &&
      known.get(input.childId) === mark.id,
    );
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const fail = (error: unknown) => {
    abort.abort(error);
    notify();
  };
  const read = async <T>(operation: () => Promise<T>, timeoutMs?: number) => {
    signal.throwIfAborted();
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => fail(Error('NATIVE_FOLLOW_AUTH_TIMEOUT')),
            timeoutMs,
          );
    try {
      return await Promise.race([operation(), stopped]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  };
  const emit = async (event: NativeSubagentFollowEvent | null) => {
    await read(() => input.check(signal), 10_000);
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
      const child =
        typeof params.childSessionId === 'string'
          ? params.childSessionId
          : undefined;
      const candidate =
        method === 'subagent.finished' &&
        child === input.childId &&
        Boolean(child);
      if (id !== input.childId && !known.has(id) && !candidate) return;
      let mark: Mark = { id, child, ended: candidate };
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
    const summary = await read(
      input.liveOnly || input.childId
        ? () => client.nativeSubagentSummary(rootId, true)
        : input.readSummary,
    );
    if (!summary || summary.rootId !== rootId || summary.root.source !== 'live')
      throw Error('NATIVE_QUERY_SOURCE_MISMATCH');
    const selected = input.childId && known.get(input.childId);
    known = new Map([[rootId, '']]);
    cursors = new Map([[rootId, summary.root.cursor]]);
    for (const row of summary.descendants)
      if (row.kind === 'child') {
        known.set(row.id, row.parentId);
        if (row.observation.source === 'live')
          cursors.set(row.id, row.observation.cursor);
      }
    // A selected durable address survives unload; cursors contain live cuts only.
    if (input.childId && selected) {
      if (known.has(input.childId) && known.get(input.childId) !== selected)
        throw Error('NATIVE_QUERY_CHILD_UNVERIFIED');
      known.set(input.childId, selected);
    }
    if (input.childId && !cursors.has(input.childId)) baseline = undefined;
    verified ||= Boolean(input.childId && known.has(input.childId));
    await emit({ type: 'directory', summary });
  };
  const snapshot = async () => {
    const before = pending.length;
    const s = await read(() =>
      client.nativeSubagentSnapshot(rootId, input.childId!),
    );
    if (s.rootId !== rootId || s.childId !== input.childId)
      throw Error('NATIVE_QUERY_CHILD_UNVERIFIED');
    // This live cut covers earlier notices for this child, including old activations.
    pending = pending.filter(
      (mark, index) =>
        index >= before ||
        (mark.id !== input.childId && mark.child !== input.childId),
    );
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
        if (!pending.some(ended)) throw error;
      }
    }
    while (true) {
      signal.throwIfAborted();
      if (!pending.length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const batch = pending;
      pending = [];
      const settled = batch.some(ended);
      const display = latest;
      latest = undefined;
      let changed = false,
        detailChanged = false,
        gap = false,
        revision = baseline?.revision;
      for (const mark of batch) {
        if (mark.revision !== undefined) {
          if (
            mark.epoch === baseline?.hostEpoch &&
            mark.cursor! < (cursors.get(mark.id) ?? -1)
          )
            continue;
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
          detailChanged ||= mark.id === input.childId;
        } else changed = true;
      }
      batch.length = 0;
      if (settled && input.childId && verified) {
        const summary = await read(input.readSummary).catch(() => null);
        if (
          !summary?.descendants.some(
            (row) =>
              row.kind === 'child' &&
              row.id === input.childId &&
              row.running === true,
          )
        ) {
          await emit({ type: 'summary', childId: input.childId, summary });
          baseline = undefined;
          continue;
        }
      }
      if (gap) await emit({ type: 'clear', reason: 'resync' });
      const childCursor = cursors.get(input.childId!);
      if (changed || gap) await directory();
      if (
        input.childId &&
        cursors.has(input.childId) &&
        (detailChanged ||
          gap ||
          !baseline ||
          cursors.get(input.childId) !== childCursor)
      ) {
        try {
          await snapshot();
        } catch (error) {
          if (!pending.some(ended)) throw error;
        }
      } else if (baseline && display && revision! > baseline.revision) {
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
