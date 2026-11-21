import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import {
  isAppendSurfaceEvent,
  SESSION_FORMAT_VERSION,
  SessionId,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
} from '@deepseek-ai/dsh-session';
import {
  HostHistoryAttachmentSchema,
  HostHistoryBindingSchema,
  HostHistorySnapshotSchema,
  type HostHistoryAttachment,
  type HostHistoryBinding,
  type HostHistoryEntry,
  type HostHistoryStorePort,
} from '@allrice/contracts';
import { hostHistoryDigest, HostHistoryIntegrityError } from '@allrice/storage';

/** Technical redaction, never intent/approval classification. Private protocol
 * fields are excluded entirely; a contaminated text slot is explicitly hidden.
 * Unknown standalone secret formats cannot be proven safe by pattern matching. */
function displayText(text: string) {
  return /\b(?:Bearer\s+\S+|(?:authorization|proxy.authorization|headers?|cookies?|set.cookie|api.key|access.token|refresh.token|client.secret|password|credentials?|capability)\s*["']?\s*[:=])|\b(?:sk-(?:proj-)?[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})|(?:file:\/\/|\/(?:Users|private|home|work|tmp|var|root|opt|etc|mnt)\/)|[A-Za-z]:\\/i.test(
    text,
  ) || /(?:^|[\s"'`=:([{])\/(?!\/)[^\s"'`)}\]>]+/.test(text)
    ? '[已隐藏含敏感字段或原始路径的内容]'
    : text;
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return displayText(content);
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string'
      )
        return [displayText(block.text)];
      return [];
    })
    .join('\n');
}

function callKey(turn: number, step: number, callId: string) {
  return JSON.stringify([turn, step, callId]);
}

/** Native inspect is a non-activating public API in locked rc.2. Its owner
 * supplies canonical attached or cold-read events (including native closers).
 * This adapter does not restore, repair, resolveAgent, prompt, retry or replay. */
export async function captureHostHistory(input: {
  binding: HostHistoryBinding;
  native: Pick<SessionController, 'inspect'> & {
    readonly binding: HostHistoryBinding;
  };
  /** Current host root admission from the runtime/identity owner, independent
   * of guest headers/descriptors. Rechecked before publishing; no stored grant. */
  authorize: (
    binding: HostHistoryBinding,
    signal: AbortSignal,
  ) => Promise<{
    binding: HostHistoryBinding;
    revoked: AbortSignal;
  }>;
  store: HostHistoryStorePort;
  signal: AbortSignal;
  /** Trusted attachment owner exports already-persisted immutable object pins.
   * It must authorize/copy via its public service, never a guest absolutePath. */
  attachments: (
    binding: HostHistoryBinding,
    signal: AbortSignal,
  ) => Promise<readonly HostHistoryAttachment[]>;
}) {
  input.signal.throwIfAborted();
  const binding = HostHistoryBindingSchema.parse(input.binding);
  const assertBinding = (candidate: HostHistoryBinding) => {
    if (
      hostHistoryDigest(HostHistoryBindingSchema.parse(candidate)) !==
      hostHistoryDigest(binding)
    )
      throw new HostHistoryIntegrityError();
  };
  const admitted = await input.authorize(binding, input.signal);
  assertBinding(admitted.binding);
  assertBinding(input.native.binding);
  const signal = AbortSignal.any([input.signal, admitted.revoked]);
  signal.throwIfAborted();
  const inspection = await input.native.inspect(
    SessionId(binding.nativeSessionId),
    signal,
  );
  if (
    inspection.meta.id !== binding.nativeSessionId ||
    inspection.meta.version !== SESSION_FORMAT_VERSION
  )
    throw new HostHistoryIntegrityError();
  const events = inspection.events;
  if (events.some((event, i) => event.seq !== i))
    throw new HostHistoryIntegrityError();
  const entries: HostHistoryEntry[] = [];
  const results = new Map<string, SessionEvent<'tool/result'>>();
  const explicit = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool/call')
      explicit.add(
        callKey(event.data.turn, event.data.step, event.data.callId),
      );
    else if (event.type === 'tool/result' && isAppendSurfaceEvent(event))
      results.set(
        callKey(
          event.data.turn,
          event.data.step,
          event.data.message.toolCallId,
        ),
        event,
      );
  }
  const emitted = new Set<string>();
  const tool = (
    event: SessionEvent,
    call: {
      turn: number;
      step: number;
      callId: string;
      name: string;
      arguments: string;
    },
  ) => {
    const key = callKey(call.turn, call.step, call.callId);
    if (emitted.has(key)) return;
    emitted.add(key);
    const result = results.get(key);
    const errorCode = result?.data.error?.code ?? null;
    entries.push({
      kind: 'tool',
      seq: event.seq,
      time: event.time,
      callId: call.callId,
      name: displayText(call.name),
      arguments: displayText(call.arguments),
      outcome: !result
        ? 'unfinished'
        : errorCode === TOOL_OUTCOME_UNKNOWN
          ? 'outcome-unknown'
          : errorCode === TOOL_NOT_STARTED
            ? 'not-started'
            : result.data.message.isError
              ? 'error-recorded'
              : 'result-recorded',
      result: result
        ? {
            seq: result.seq,
            text: visibleText(result.data.message.content),
            isError: result.data.message.isError ?? null,
            errorCode,
          }
        : null,
    });
  };
  const lastTurn = {
    startSeq: null as number | null,
    endSeq: null as number | null,
    reason: null as string | null,
  };
  for (const event of events) {
    signal.throwIfAborted();
    if (event.type === 'turn/start') lastTurn.startSeq = event.seq;
    else if (event.type === 'turn/end') {
      lastTurn.endSeq = event.seq;
      lastTurn.reason = event.data.reason.kind;
      entries.push({
        kind: 'turn-end',
        seq: event.seq,
        time: event.time,
        turn: event.data.turn,
        reason: event.data.reason.kind,
      });
    } else if (event.type === 'tool/call') tool(event, event.data);
    else if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      // Actual native user source only. Runtime/skill/system context is private.
      if (event.data.source?.kind === 'user')
        entries.push({
          kind: 'message',
          seq: event.seq,
          time: event.time,
          role: 'user',
          text: visibleText(event.data.content),
          interrupted: false,
        });
    } else if (
      event.type === 'assistant/message' &&
      isAppendSurfaceEvent(event)
    ) {
      const text = visibleText(event.data.message.content);
      if (text)
        entries.push({
          kind: 'message',
          seq: event.seq,
          time: event.time,
          role: 'assistant',
          text,
          interrupted: event.data.interrupted === true,
        });
      for (const block of event.data.message.content) {
        if (
          block.type === 'tool-call' &&
          !explicit.has(callKey(event.data.turn, event.data.step, block.id))
        )
          tool(event, {
            turn: event.data.turn,
            step: event.data.step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
          });
      }
    }
  }
  const attachments = (await input.attachments(binding, signal)).map(
    (attachment) => HostHistoryAttachmentSchema.parse(attachment),
  );
  // Only visible transcript events may acquire public attachment references.
  if (
    attachments.some(
      (attachment) =>
        !entries.some(
          (entry) =>
            entry.seq === attachment.sourceSeq ||
            (entry.kind === 'tool' &&
              entry.result?.seq === attachment.sourceSeq),
        ),
    )
  )
    throw new HostHistoryIntegrityError();
  const snapshot = HostHistorySnapshotSchema.parse({
    schemaVersion: 1,
    binding,
    source: {
      dshVersion: '0.2.1-rc.2',
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      headerHash: hostHistoryDigest(inspection.meta),
      inheritedEventCount: inspection.inheritedEventCount,
      throughSeq: events.length - 1,
      eventHashes: events.map(hostHistoryDigest),
    },
    entries,
    attachments,
    lastTurn,
  });
  signal.throwIfAborted();
  const current = await input.authorize(binding, signal);
  assertBinding(current.binding);
  assertBinding(input.native.binding);
  const publicationSignal = AbortSignal.any([signal, current.revoked]);
  publicationSignal.throwIfAborted();
  return {
    digest: await input.store.publish(snapshot, publicationSignal),
    snapshot,
  };
}
