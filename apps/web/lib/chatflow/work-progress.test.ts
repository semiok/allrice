import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import {
  isReplyStreaming,
  projectWorkProgress,
  workProcessReferenceKey,
  type WorkProcessReference,
} from './work-progress';

function event(
  sequence: number,
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown>,
  sourcePayload: Record<string, unknown> = {},
): ChatFlowEventEnvelope {
  const runId = '00000000-0000-4000-8000-000000000004';
  return {
    schemaVersion: 3,
    eventId: randomUUID(),
    organizationId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    conversationId: '00000000-0000-4000-8000-000000000003',
    runId,
    generation: 0,
    cursor: `${runId}:${sequence}`,
    sequence,
    harness: 'dsh',
    type,
    occurredAt: '2026-08-27T00:00:00.000Z',
    sourceEvent: {
      id: `dsh:${sequence}`,
      type: 'session.event',
      occurredAt: '2026-08-27T00:00:00.000Z',
      payload: sourcePayload,
    },
    payload,
  };
}

const reply = (seq: number, id: string, text: string, textMode = 'append') =>
  event(seq, 'assistant.text.delta', { replyId: id, text, textMode });
const tool = (seq: number, type: 'tool.started' | 'tool.completed') =>
  event(seq, type, {
    toolCallId: 'read',
    name: 'read',
    summary: '读取入口文件',
  });

describe('native reading order adapted to Allrice', () => {
  it('uses the current native phase instead of the presence of an earlier reply', () => {
    const events = [reply(1, 'a', '先查询 GitHub')];
    expect(isReplyStreaming(events)).toBe(true);
    events.push(reply(2, 'a', '先查询 GitHub', 'replace'));
    expect(isReplyStreaming(events)).toBe(false);
    events.push(tool(3, 'tool.started'), tool(4, 'tool.completed'));
    expect(isReplyStreaming(events)).toBe(false);
    events.push(reply(5, 'b', '最新结果'));
    expect(isReplyStreaming(events)).toBe(true);
    const projection = event(6, 'harness.native', { presentation: 'context' });
    projection.sourceEvent!.type = 'session/projection';
    expect(isReplyStreaming([...events, projection])).toBe(true);
    projection.sourceEvent!.type = 'request/context';
    expect(isReplyStreaming([...events, projection])).toBe(false);
    events.push(
      event(7, 'harness.native', { presentation: 'think', status: 'started' }),
    );
    expect(isReplyStreaming(events)).toBe(false);
  });
  it('unified output hides live replies and delivers only the final answer while retaining tool status', () => {
    const events = [
      reply(1, 'a', '阶段进展'),
      tool(2, 'tool.started'),
      reply(3, 'b', '最终答复半段'),
    ];
    const live = projectWorkProgress(events, '', true, false);
    expect(live.parts).toBeUndefined();
    expect(live.finalText).toBe('');
    expect(live.items).toHaveLength(1);
    expect(live.items[0]?.status).toBe('started');
    events.push(
      event(4, 'assistant.text.completed', {
        replyId: 'b',
        text: '完整最终答复',
      }),
    );
    expect(projectWorkProgress(events, '', false, false)).toMatchObject({
      parts: undefined,
      finalText: '完整最终答复',
    });
    expect(
      projectWorkProgress(events, '', false, true).parts?.[0],
    ).toMatchObject({ kind: 'reply', text: '阶段进展' });
  });
  it('interleaves settled replies and tools without duplicates on replay; final stays outside the fold', () => {
    const first = reply(1, 'a', '先查看目录');
    const events = [
      first,
      tool(3, 'tool.started'),
      reply(2, 'a', '先查看目录', 'replace'),
      tool(4, 'tool.completed'),
      reply(5, 'b', '已确认入口'),
      first,
    ];
    const live = projectWorkProgress(events.reverse(), '', true);
    expect(live.parts?.map((part) => part.kind)).toEqual([
      'reply',
      'steps',
      'reply',
    ]);
    expect(
      live.parts
        ?.filter((part) => part.kind === 'reply')
        .map((part) => part.text),
    ).toEqual(['先查看目录', '已确认入口']);
    expect(live.finalText).toBe('');
    events.push(
      event(6, 'assistant.text.completed', {
        replyId: 'b',
        text: '已确认入口（校准）',
      }),
    );
    const done = projectWorkProgress(events, 'stale', false);
    expect(done.parts?.map((part) => part.kind)).toEqual([
      'reply',
      'steps',
      'reply',
    ]);
    expect(done.parts?.at(-1)).toMatchObject({
      id: 'reply:b',
      text: '已确认入口（校准）',
    });
    expect(done.finalText).toBe('已确认入口（校准）');
  });
  it('replaces an abandoned partial reply, isolates attempts and retains visible progress on failure', () => {
    const stale = reply(1, 'old', '旧任务');
    stale.payload.attempt = 1;
    const current = [
      reply(2, 'a', '失败半句'),
      reply(3, 'a', '', 'replace'),
      reply(4, 'a', '重新检查'),
      tool(5, 'tool.started'),
    ];
    current.forEach((e) => {
      e.payload.attempt = 2;
    });
    const result = projectWorkProgress(
      [stale, ...current],
      '执行中断，请重试',
      false,
    );
    expect(result.parts?.map((part) => part.kind)).toEqual([
      'reply',
      'steps',
      'reply',
    ]);
    expect(JSON.stringify(result.parts)).toContain('重新检查');
    expect(JSON.stringify(result.parts)).not.toMatch(/失败半句|旧任务/);
    expect(result.finalText).toBe('执行中断，请重试');
  });
  it('does not infer historical reply boundaries; the authoritative final wins', () => {
    const result = projectWorkProgress(
      [
        event(1, 'assistant.text.delta', { text: '旧增量' }),
        event(2, 'assistant.text.completed', { text: '最终回复' }),
      ],
      'fallback',
      false,
    );
    expect(result.parts).toBeUndefined();
    expect(result.finalText).toBe('最终回复');
  });
});

function reference(id: string, call: string | null = 'read'): WorkProcessReference {
  const proof = tool(1, 'tool.started');
  return {
    source: 'cloud', id, runId: proof.runId, nativeCallId: call,
    title: 'read', status: '已完成',
    // Only persisted identity fields used by this pure association are needed.
    binding: {
      task: {
        runId: proof.runId, rootRunId: proof.runId,
        scope: { organizationId: proof.organizationId, workspaceId: proof.workspaceId },
      },
      attempt: { operationId: id, generation: 0, attemptNumber: 1 },
    } as WorkProcessReference['binding'],
  };
}

describe('authorized history association', () => {
  it('accepts canonical and historical native receipts of the same actual DSH source event', () => {
    // Existing native-experience fixture shapes; sourceMetadata preserves seq
    // as dsh:7 through runtime-contract and the public events route.
    const source = { turn: 1, step: 0, callId: 'read', name: 'read' };
    const normalized = event(2, 'tool.started', {
      toolCallId: 'read', name: 'read', generation: 0, attempt: 2,
    }, source);
    const native = event(1, 'harness.native', {
      presentation: 'tool', status: 'started', generation: 0, attempt: 2,
    }, source);
    for (const receipt of [native, normalized]) {
      receipt.sourceEvent!.id = 'dsh:7';
      receipt.sourceEvent!.type = 'tool/call';
    }
    const view = projectWorkProgress([native, normalized], '', true, true, [reference('exact')]);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      id: 'tool:read', status: 'started', operations: [{ id: 'exact' }],
    });
  });
  it.each([true, false])('keeps 1:N, duplicate receipts and old failures without changing native state (streaming=%s)', (streaming) => {
    const failed = { ...reference('first'), status: '未成功', failed: true },
      later = reference('second');
    const view = projectWorkProgress([
      reply(1, 'a', '开始'), tool(2, 'tool.started'), reply(4, 'b', '结束'),
    ], '', true, streaming, [failed, { ...failed }, later]);
    const call = view.items.find((item) => item.id === 'tool:read')!;
    expect(call).toMatchObject({ status: 'started', sequence: 2 });
    expect(call.operations?.map(workProcessReferenceKey)).toEqual(['cloud:first', 'cloud:second']);
    expect(call.operations?.map((op) => op.status)).toEqual(['未成功', '已完成']);
    expect(failed.failed).toBe(true);
    if (streaming) expect(view.parts?.at(-1)).toMatchObject({ kind: 'reply', text: '结束' });
    else expect(view.parts).toBeUndefined();
  });
  it('separates same-name native calls and preserves a true browser parent without inventing a child call', () => {
    const second = event(3, 'tool.completed', { toolCallId: 'second-call', name: 'read' });
    const parent = { ...reference('parent'), source: 'browser' as const },
      child = { ...reference('child', null), source: 'browser' as const, parentOperationId: 'parent' };
    const view = projectWorkProgress([tool(2, 'tool.started'), second], '', true, true, [
      parent, reference('other', 'second-call'), child,
    ]);
    expect(view.items.map((item) => [item.id, item.operations?.map((op) => op.id)])).toEqual([
      ['tool:read', ['parent']], ['tool:second-call', ['other']],
      ['operation:browser:child', ['child']],
    ]);
    expect(view.items.at(-1)?.operations?.[0]?.parentOperationId).toBe('parent');
    expect(view.items[1]?.status).toBe('completed');
  });
  it.each(['missing-call', 'missing-proof', 'legacy', 'ambiguous'])(
    'retains %s history without claiming a native call', (reason) => {
      const op = reference('unassigned', reason === 'missing-call' ? null : 'read');
      const events = [tool(2, 'tool.started')];
      if (reason === 'missing-proof') delete op.binding;
      if (reason === 'legacy') {
        op.nativeCallId = 'legacy:read';
        events[0]!.payload.toolCallId = 'legacy:read';
      }
      if (reason === 'ambiguous') events.push(tool(3, 'tool.started'));
      const view = projectWorkProgress(events, '', true, true, [op]);
      expect(view.items.find((item) => item.id === 'tool:read')?.operations).toBeUndefined();
      expect(view.items.at(-1)).toMatchObject({
        id: 'operation:cloud:unassigned', operations: [op],
      });
    },
  );
  it.each(['run', 'root', 'agent', 'generation', 'organization', 'workspace', 'operation', 'missing-generation', 'envelope-conflict'])(
    'does not associate mismatched real %s facts', (field) => {
      const op = reference('mismatched'), binding = op.binding!, native = tool(2, 'tool.started');
      if (field === 'run') op.runId = 'another-run';
      if (field === 'root') binding.task.rootRunId = 'another-root';
      if (field === 'agent') binding.task.runId = 'another-agent-run';
      if (field === 'generation') binding.attempt.generation = 1;
      if (field === 'organization') binding.task.scope.organizationId = 'another-org';
      if (field === 'workspace') binding.task.scope.workspaceId = 'another-workspace';
      if (field === 'operation') binding.attempt.operationId = 'another-operation';
      if (field === 'missing-generation') native.generation = null;
      if (field === 'envelope-conflict') { native.generation = 1; native.payload.generation = 0; }
      const view = projectWorkProgress([native], '', true, true, [op]);
      expect(view.items[0]?.operations).toBeUndefined();
      expect(view.items[1]?.operations).toEqual([op]);
    },
  );
  it('requires real managed job attempt and scope, never operation attemptNumber or fallback attempt 1', () => {
    const native = tool(2, 'tool.started');
    native.payload.attempt = 2;
    const managed: WorkProcessReference = {
      ...reference('task'), source: 'managed-browser', binding: undefined,
      organizationId: native.organizationId, workspaceId: native.workspaceId, jobAttempt: 2,
    };
    const bound = reference('bound');
    bound.binding!.attempt.attemptNumber = 9;
    const old = { ...managed, id: 'old-task', jobAttempt: 1, failed: true };
    expect(projectWorkProgress([native], '', true, true, [managed, bound, old]).items.map(
      (item) => item.operations?.map((op) => op.id),
    )).toEqual([['task', 'bound'], ['old-task']]);
    for (const op of [
      { ...managed, organizationId: 'other-org' }, { ...managed, workspaceId: 'other-workspace' },
    ]) {
      const view = projectWorkProgress([native], '', true, true, [op]);
      expect(view.items[0]?.operations).toBeUndefined();
      expect(view.items[1]?.operations).toEqual([op]);
    }
    delete native.payload.attempt;
    for (const op of [
      { ...managed, jobAttempt: 1 }, { ...managed, jobAttempt: undefined },
    ]) {
      const view = projectWorkProgress([native], '', true, true, [op]);
      expect(view.items[0]?.operations).toBeUndefined();
      expect(view.items[1]?.operations).toEqual([op]);
    }
  });
  it('keeps no-event history and the authoritative final without fabricating tool:call', () => {
    const view = projectWorkProgress([], '历史结论', false, true, [reference('history')]);
    expect(view.items.map((item) => item.id)).toEqual(['operation:cloud:history']);
    expect(view.parts?.map((part) => part.kind)).toEqual(['steps', 'reply']);
    expect(view.parts?.at(-1)).toMatchObject({ text: '历史结论', finalAnswer: true });
  });
});
