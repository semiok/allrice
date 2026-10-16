import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExperienceCandidate } from '@allrice/contracts';
import { ExperienceReviewCard, ExperienceDraftCard } from './experience-panel';
const candidate: ExperienceCandidate = {
  id: randomUUID(),
  content: '<script>not executable</script>',
  memoryClass: 'work_note',
  scope: 'private',
  status: 'pending',
  archived: false,
  revision: 1,
  digest: `sha256:${'a'.repeat(64)}`,
  source: {
    runId: randomUUID(),
    sessionId: randomUUID(),
    messageId: randomUUID(),
    excerpt: 'PRIVATE ORIGIN',
    digest: `sha256:${'b'.repeat(64)}`,
  },
  ownedByMe: true,
  canReview: true,
  createdAt: new Date().toISOString(),
  reviewedAt: null,
  reviewReason: null,
};
const render = (input: Partial<ExperienceCandidate> = {}) =>
  renderToStaticMarkup(
    <ExperienceReviewCard
      candidate={{ ...candidate, ...input }}
      onReview={async () => {}}
    />,
  );
describe('P20 explicit review presentation', () => {
  it('shows automatic evidence as pending and offers no legacy approval shortcut', () => {
    const html = render({ originKind: 'incremental', canReview: false });
    expect(html).toContain('待自动整理');
    expect(html).toContain('不会作为长期要求影响后续任务');
    expect(html).toContain('忘掉这条反馈');
    expect(html).not.toContain('明确批准为');
    expect(html).not.toContain('已确认长期记忆');
  });
  it('escapes untrusted rule and separates saved from explicitly approved', () => {
    const html = render();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('待明确审核');
    expect(html).toContain('明确批准为');
    expect(html).toContain('disabled');
    expect(html).toContain('PRIVATE ORIGIN');
  });
  it('workspace reviewer never receives a private-source expansion', () => {
    const html = render({ scope: 'workspace', ownedByMe: false, source: null });
    expect(html).not.toContain('PRIVATE ORIGIN');
    expect(html).not.toContain('查看私密来源');
    expect(html).toContain('原始私密对话未共享');
  });
  it('platform handoff is not a published Skill or tenant-admin approval', () => {
    const html = render({ scope: 'platform', canReview: false });
    expect(html).toContain('待人工转交');
    expect(html).toContain('未发布');
    expect(html).not.toContain('明确批准为');
    expect(html).toContain('复制脱敏建议');
  });
  it('approved revision explains future relevant Run use without modifying frozen Runs', () => {
    const html = render({ status: 'approved', revision: 2, canReview: false });
    expect(html).toContain('已确认长期记忆');
    expect(html).toContain('v2');
    expect(html).toContain('快照不会改写');
    expect(html).not.toContain('明确批准为');
  });
  it('does not claim archived approved memory will still be recalled', () => {
    const html = render({
      status: 'approved',
      archived: true,
      revision: 2,
      canReview: false,
    });
    expect(html).toContain('已归档');
    expect(html).toContain('不再召回');
    expect(html).not.toContain('后续相关新任务可召回');
    expect(html).not.toContain('明确批准为');
  });
});

it('keeps an automatically organized draft read-only and escapes model text', () => {
  const html = renderToStaticMarkup(
    <ExperienceDraftCard
      batch={{
        id: randomUUID(),
        runId: randomUUID(),
        instanceId: randomUUID(),
        status: 'succeeded',
        state: 'pending_validation',
        validations: [],
        validationNotes: [],
        adoptions: [],
        revision: 1,
        digest: 'sha256:' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        errorCode: null,
        sourceIds: [candidate.id],
        drafts: [
          {
            sourceIds: [candidate.id],
            rule: '<script>draft</script>',
            reason: '原始反馈',
            applicability: '退款对账',
            confidence: 'tentative',
            validation: {
              kind: 'calculation',
              check: '含退款的样本独立复算净回款。',
            },
          },
        ],
      }}
    />,
  );
  expect(html).toContain('经验草稿 · 待验证');
  expect(html).toContain('适用范围：');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('已确认长期记忆');
});

it('shows independent validation coverage as not enabled without an approval shortcut', () => {
  const html = renderToStaticMarkup(
    <ExperienceDraftCard
      batch={{
        id: randomUUID(),
        runId: randomUUID(),
        instanceId: randomUUID(),
        status: 'succeeded',
        state: 'pending_validation',
        revision: 1,
        digest: 'sha256:' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        errorCode: null,
        sourceIds: [candidate.id],
        drafts: [
          {
            sourceIds: [candidate.id],
            rule: '到场和未到分别核对',
            reason: '反馈',
            applicability: '名单',
            confidence: 'tentative',
            validation: { kind: 'calculation', check: '独立计数' },
          },
        ],
        validationNotes: [],
        adoptions: [],
        validations: [
          {
            id: randomUUID(),
            draftIndex: 0,
            caseId: 'attendance-roster-v1',
            status: 'succeeded',
            validationStatus: 'passed',
            runId: randomUUID(),
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            outputDigest: 'sha256:' + 'a'.repeat(64),
            active: false,
            assertion: {
              caseId: 'attendance-roster-v1',
              passed: true,
              reason: 'matched',
              checks: [{ id: 'complete-a', passed: true }],
            },
            coverage:
              '仅验证这份草稿在四个合成名单样例中的分组计数和缺失信息处理；不证明原任务名单或其他业务场景正确，尚未启用。',
          },
        ],
      }}
    />,
  );
  expect(html).toContain('专项样例通过 · 尚未启用');
  expect(html).toContain('不证明原任务名单或其他业务场景正确');
  expect(html).not.toContain('<button');
});

it.each(['active', 'forgotten', 'unavailable'] as const)(
  'shows the current private adoption state accurately: %s',
  (state) => {
    const html = renderToStaticMarkup(
      <ExperienceDraftCard
        batch={{
          id: randomUUID(),
          runId: randomUUID(),
          instanceId: randomUUID(),
          status: 'succeeded',
          state: 'pending_validation',
          revision: 1,
          digest: 'sha256:' + 'a'.repeat(64),
          createdAt: new Date().toISOString(),
          errorCode: null,
          sourceIds: [candidate.id],
          validations: [],
          validationNotes: [],
          drafts: [
            {
              sourceIds: [candidate.id],
              rule: '完整规则',
              reason: '反馈',
              applicability: '完整适用范围',
              confidence: 'tentative',
              validation: { kind: 'preference', check: '表达方式' },
            },
          ],
          adoptions: [
            {
              memoryId: candidate.id,
              draftIndex: 0,
              revision: state === 'forgotten' ? 2 : 1,
              state,
              reason: null,
              adoptedAt: new Date().toISOString(),
              recallCount: 2,
            },
          ],
        }}
      />,
    );
    expect(html).toContain(
      state === 'active'
        ? '已采用 · 仅用于此私人 AI 员工'
        : state === 'forgotten'
          ? '已撤回 · 不再采用'
          : '已停用 · 依据已变化',
    );
    expect(html).toContain('已为 2 次任务提供经验');
    expect(html).not.toContain('尚未启用');
    expect(html).not.toContain('已确认长期记忆');
    expect(html).not.toContain('<button');
  },
);
