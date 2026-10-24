import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NativeDiagnosticEventTypeSchema,
  NativeRunDiagnosticsSchema,
  type NativeDiagnosticEvent,
  type NativeDiagnosticReason,
  type NativeRunDiagnostics,
} from '@allrice/contracts';
import type {
  NativeDiagnosticTarget,
  NativeDiagnosticTargetSlice,
  NativeSessionPin,
} from '@allrice/database';
import type * as NativeCordis from '@deepseek-ai/cordis';
import type * as NativePersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type * as NativeSession from '@deepseek-ai/dsh-session';
import type * as NativeLlm from '@deepseek-ai/dsh-llm';
import { pinnedDshNativeLaunch } from './dsh-native-retention.js';

type RawEvent = {
  seq: number;
  type: string;
  time: unknown;
  data: unknown;
  surfaceOp?: unknown;
};
type Expand = (
  records: readonly unknown[],
) => readonly { time: number; chunk: unknown }[];
export interface NativeDiagnosticJournal {
  events: readonly RawEvent[];
  expand: Expand;
}
class DiagnosticReadError extends Error {
  constructor(readonly reason: NativeDiagnosticReason) {
    super(reason);
  }
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const stamp = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? v
    : typeof v === 'string' &&
        Number.isFinite(Date.parse(v)) &&
        Date.parse(v) >= 0
      ? Date.parse(v)
      : null;
const identity = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,255}$/.test(v) ? v : null;

/** The same independently approved reader as execution. These imports install
 * only its existing private vocabulary; no SDK, Agent, credentials or writer
 * is constructed. A read needing migration is reported, never migrated here. */
export async function readApprovedNativeDiagnosticJournal(
  pin: NativeSessionPin,
  signal: AbortSignal,
): Promise<NativeDiagnosticJournal> {
  let entrypoint: string;
  try {
    const launch = pinnedDshNativeLaunch(pin);
    if (
      launch.generation !== pin.distributionGeneration ||
      pin.artifactManifestDigest !== pin.artifactId
    )
      throw Error('reader_identity');
    entrypoint = launch.args[0]!;
  } catch {
    throw new DiagnosticReadError('reader_unavailable');
  }
  return readNativeDiagnosticJournalAt(entrypoint, pin, signal);
}

/** Internal seam shared with the real public-persistence fixture. Production
 * callers enter only through readApprovedNativeDiagnosticJournal above. */
export async function readNativeDiagnosticJournalAt(
  entrypoint: string,
  pin: NativeSessionPin,
  signal: AbortSignal,
): Promise<NativeDiagnosticJournal> {
  signal.throwIfAborted();
  const require = createRequire(entrypoint);
  const load = (name: string) =>
    import(pathToFileURL(require.resolve(name)).href);
  let Context: typeof NativeCordis.Context,
    backend: typeof NativePersistence,
    SessionId: typeof NativeSession.SessionId,
    llm: typeof NativeLlm,
    validate: (header: unknown, events: readonly unknown[]) => void;
  try {
    await import(
      pathToFileURL(join(dirname(entrypoint), 'allrice-dsh-inputs.mjs')).href
    );
    await import(
      pathToFileURL(join(dirname(entrypoint), 'allrice-dsh-waits.mjs')).href
    );
    ({ validateAllriceSessionJournal: validate } = await import(
      pathToFileURL(
        join(dirname(entrypoint), 'allrice-session-compatibility.mjs'),
      ).href
    ));
    ({ Context } = await load('@deepseek-ai/cordis'));
    backend = await load('@deepseek-ai/dsh-session-persistence-jsonl');
    ({ SessionId } = await load('@deepseek-ai/dsh-session'));
    llm = await load('@deepseek-ai/dsh-llm');
    if (
      typeof validate !== 'function' ||
      typeof llm.expandAssistantStream !== 'function'
    )
      throw Error('reader_api');
  } catch {
    throw new DiagnosticReadError('reader_unavailable');
  }
  const ctx = new Context();
  const plugin = ctx.plugin(
    (backend as typeof backend & { default?: typeof backend }).default ??
      backend,
    {
      root: pin.storageNamespace,
      compression: 'none',
    },
  );
  let handle: Awaited<ReturnType<SessionPersistence['open']>> | undefined;
  try {
    await plugin.await();
    const persistence = ctx.get('sessionPersistence') as SessionPersistence;
    const id = SessionId(pin.nativeSessionId);
    const snapshot = await persistence.stat(id, { signal });
    if (!snapshot || snapshot.header.id !== pin.nativeSessionId)
      throw new DiagnosticReadError('journal_unavailable');
    if (snapshot.formatStatus === 'migration-required')
      throw new DiagnosticReadError('journal_requires_migration');
    if (
      (snapshot.sizeBytes ?? 0) > 64 * 1024 * 1024 ||
      (snapshot.eventCount ?? 0) > 200_000
    )
      throw new DiagnosticReadError('journal_too_large');
    handle = await persistence.open(id, 'read', { signal });
    if (
      handle.access !== 'read' ||
      handle.header.id !== pin.nativeSessionId ||
      handle.header.isSeeded ||
      handle.header.parentSession
    )
      throw new DiagnosticReadError('journal_unavailable');
    const { events } = await handle.read(0, 200_001, { signal });
    signal.throwIfAborted();
    if (events.length > 200_000)
      throw new DiagnosticReadError('journal_too_large');
    validate(handle.header, events);
    return {
      events: events as readonly RawEvent[],
      expand: llm.expandAssistantStream as Expand,
    };
  } catch (error) {
    if (error instanceof DiagnosticReadError) throw error;
    throw new DiagnosticReadError('journal_unavailable');
  } finally {
    try {
      await handle?.close();
    } finally {
      await plugin.dispose();
    }
  }
}

function usage(value: unknown): NonNullable<NativeDiagnosticEvent['usage']> {
  const v = record(value);
  return {
    inputTokens: count(v.inputTokens),
    outputTokens: count(v.outputTokens),
    totalTokens: count(v.totalTokens),
    cacheReadTokens: count(v.cacheReadTokens),
    cacheWriteTokens: count(v.cacheWriteTokens),
    reasoningTokens: count(v.reasoningTokens),
  };
}
function streamMetadata(
  value: unknown,
  expand: Expand,
  reasons: Set<NativeDiagnosticReason>,
) {
  if (!Array.isArray(value)) {
    reasons.add('stream_unavailable');
    return undefined;
  }
  const predicted = value.reduce(
    (n, item) =>
      n +
      (Array.isArray(record(item).dt)
        ? (record(item).dt as unknown[]).length + 1
        : 1),
    0,
  );
  if (predicted > 50_000) {
    reasons.add('stream_truncated');
    return undefined;
  }
  let chunks: ReturnType<Expand>;
  try {
    chunks = expand(value);
    if (chunks.length > 50_000) {
      reasons.add('stream_truncated');
      return undefined;
    }
  } catch {
    reasons.add('stream_unavailable');
    return undefined;
  }
  const groups = new Map<
    string,
    NonNullable<NativeDiagnosticEvent['stream']>['groups'][number]
  >();
  const result: NonNullable<NativeDiagnosticEvent['stream']> = {
    chunkCount: chunks.length,
    firstChunkAt: null,
    firstReasoningAt: null,
    firstTextAt: null,
    finishAt: null,
    groups: [],
  };
  for (const item of chunks) {
    const c = record(item.chunk),
      time = stamp(item.time);
    const type = [
      'block-start',
      'block-end',
      'text-delta',
      'reasoning-delta',
      'tool-call-delta',
      'usage',
      'finish',
      'error',
    ].includes(String(c.type))
      ? (c.type as NonNullable<
          NativeDiagnosticEvent['stream']
        >['groups'][number]['type'])
      : 'other';
    const index = count(c.index),
      key = `${type}:${index}`;
    result.firstChunkAt ??= time;
    if (type === 'reasoning-delta') result.firstReasoningAt ??= time;
    if (type === 'text-delta') result.firstTextAt ??= time;
    if (type === 'finish') result.finishAt = time;
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.lastAt = time;
    } else if (groups.size < 128)
      groups.set(key, { type, index, count: 1, firstAt: time, lastAt: time });
    else reasons.add('stream_truncated');
  }
  result.groups = [...groups.values()];
  return result;
}

function projectEvent(
  event: RawEvent,
  source: NativeDiagnosticEvent['source'],
  expand: Expand,
  reasons: Set<NativeDiagnosticReason>,
): NativeDiagnosticEvent | null {
  const type = NativeDiagnosticEventTypeSchema.safeParse(event.type);
  if (!type.success || count(event.seq) === null) return null;
  const d = record(event.data);
  const result: NativeDiagnosticEvent = {
    seq: event.seq,
    type: type.data,
    time: stamp(event.time),
    turn: count(d.turn),
    step: count(d.step),
    source,
  };
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const message = record(d.message),
      block = Array.isArray(message.content) ? record(message.content[0]) : {};
    result.tool = {
      name: identity(d.name),
      callId: identity(
        d.callId ?? message.toolCallId ?? block.toolCallId ?? message.callId,
      ),
      errorCode: identity(record(d.error).code),
    };
  }
  if (event.type.startsWith('llm/retry'))
    result.retry = {
      retryId: identity(d.retryId),
      retry: count(d.retry),
      delayMs: count(d.delayMs),
    };
  if (event.type.startsWith('compaction/'))
    result.compactionId = identity(d.compactionId);
  if (d.usage !== undefined) result.usage = usage(d.usage);
  if (
    event.type === 'assistant/message' ||
    event.type === 'assistant/attempt'
  ) {
    const stream = streamMetadata(d.stream, expand, reasons);
    if (stream) result.stream = stream;
  }
  return result;
}

export function projectNativeDiagnosticSlice(
  target: NativeDiagnosticTargetSlice,
  journal: NativeDiagnosticJournal,
): NativeRunDiagnostics['slices'][number] {
  const reasons = new Set(target.reasons);
  const result: NativeRunDiagnostics['slices'][number] = {
    attempt: target.attempt,
    generation: target.generation,
    nativeSessionId: target.nativeSessionId,
    artifactId: target.binding?.artifactId ?? null,
    distributionGeneration: target.binding?.distributionGeneration ?? null,
    lastPersistedSeq: journal.events.length
      ? count(journal.events.at(-1)!.seq)
      : null,
    status: 'unavailable',
    reasons: [],
    events: [],
  };
  if (reasons.has('source_ambiguous'))
    return { ...result, reasons: [...reasons] };
  const bySeq = new Map(journal.events.map((event) => [event.seq, event]));
  const exact = new Set<number>();
  for (const receipt of target.receipts) {
    const event = bySeq.get(receipt.seq);
    if (!event) {
      reasons.add('source_event_missing');
      continue;
    }
    if (
      event.type !== receipt.type ||
      (receipt.turn !== null && record(event.data).turn !== receipt.turn)
    ) {
      reasons.add('source_event_mismatch');
      continue;
    }
    exact.add(receipt.seq);
  }
  // A mismatch invalidates expansion; retain only the individually matched
  // source events. No last-message, wall-clock or nearest-turn inference.
  const turns = new Set<number>();
  if (!reasons.has('source_event_mismatch'))
    for (const turn of target.verifiedTurns) {
      const starts = journal.events.filter(
        (e) =>
          !e.surfaceOp &&
          e.type === 'turn/start' &&
          record(e.data).turn === turn,
      );
      if (starts.length === 1) turns.add(turn);
      else reasons.add('source_ambiguous');
      if (
        !journal.events.some(
          (e) =>
            !e.surfaceOp &&
            e.type === 'turn/end' &&
            record(e.data).turn === turn,
        )
      )
        reasons.add('turn_end_unobserved');
    }
  for (const event of journal.events) {
    const source = exact.has(event.seq)
      ? 'run_receipt'
      : (event.surfaceOp === undefined || event.surfaceOp === 'append') &&
          turns.has(record(event.data).turn as number)
        ? 'verified_run_turn'
        : null;
    if (!source) continue;
    const projected = projectEvent(event, source, journal.expand, reasons);
    if (!projected) continue;
    if (result.events.length === 512) {
      reasons.add('events_truncated');
      break;
    }
    result.events.push(projected);
  }
  result.reasons = [...reasons];
  result.status = !result.events.length
    ? 'unavailable'
    : reasons.size
      ? 'partial'
      : 'available';
  return result;
}

export async function readNativeRunDiagnostics(
  target: NativeDiagnosticTarget,
  signal: AbortSignal,
  readJournal = readApprovedNativeDiagnosticJournal,
): Promise<NativeRunDiagnostics> {
  const reasons = new Set(target.reasons),
    slices: NativeRunDiagnostics['slices'] = [];
  if (target.running) reasons.add('run_in_progress');
  const journals = new Map<string, NativeDiagnosticJournal>();
  for (const slice of target.slices) {
    signal.throwIfAborted();
    if (!slice.binding || slice.reasons.includes('source_ambiguous')) {
      slices.push(
        projectNativeDiagnosticSlice(slice, { events: [], expand: () => [] }),
      );
      continue;
    }
    try {
      let journal = journals.get(slice.nativeSessionId);
      if (!journal) {
        journal = await readJournal(slice.binding, signal);
        journals.set(slice.nativeSessionId, journal);
      }
      slices.push(projectNativeDiagnosticSlice(slice, journal));
    } catch (error) {
      const reason =
        error instanceof DiagnosticReadError
          ? error.reason
          : 'journal_unavailable';
      const failed = projectNativeDiagnosticSlice(
        {
          ...slice,
          receipts: [],
          verifiedTurns: [],
          reasons: [...slice.reasons, reason],
        },
        { events: [], expand: () => [] },
      );
      slices.push(failed);
    }
  }
  for (const slice of slices)
    for (const reason of slice.reasons) reasons.add(reason);
  return NativeRunDiagnosticsSchema.parse({
    schemaVersion: 1,
    runId: target.runId,
    observedAt: new Date().toISOString(),
    source: 'native_persisted_journal',
    clock: 'native_wall_clock_epoch_ms',
    providerWire: null,
    status: slices.some((s) => s.events.length)
      ? reasons.size
        ? 'partial'
        : 'available'
      : 'unavailable',
    reasons: [...reasons],
    slices,
  });
}
