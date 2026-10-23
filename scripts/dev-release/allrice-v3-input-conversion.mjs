import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  RELEASED_V3_EVENT_TYPES,
  createSessionFormatV3ToV4,
  releasedV3SessionFormatCodec,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session';
import { validateAllriceSessionJournal } from '../../apps/worker/dsh/allrice-session-compatibility.mjs';

// This is a pure, opt-in data preparation API, not a persistence migration or
// an approval grant. Its caller must separately authorize exact scope, check
// fresh source bytes / ownership, publish a new namespace, and admit adoption.
// No filesystem, persistence backend, Host, provider, or execution API is used.
const PRIVATE_TYPES = new Set([
  'allrice/input/request',
  'allrice/input/answered',
]);
const REVIEWED_NATIVE_TYPES = new Set([
  'agent/inbox/spliced',
  'turn/start',
  'step/start',
  'system/message',
  'user/message',
  'request/header',
  'request/context',
  'session/title',
  'assistant/message',
  'step/end',
  'turn/end',
  'session/end-seed',
  'tool/call',
  'tool/result',
  'todo/write',
]);
const REFERENCE_KEYS = new Set([
  'attachmentId',
  'childId',
  'parentSession',
  'parentSessionId',
  'sessionId',
  'nativeSessionId',
  'originSessionId',
  'targetSessionId',
]);
const TRANSPORT_PREFIX = 'allrice-v3-input-transport:';
const HASH = /^[0-9a-f]{64}$/;

function requireFact(condition, code) {
  if (!condition) throw new Error(`ALLRICE_V3_INPUT_CONVERSION_${code}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function factHash(value) {
  return hash(canonical(value));
}

function assertExactKeys(value, expected, code) {
  requireFact(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()),
    code,
  );
}

function assertEnabled(enabled) {
  requireFact(enabled === true, 'DISABLED');
}

function decode(bytes, codec) {
  const text = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(
    bytes,
  );
  requireFact(text.endsWith('\n'), 'INCOMPLETE_JSONL');
  const lines = text.slice(0, -1).split('\n');
  requireFact(
    lines.length > 1 && lines.every((line) => line.trim()),
    'EMPTY_ROW',
  );
  const [physicalHeader, ...rows] = lines.map((line) => JSON.parse(line));
  const decoder = codec.createDecoder(physicalHeader, 'strict');
  const events = [];
  const context = {
    emitEvent(event) {
      events.push(event);
    },
    emitRun() {
      // The reviewed source has exactly one physical row per logical event.
      throw new Error('ALLRICE_V3_INPUT_CONVERSION_COMPACT_RUN_NOT_REVIEWED');
    },
  };
  for (const row of rows) decoder.decodeRow(row, context);
  const inheritedEventCount = decoder.finish(context);
  requireFact(events.length === rows.length, 'ROW_COUNT_CHANGED');
  return { header: decoder.header, inheritedEventCount, events };
}

function sourceReferences(events) {
  const references = [];
  function visit(value, path, seq) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`, seq));
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) {
        const next = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (REFERENCE_KEYS.has(key)) {
          references.push({ sourceSeq: seq, path: next, value: value[key] });
        }
        visit(value[key], next, seq);
      }
    }
  }
  for (const event of events) visit(event.data, '/data', event.seq);
  return references;
}

function validateClosedLifecycle(events) {
  let turn;
  let step;
  let closedTurns = 0;
  let lastTurn = 0;
  const calls = new Map();
  const results = new Set();
  for (const event of events) {
    const data = event.data;
    if (PRIVATE_TYPES.has(event.type)) {
      requireFact(turn !== undefined, 'PRIVATE_OUTSIDE_TURN');
    }
    if (event.type === 'turn/start') {
      requireFact(turn === undefined && step === undefined, 'OPEN_TURN');
      requireFact(data.turn === lastTurn + 1, 'TURN_ORDER');
      turn = data.turn;
      lastTurn = turn;
    } else if (event.type === 'step/start') {
      requireFact(turn !== undefined && step === undefined, 'STEP_ORDER');
      requireFact(data.turn === turn, 'STEP_TURN');
      step = data.step;
    } else if (event.type === 'step/end') {
      requireFact(
        step !== undefined && data.turn === turn && data.step === step,
        'STEP_END',
      );
      step = undefined;
    } else if (event.type === 'turn/end') {
      requireFact(
        turn !== undefined && data.turn === turn && step === undefined,
        'TURN_END',
      );
      turn = undefined;
      closedTurns += 1;
    }
    if (event.type === 'tool/call') {
      requireFact(
        typeof data.callId === 'string' && !calls.has(data.callId),
        'TOOL_CALL_ID',
      );
      calls.set(data.callId, { turn, seq: event.seq });
    } else if (event.type === 'tool/result') {
      const blocks = data.message?.content;
      requireFact(
        Array.isArray(blocks) &&
          blocks.length === 1 &&
          blocks[0].type === 'tool-result',
        'TOOL_RESULT_SHAPE',
      );
      const id = blocks[0].toolCallId;
      requireFact(
        calls.has(id) && !results.has(id) && calls.get(id).turn === turn,
        'TOOL_RESULT_OWNER',
      );
      results.add(id);
    }
  }
  requireFact(
    turn === undefined &&
      step === undefined &&
      events.at(-1)?.type === 'turn/end',
    'TAIL_NOT_CLOSED',
  );
  requireFact(calls.size === results.size, 'UNPAIRED_TOOL');
  return { closedTurns, toolPairs: calls.size };
}

function inspectSource(sourceBytes, scope) {
  assertExactKeys(
    scope,
    [
      'source',
      'nativeSessionId',
      'cwd',
      'eventCount',
      'privateEvents',
      'references',
      'closedTurns',
      'toolPairs',
    ],
    'SCOPE_SHAPE',
  );
  assertExactKeys(scope.source, ['sha256', 'bytes'], 'SOURCE_PIN_SHAPE');
  requireFact(
    Buffer.isBuffer(sourceBytes) || sourceBytes instanceof Uint8Array,
    'SOURCE_BYTES',
  );
  requireFact(
    HASH.test(scope.source.sha256) &&
      sourceBytes.byteLength === scope.source.bytes &&
      hash(sourceBytes) === scope.source.sha256,
    'SOURCE_BYTES_DRIFT',
  );
  requireFact(
    Number.isSafeInteger(scope.eventCount) && scope.eventCount > 0,
    'EVENT_COUNT',
  );
  const artifact = decode(sourceBytes, releasedV3SessionFormatCodec);
  const { header, events } = artifact;
  requireFact(
    header.version === 3 &&
      header.id === scope.nativeSessionId &&
      header.cwd === scope.cwd,
    'SOURCE_IDENTITY',
  );
  requireFact(
    !header.isSeeded &&
      header.delegationDepth === 0 &&
      header.parentSession === undefined &&
      header.origin === undefined &&
      artifact.inheritedEventCount === 0,
    'ROOT_SCOPE',
  );
  requireFact(events.length === scope.eventCount, 'EVENT_COUNT');
  const privateEvents = [];
  for (const [index, event] of events.entries()) {
    requireFact(event.seq === index, 'SOURCE_SEQUENCE');
    requireFact(!Object.hasOwn(event, 'ignorable'), 'IGNORABLE_NOT_REVIEWED');
    if (PRIVATE_TYPES.has(event.type)) {
      assertExactKeys(
        event,
        ['type', 'seq', 'time', 'data'],
        'PRIVATE_ENVELOPE',
      );
      privateEvents.push({
        seq: event.seq,
        type: event.type,
        time: event.time,
        dataSha256: factHash(event.data),
      });
    } else {
      requireFact(
        RELEASED_V3_EVENT_TYPES.has(event.type) &&
          REVIEWED_NATIVE_TYPES.has(event.type),
        'EVENT_TYPE_NOT_REVIEWED',
      );
    }
  }
  // Do not silently broaden to another private vocabulary or another chat.
  requireFact(
    privateEvents.length === 4 &&
      privateEvents.filter((event) => event.type === 'allrice/input/request')
        .length === 3,
    'PRIVATE_COUNT',
  );
  requireFact(
    isDeepStrictEqual(privateEvents, scope.privateEvents),
    'PRIVATE_FACTS_DRIFT',
  );
  requireFact(
    isDeepStrictEqual(sourceReferences(events), scope.references),
    'REFERENCES_DRIFT',
  );
  for (const ref of scope.references) {
    requireFact(
      ref.path.endsWith('/attachmentId') &&
        typeof ref.value === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(ref.value),
      'EXTERNAL_REFERENCE_NOT_REVIEWED',
    );
  }
  const lifecycle = validateClosedLifecycle(events);
  requireFact(
    lifecycle.closedTurns === scope.closedTurns &&
      lifecycle.toolPairs === scope.toolPairs,
    'LIFECYCLE_DRIFT',
  );
  validateAllriceSessionJournal(header, events);
  return artifact;
}

function prepare(sourceBytes, scope) {
  const source = inspectSource(sourceBytes, scope);
  // A deterministic, source-specific private transport identity is never persisted.
  const transportType = `${TRANSPORT_PREFIX}${scope.source.sha256}`;
  requireFact(
    !Buffer.from(sourceBytes).includes(Buffer.from(TRANSPORT_PREFIX)),
    'TRANSPORT_COLLISION',
  );
  const migration = createSessionFormatV3ToV4([]);
  const header = migration.migrateHeader(source.header);
  requireFact(
    isDeepStrictEqual(header, { ...source.header, version: 4 }),
    'HEADER_CHANGED',
  );
  const stage = migration.createStage({
    sourceHeader: source.header,
    targetHeader: header,
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  });
  const events = [];
  const mapping = [];
  for (const event of source.events) {
    const isPrivate = PRIVATE_TYPES.has(event.type);
    const wire = isPrivate
      ? { ...event, type: transportType, ignorable: true }
      : event;
    const output = [];
    stage.transformEvent(globalThis.structuredClone(wire), {
      emitEvent(value) {
        output.push(value);
      },
      emitRun() {
        throw new Error('ALLRICE_V3_INPUT_CONVERSION_UNEXPECTED_OUTPUT_RUN');
      },
    });
    // This closed-root scope has no interrupted-turn insertion or child tail.
    // If upstream semantics change, refuse; do not guess an old→new mapping.
    requireFact(
      output.length === 1 &&
        output[0].seq === event.seq &&
        output[0].time === event.time,
      'UNREVIEWED_MAPPING',
    );
    let target = output[0];
    if (isPrivate) {
      requireFact(
        isDeepStrictEqual(target, { ...wire, type: `plugin:${transportType}` }),
        'PRIVATE_TRANSPORT_CHANGED',
      );
      target = globalThis.structuredClone(event);
    } else {
      // This narrow source has no inserted records. Native references keep
      // their coordinates; only public native payload migrations may change.
      requireFact(
        isDeepStrictEqual(target.sourceEventSeqs, event.sourceEventSeqs) &&
          isDeepStrictEqual(target.surfaceOp, event.surfaceOp),
        'NATIVE_LOCAL_REFERENCES_CHANGED',
      );
    }
    events.push(target);
    mapping.push({
      sourceSeq: event.seq,
      targetSeq: target.seq,
      sourceEventSha256: factHash(event),
      targetEventSha256: factHash(target),
    });
  }
  const tail = [];
  const inheritedEventCount = stage.finish({
    emitEvent(event) {
      tail.push(event);
    },
    emitRun() {
      throw new Error('ALLRICE_V3_INPUT_CONVERSION_UNEXPECTED_TAIL_RUN');
    },
  });
  requireFact(
    tail.length === 0 && inheritedEventCount === 0,
    'UNREVIEWED_TAIL',
  );
  const target = { header, inheritedEventCount, events };
  const known = new Set([...KNOWN_SESSION_EVENT_TYPES, ...PRIVATE_TYPES]);
  restoreReleasedV4Artifact(target, known);
  validateAllriceSessionJournal(header, events);
  // Public detached current validation; no store, backend, Host, or writer.
  // It may append an in-memory end-seed to its own Session; the prepared
  // artifact is kept separate and checked unchanged after validation.
  const before = factHash(target);
  Session.fromRestore(
    SessionId(header.id),
    globalThis.structuredClone(events),
    globalThis.structuredClone(header),
    SessionLogOffset(0),
    'detached',
  );
  requireFact(factHash(target) === before, 'VALIDATOR_MUTATED_TARGET');
  const finalPrivate = events.filter((event) => PRIVATE_TYPES.has(event.type));
  const originalPrivate = source.events.filter((event) =>
    PRIVATE_TYPES.has(event.type),
  );
  requireFact(
    isDeepStrictEqual(finalPrivate, originalPrivate),
    'PRIVATE_PRESERVATION',
  );
  requireFact(
    isDeepStrictEqual(sourceReferences(events), scope.references),
    'TARGET_REFERENCES_CHANGED',
  );
  requireFact(
    events.every(
      (event) =>
        !event.type.startsWith('plugin:') &&
        !event.type.startsWith(TRANSPORT_PREFIX),
    ),
    'TRANSPORT_RESIDUE',
  );
  const targetBytes = Buffer.from(
    [
      releasedV4SessionFormatCodec.encodeHeader(header, 0),
      ...events.map((event) => releasedV4SessionFormatCodec.encodeEvent(event)),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  requireFact(
    !targetBytes.includes(Buffer.from(TRANSPORT_PREFIX)),
    'TRANSPORT_RESIDUE',
  );
  const roundtrip = decode(targetBytes, releasedV4SessionFormatCodec);
  requireFact(isDeepStrictEqual(roundtrip, target), 'V4_CODEC_ROUNDTRIP');
  return {
    targetBytes,
    receipt: {
      kind: 'allrice-v3-input-pure-conversion-v1',
      source: globalThis.structuredClone(scope.source),
      sourceHeaderSha256: factHash(source.header),
      nativeSessionId: header.id,
      sourceFormat: 3,
      targetFormat: 4,
      target: { sha256: hash(targetBytes), bytes: targetBytes.length },
      eventCount: events.length,
      privateEvents: globalThis.structuredClone(scope.privateEvents),
      references: globalThis.structuredClone(scope.references),
      mapping,
      currentDetachedValidationPassed: true,
      originalPersistenceOpened: false,
      persistenceReadPassed: false,
      persistenceWritePassed: false,
      nativeContinuationPassed: false,
    },
  };
}

/** Convert only a detached, exact-byte source. Disabled unless explicitly opted in. */
export function prepareAllriceV3InputConversion({
  enabled = false,
  sourceBytes,
  scope,
} = {}) {
  assertEnabled(enabled);
  return prepare(Buffer.from(sourceBytes), scope);
}

/** Recompute with the public edge; reject changed bytes, mappings, and receipt facts. */
export function verifyAllriceV3InputConversion({
  enabled = false,
  sourceBytes,
  scope,
  targetBytes,
  receipt,
} = {}) {
  assertEnabled(enabled);
  const expected = prepare(Buffer.from(sourceBytes), scope);
  requireFact(
    Buffer.from(targetBytes).equals(expected.targetBytes),
    'TARGET_BYTES_DRIFT',
  );
  requireFact(
    isDeepStrictEqual(receipt, expected.receipt),
    'RECEIPT_OR_MAPPING_DRIFT',
  );
  return {
    verified: true,
    source: expected.receipt.source,
    target: expected.receipt.target,
    nativeContinuationPassed: false,
  };
}
