import { expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import {
  createAssistantMessage,
  expandAssistantStream,
} from '@deepseek-ai/dsh-llm';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type {
  NativeDiagnosticTargetSlice,
  NativeSessionPin,
} from '@allrice/database';
import { NativeRunDiagnosticsSchema } from '@allrice/contracts';
import {
  projectNativeDiagnosticSlice,
  readNativeRunDiagnostics,
  readNativeDiagnosticJournalAt,
  readApprovedNativeDiagnosticJournal,
} from './native-run-diagnostics.js';

const pin: NativeSessionPin = {
  nativeSessionId: 'dsh-11111111-1111-4111-8111-111111111111',
  artifactId: 'sha256:' + 'a'.repeat(64),
  artifactManifestDigest: 'sha256:' + 'a'.repeat(64),
  distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
  profileId: 'restricted',
  storageNamespace: '/private/not-returned',
  storageContextKey: 'context',
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  contextKind: 'chat',
  contextId: '44444444-4444-4444-8444-444444444444',
  firstRunId: '55555555-5555-4555-8555-555555555555',
  firstJobId: '66666666-6666-4666-8666-666666666666',
  firstAttempt: 1,
  boundAt: '2026-10-24T00:00:00Z',
  bindingBasis: 'business_root_origin',
};
const target: NativeDiagnosticTargetSlice = {
  attempt: 1,
  generation: 2,
  nativeSessionId: pin.nativeSessionId,
  receipts: [{ seq: 2, type: 'assistant/message', turn: 4 }],
  verifiedTurns: [4],
  reasons: [],
  binding: pin,
};
const secret = 'PRIVATE_PROMPT_REASONING_TOOL_TOKEN';
const stream = [
  {
    type: 'chunk' as const,
    time: 110,
    chunk: {
      type: 'block-start' as const,
      index: 0,
      blockType: 'reasoning' as const,
    },
  },
  {
    type: 'reasoning-chunks' as const,
    time0: 111,
    index: 0,
    dt: [3],
    texts: [secret, secret],
  },
  {
    type: 'text-chunks' as const,
    time0: 120,
    index: 1,
    dt: [],
    texts: [secret],
  },
  {
    type: 'chunk' as const,
    time: 125,
    chunk: { type: 'finish' as const, reason: { kind: 'stop' as const } },
  },
];
const events = [
  { seq: 0, type: 'turn/start', time: 100, data: { turn: 4 } },
  { seq: 1, type: 'step/start', time: 101, data: { turn: 4, step: 1 } },
  {
    seq: 2,
    type: 'assistant/message',
    surfaceOp: 'append',
    time: 130,
    data: {
      turn: 4,
      step: 1,
      message: { content: [{ text: secret }] },
      stream,
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 90 },
      credentials: secret,
    },
  },
  {
    seq: 3,
    type: 'tool/call',
    time: 131,
    data: {
      turn: 4,
      step: 1,
      callId: 'call_1',
      name: 'cloud_mcp_call',
      arguments: { token: secret },
    },
  },
  {
    seq: 4,
    type: 'tool/result',
    time: 132,
    data: {
      turn: 4,
      step: 1,
      message: { toolCallId: 'call_1', content: [{ text: secret }] },
      error: { code: 'MCP_DENIED', message: secret },
    },
  },
  { seq: 5, type: 'step/end', time: 133, data: { turn: 4, step: 1 } },
  {
    seq: 6,
    type: 'turn/end',
    time: 134,
    data: { turn: 4, reason: { kind: 'completed' } },
  },
  {
    seq: 7,
    type: 'assistant/message',
    time: 140,
    data: {
      turn: 5,
      step: 1,
      stream,
      message: { content: [{ text: secret }] },
    },
  },
];
const expand = expandAssistantStream as Parameters<
  typeof projectNativeDiagnosticSlice
>[1]['expand'];

it('expands only the verified Run turn and returns stream times/counts without any content', () => {
  const result = projectNativeDiagnosticSlice(target, { events, expand });
  expect(result.status).toBe('available');
  expect(result.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(result.events[2]!.stream).toMatchObject({
    chunkCount: 5,
    firstChunkAt: 110,
    firstReasoningAt: 111,
    firstTextAt: 120,
    finishAt: 125,
  });
  expect(result.events[2]!.usage).toMatchObject({
    cacheReadTokens: 90,
    cacheWriteTokens: null,
    totalTokens: null,
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(pin.storageNamespace);
});
it('does not infer a turn from an adjacent timestamp, missing source or conflicting native type', () => {
  const exact = projectNativeDiagnosticSlice(
    { ...target, verifiedTurns: [] },
    { events, expand },
  );
  expect(exact.events.map((e) => e.seq)).toEqual([2]);
  const bad = projectNativeDiagnosticSlice(
    { ...target, receipts: [{ seq: 1, type: 'assistant/message', turn: 4 }] },
    { events, expand },
  );
  expect(bad.events).toEqual([]);
  expect(bad.reasons).toContain('source_event_mismatch');
  const missing = projectNativeDiagnosticSlice(
    {
      ...target,
      receipts: [{ seq: 99, type: 'assistant/message', turn: 4 }],
      verifiedTurns: [],
    },
    { events, expand },
  );
  expect(missing.reasons).toContain('source_event_missing');
});
it('keeps unfinished turns and unrecorded streams explicitly incomplete without synthetic closers', () => {
  const pending = events
    .slice(0, 3)
    .map((e) =>
      e.seq === 2 ? { ...e, data: { ...e.data, stream: undefined } } : e,
    );
  const result = projectNativeDiagnosticSlice(target, {
    events: pending,
    expand,
  });
  expect(result.status).toBe('partial');
  expect(result.reasons).toEqual(
    expect.arrayContaining(['turn_end_unobserved', 'stream_unavailable']),
  );
  expect(result.events.some((e) => e.type === 'turn/end')).toBe(false);
});
it('does not consult an unapproved/missing binding and never exposes reader failures', async () => {
  await expect(
    readApprovedNativeDiagnosticJournal(pin, new AbortController().signal),
  ).rejects.toMatchObject({ reason: 'reader_unavailable' });
  const read = vi.fn().mockRejectedValue(Error(`/private/source ${secret}`));
  const report = await readNativeRunDiagnostics(
    { runId: pin.firstRunId, running: false, reasons: [], slices: [target] },
    new AbortController().signal,
    read,
  );
  expect(report.status).toBe('unavailable');
  expect(JSON.stringify(report)).not.toContain(secret);
  NativeRunDiagnosticsSchema.parse(report);
  read.mockClear();
  await readNativeRunDiagnostics(
    {
      runId: pin.firstRunId,
      running: false,
      reasons: [],
      slices: [{ ...target, binding: null, reasons: ['binding_unavailable'] }],
    },
    new AbortController().signal,
    read,
  );
  expect(read).not.toHaveBeenCalled();
});
it('uses a real current public JSONL read handle, preserves bytes/mtime, and does not close an unfinished turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-diagnostic-reader-'));
  const ctx = new Context();
  const plugin = ctx.plugin(JsonlPersistence, { root, compression: 'none' });
  try {
    await plugin.await();
    const persistence = ctx.get('sessionPersistence') as SessionPersistence;
    const id = SessionId(pin.nativeSessionId);
    const header = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 100,
      isSeeded: false,
    } as const;
    const session = Session.create(id, [], header);
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: secret }],
          source: { provider: 'fixture', model: 'not-called' },
        }),
        stream,
      },
      { surfaceOp: 'append' },
    );
    const writer = await persistence.create(header);
    await writer.append(session.snapshotEvents());
    await writer.flush();
    await writer.close();
    async function files(
      path: string,
    ): Promise<{ path: string; bytes: string; mtimeMs: number }[]> {
      const out = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const p = join(path, entry.name);
        if (entry.isDirectory()) out.push(...(await files(p)));
        else
          out.push({
            path: p,
            bytes: (await readFile(p)).toString('base64'),
            mtimeMs: (await stat(p)).mtimeMs,
          });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    const before = await files(root);
    const journal = await readNativeDiagnosticJournalAt(
      fileURLToPath(
        new URL('../../dsh/allrice-jsonrpc-runtime.mjs', import.meta.url),
      ),
      { ...pin, storageNamespace: root },
      new AbortController().signal,
    );
    expect(journal.events).toEqual(session.snapshotEvents());
    expect(journal.events.some((e) => e.type === 'turn/end')).toBe(false);
    expect(journal.expand(stream)).toHaveLength(5);
    expect(await files(root)).toEqual(before);
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
