import { createHash } from 'node:crypto';
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4';

export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function syntheticArtifact() {
  const header = {
    version: 3,
    id: 'dsh-synthetic-u2',
    cwd: '/synthetic/u2',
    createdAt: 10,
    isSeeded: false,
    delegationDepth: 0,
  };
  const events = [];
  const add = (type, data, extra = {}) =>
    events.push({
      type,
      seq: events.length,
      time: 100 + events.length,
      data,
      ...extra,
    });
  const turnId = `${header.id}:turn:1`;
  add('turn/start', { turn: 1 });
  add('allrice/input/request', {
    inputId: '00000000-0000-4000-8000-000000000001',
    digest: `sha256:${'a'.repeat(64)}`,
    messageId: 'question-one',
    turnId,
  });
  add('allrice/input/answered', {
    inputId: '00000000-0000-4000-8000-000000000001',
    questionId: 'question-one',
    turnId,
  });
  add('allrice/input/request', {
    inputId: '00000000-0000-4000-8000-000000000002',
    digest: `sha256:${'b'.repeat(64)}`,
    messageId: 'message-two',
    turnId,
  });
  add('allrice/input/request', {
    inputId: '00000000-0000-4000-8000-000000000003',
    digest: `sha256:${'c'.repeat(64)}`,
    messageId: 'message-three',
    turnId,
  });
  add('turn/end', { turn: 1, reason: { kind: 'cancelled' } });
  return { header, inheritedEventCount: 0, events };
}

export function sourceOf(artifact) {
  return Buffer.from(
    [
      releasedV3SessionFormatCodec.encodeHeader(
        artifact.header,
        artifact.inheritedEventCount,
      ),
      ...artifact.events.map((event) =>
        releasedV3SessionFormatCodec.encodeEvent(event),
      ),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
}

export function scopeOf(artifact, sourceBytes = sourceOf(artifact)) {
  const privateEvents = artifact.events
    .filter((event) => event.type.startsWith('allrice/'))
    .map((event) => ({
      seq: event.seq,
      type: event.type,
      time: event.time,
      dataSha256: digest(canonical(event.data)),
    }));
  return {
    source: { sha256: digest(sourceBytes), bytes: sourceBytes.length },
    nativeSessionId: artifact.header.id,
    cwd: artifact.header.cwd,
    eventCount: artifact.events.length,
    privateEvents,
    references: [],
    closedTurns: artifact.events.filter((event) => event.type === 'turn/end')
      .length,
    toolPairs: artifact.events.filter((event) => event.type === 'tool/call')
      .length,
  };
}

export function input(artifact = syntheticArtifact()) {
  const sourceBytes = sourceOf(artifact);
  return { enabled: true, sourceBytes, scope: scopeOf(artifact, sourceBytes) };
}

export function richArtifact() {
  const artifact = syntheticArtifact();
  const middle = [
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'system-one',
          role: 'system',
          content: [{ type: 'text', text: 'Synthetic historical system.' }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        },
      },
    },
    {
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'message-two',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'Synthetic user.' },
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${'d'.repeat(64)}`,
              mediaType: 'image/png',
              bytes: 12,
              width: 2,
              height: 2,
            },
          },
        ],
      },
    },
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: {
          id: 'assistant-one',
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'synthetic',
            model: 'synthetic-only',
          },
          content: [
            {
              type: 'tool-call',
              id: 'call-one',
              name: 'synthetic_tool',
              arguments: '{}',
            },
          ],
        },
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-one',
        name: 'synthetic_tool',
        arguments: '{}',
      },
    },
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-one',
          role: 'user',
          source: { kind: 'tool', callId: 'call-one' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-one',
              content: [{ type: 'text', text: 'Synthetic completed tool.' }],
              isError: false,
            },
          ],
        },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ];
  artifact.events.splice(1, 0, ...middle);
  artifact.events.forEach((event, seq) => {
    event.seq = seq;
    event.time = 100 + seq;
  });
  return artifact;
}

export function richInput() {
  const artifact = richArtifact();
  const args = input(artifact);
  const imageEvent = artifact.events.find(
    (event) => event.type === 'user/message',
  );
  args.scope.references = [
    {
      sourceSeq: imageEvent.seq,
      path: '/data/content/1/attachment/attachmentId',
      value: `sha256:${'d'.repeat(64)}`,
    },
  ];
  return args;
}
