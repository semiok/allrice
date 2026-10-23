import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createSessionFormatV3ToV4,
  RELEASED_V3_EVENT_TYPES,
} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import {
  prepareAllriceV3InputConversion as prepare,
  verifyAllriceV3InputConversion as verify,
} from './allrice-v3-input-conversion.mjs';
import {
  digest,
  input,
  richArtifact,
  richInput,
  scopeOf,
  syntheticArtifact,
} from './fixtures/allrice-v3-input-conversion.fixture.mjs';

function physicalRows(bytes) {
  return bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
}
function rawInput(artifact) {
  const sourceBytes = Buffer.from(
    [{ type: 'session', ...artifact.header }, ...artifact.events]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  return { enabled: true, sourceBytes, scope: scopeOf(artifact, sourceBytes) };
}

test('conversion and verification are disabled by default, with no I/O entry point', () => {
  assert.throws(() => prepare(), /DISABLED/);
  assert.throws(() => prepare({ ...input(), enabled: false }), /DISABLED/);
  assert.throws(() => verify(), /DISABLED/);
});

test('stock public edge refuses a required AllRice record; adapter does not mutate its vocabulary', () => {
  const source = syntheticArtifact();
  const beforeV3 = [...RELEASED_V3_EVENT_TYPES];
  const beforeCurrent = [...KNOWN_SESSION_EVENT_TYPES];
  const migration = createSessionFormatV3ToV4([]);
  const stage = migration.createStage({
    sourceHeader: source.header,
    targetHeader: migration.migrateHeader(source.header),
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  });
  const context = {
    emitEvent() {},
    emitRun() {
      assert.fail('not a compact source');
    },
  };
  stage.transformEvent(source.events[0], context);
  assert.throws(
    () => stage.transformEvent(source.events[1], context),
    /unknown event type "allrice\/input\/request"/,
  );
  prepare(input(source));
  assert.deepEqual([...RELEASED_V3_EVENT_TYPES], beforeV3);
  assert.deepEqual([...KNOWN_SESSION_EVENT_TYPES], beforeCurrent);
});

test('public converter plus detached V4 validation preserve four required event envelopes and original checksum', () => {
  const source = syntheticArtifact();
  const args = input(source);
  const originalBytes = Buffer.from(args.sourceBytes);
  const result = prepare(args);
  const rows = physicalRows(result.targetBytes);
  assert.equal(rows[0].version, 4);
  assert.equal(rows[0].id, source.header.id);
  assert.deepEqual(
    rows.slice(1).filter((event) => event.type.startsWith('allrice/')),
    source.events.filter((event) => event.type.startsWith('allrice/')),
  );
  assert.equal(result.receipt.source.sha256, digest(originalBytes));
  assert.deepEqual(args.sourceBytes, originalBytes);
  assert.ok(
    result.receipt.mapping.every((item) => item.sourceSeq === item.targetSeq),
  );
  assert.equal(result.receipt.nativeContinuationPassed, false);
  assert.equal(result.receipt.persistenceReadPassed, false);
  assert.ok(
    !result.targetBytes.toString().includes('allrice-v3-input-transport:'),
  );
  assert.ok(
    !rows
      .slice(1)
      .some((event) => event.ignorable || event.type.startsWith('plugin:')),
  );
  assert.equal(verify({ ...args, ...result }).verified, true);
});

test('real public edge lifts native tool role and source while preserving local refs, image commitment, and private records', () => {
  const args = richInput();
  const result = prepare(args);
  const rows = physicalRows(result.targetBytes).slice(1);
  const system = rows.find((event) => event.type === 'system/message');
  const tool = rows.find((event) => event.type === 'tool/result');
  assert.deepEqual(system.data.message.source, { kind: 'system-prompt' });
  assert.equal(tool.data.message.role, 'tool');
  assert.equal(tool.data.message.toolCallId, 'call-one');
  assert.deepEqual(tool.data.message.content, [
    { type: 'text', text: 'Synthetic completed tool.' },
  ]);
  assert.deepEqual(result.receipt.references, args.scope.references);
  assert.equal(result.receipt.privateEvents.length, 4);
  assert.equal(verify({ ...args, ...result }).verified, true);
});

test('source byte drift rejects even semantically identical whitespace', () => {
  const args = input();
  args.sourceBytes = Buffer.concat([args.sourceBytes, Buffer.from('\n')]);
  assert.throws(() => prepare(args), /SOURCE_BYTES_DRIFT/);
});

test('scope identity and exact private audit facts reject mismatch', () => {
  const args = input();
  assert.throws(
    () =>
      prepare({
        ...args,
        scope: { ...args.scope, nativeSessionId: 'another-chat' },
      }),
    /SOURCE_IDENTITY/,
  );
  const scope = globalThis.structuredClone(args.scope);
  scope.privateEvents[0].time += 1;
  assert.throws(() => prepare({ ...args, scope }), /PRIVATE_FACTS_DRIFT/);
});

test('unknown required and ignorable types both reject, even with freshly committed source bytes', () => {
  for (const ignorable of [false, true]) {
    const artifact = syntheticArtifact();
    artifact.events[1].type = 'unknown/required';
    if (ignorable) artifact.events[1].ignorable = true;
    assert.throws(
      () => prepare(rawInput(artifact)),
      /EVENT_TYPE_NOT_REVIEWED|IGNORABLE_NOT_REVIEWED/,
    );
  }
});

test('private extra references and invalid typed payload cannot hide in opaque transport', () => {
  const artifact = syntheticArtifact();
  artifact.events[1].data.targetSessionId = 'another-session';
  assert.throws(() => prepare(rawInput(artifact)), /REFERENCES_DRIFT/);
  delete artifact.events[1].data.targetSessionId;
  artifact.events[1].data.extraOpaque = 'unreviewed';
  assert.throws(
    () => prepare(rawInput(artifact)),
    /Unrecognized key|unrecognized_keys/,
  );
});

test('even a reviewed reference list cannot authorize a child/session reference', () => {
  const artifact = syntheticArtifact();
  artifact.events[1].data.sessionId = 'another-session';
  const args = rawInput(artifact);
  args.scope.references = [
    { sourceSeq: 1, path: '/data/sessionId', value: 'another-session' },
  ];
  assert.throws(() => prepare(args), /EXTERNAL_REFERENCE_NOT_REVIEWED/);
});

test('private surface/sequence metadata rejects instead of omitting a required reference rewrite', () => {
  const artifact = syntheticArtifact();
  artifact.events[2].sourceEventSeqs = [1];
  assert.throws(() => prepare(rawInput(artifact)), /PRIVATE_ENVELOPE/);
});

test('private answer order and duplicate input ownership reject despite updated source commitment', () => {
  const outOfOrder = syntheticArtifact();
  [outOfOrder.events[1], outOfOrder.events[2]] = [
    outOfOrder.events[2],
    outOfOrder.events[1],
  ];
  outOfOrder.events.forEach((event, seq) => {
    event.seq = seq;
  });
  assert.throws(() => prepare(rawInput(outOfOrder)), /PRIVATE_FACTS_INVALID/);
  const duplicate = syntheticArtifact();
  duplicate.events[3].data.inputId = duplicate.events[1].data.inputId;
  assert.throws(() => prepare(rawInput(duplicate)), /PRIVATE_FACTS_INVALID/);
});

test('unexpected private types, lost records, and retyped records reject', () => {
  const lost = syntheticArtifact();
  lost.events.splice(3, 1);
  lost.events.forEach((event, seq) => {
    event.seq = seq;
  });
  assert.throws(() => prepare(rawInput(lost)), /PRIVATE_COUNT/);
  const other = syntheticArtifact();
  other.events[3].type = 'allrice/wait/continued';
  assert.throws(() => prepare(rawInput(other)), /EVENT_TYPE_NOT_REVIEWED/);
});

test('no incomplete-turn repair or seeded/child history is implicitly admitted', () => {
  const open = syntheticArtifact();
  open.events.pop();
  assert.throws(() => prepare(rawInput(open)), /TAIL_NOT_CLOSED/);
  const child = syntheticArtifact();
  child.header.parentSession = 'another-parent';
  child.header.origin = 'subagent';
  child.header.delegationDepth = 1;
  assert.throws(() => prepare(rawInput(child)), /ROOT_SCOPE/);
});

test('missing paired tool result rejects', () => {
  const artifact = richArtifact();
  const resultIndex = artifact.events.findIndex(
    (event) => event.type === 'tool/result',
  );
  artifact.events.splice(resultIndex, 1);
  artifact.events.forEach((event, seq) => {
    event.seq = seq;
  });
  const args = rawInput(artifact);
  args.scope.references = [
    {
      sourceSeq: 3,
      path: '/data/content/1/attachment/attachmentId',
      value: `sha256:${'d'.repeat(64)}`,
    },
  ];
  assert.throws(() => prepare(args), /UNPAIRED_TOOL/);
});

test('target byte or private payload drift rejects even when candidate checksum is updated', () => {
  const args = input();
  const result = prepare(args);
  const rows = physicalRows(result.targetBytes);
  rows[2].data.digest = `sha256:${'e'.repeat(64)}`;
  const targetBytes = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  const receipt = globalThis.structuredClone(result.receipt);
  receipt.target = { sha256: digest(targetBytes), bytes: targetBytes.length };
  assert.throws(
    () => verify({ ...args, targetBytes, receipt }),
    /TARGET_BYTES_DRIFT/,
  );
});

test('mapping reorder, fake target scope and fabricated continuation claims reject', () => {
  const args = input();
  const result = prepare(args);
  for (const mutate of [
    (receipt) => {
      receipt.mapping[1].targetSeq = 2;
    },
    (receipt) => {
      receipt.nativeSessionId = 'other-chat';
    },
    (receipt) => {
      receipt.nativeContinuationPassed = true;
    },
  ]) {
    const receipt = globalThis.structuredClone(result.receipt);
    mutate(receipt);
    assert.throws(
      () => verify({ ...args, ...result, receipt }),
      /RECEIPT_OR_MAPPING_DRIFT/,
    );
  }
});

test('opaque/nonce/plugin transport cannot leak through final validation', () => {
  const args = input();
  const result = prepare(args);
  const rows = physicalRows(result.targetBytes);
  rows[2].type = `plugin:allrice-v3-input-transport:${args.scope.source.sha256}`;
  rows[2].ignorable = true;
  const targetBytes = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  assert.throws(
    () => verify({ ...args, ...result, targetBytes }),
    /TARGET_BYTES_DRIFT/,
  );
});

test('native forward references reject through the actual public source codec', () => {
  const artifact = richArtifact();
  const args = richInput();
  const result = prepare(args);
  assert.ok(
    result.receipt.mapping.every(
      (mapping) => mapping.targetSeq === mapping.sourceSeq,
    ),
  );
  const tool = artifact.events.find((event) => event.type === 'tool/result');
  tool.sourceEventSeqs = [tool.seq + 1];
  assert.throws(() => prepare(rawInput(artifact)), /earlier seqs/);
});

test('private events outside an active turn reject instead of inheriting the previous turn implicitly', () => {
  const artifact = syntheticArtifact();
  const request = artifact.events.splice(4, 1)[0];
  artifact.events.push(
    request,
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'cancelled' } } },
  );
  artifact.events.forEach((event, seq) => {
    event.seq = seq;
    event.time = 100 + seq;
  });
  assert.throws(() => prepare(rawInput(artifact)), /PRIVATE_OUTSIDE_TURN/);
});

test('deterministic repeats produce identical target bytes without invoking any persistence or runtime', () => {
  const args = richInput();
  const first = prepare(args);
  const second = prepare(args);
  assert.deepEqual(first, second);
  assert.equal(first.receipt.source.sha256, digest(args.sourceBytes));
  assert.equal(first.receipt.currentDetachedValidationPassed, true);
  assert.equal(first.receipt.originalPersistenceOpened, false);
});
