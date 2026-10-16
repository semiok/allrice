import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExperienceCandidate } from '@allrice/contracts';
import {
  ExperienceReviewCard,
  ExperienceDraftCard,
  ExperienceSummaryCard,
} from './experience-panel';
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
      onWithdraw={async () => {}}
    />,
  );
describe('Experience read-only history and owner withdrawal', () => {
  it('shows automatic evidence as pending and offers no legacy approval shortcut', () => {
    const html = render({ originKind: 'incremental', canReview: false });
    expect(html).toContain('待整理');
    expect(html).toContain('尚未形成可采用的经验');
    expect(html).toContain('忘掉这条反馈');
    expect(html).not.toContain('明确批准为');
    expect(html).not.toContain('历史经验 · 已启用');
  });
  it('escapes untrusted rule and separates saved from explicitly approved', () => {
    const html = render();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('历史候选 · 未启用');
    expect(html).not.toContain('明确批准为');
    expect(html).toContain('撤回这条记录');
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
    expect(html).toContain('历史平台建议');
    expect(html).toContain('未发布');
    expect(html).not.toContain('明确批准为');
    expect(html).not.toContain('复制脱敏建议');
  });
  it('approved revision explains future relevant Run use without modifying frozen Runs', () => {
    const html = render({ status: 'approved', revision: 2, canReview: false });
    expect(html).toContain('历史经验 · 已启用');
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
    expect(html).toContain('不再采用');
    expect(html).not.toContain('后续相关新任务可采用');
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
  expect(html).not.toContain('历史经验 · 已启用');
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
    expect(html).not.toContain('历史经验 · 已启用');
    expect(html).not.toContain('<button');
  },
);

it('shows already consolidated feedback without offering another manual approval', () => {
  const html = render({
    originKind: 'incremental',
    canReview: false,
    consolidatedAt: new Date().toISOString(),
  });
  expect(html).toContain('工作反馈 · 已整理');
  expect(html).not.toContain('待整理');
  expect(html).not.toContain('textarea');
});
it('shows actual policy, schedule and ledger totals, preserving the distinction between checks and results', () => {
  const html = renderToStaticMarkup(
    <ExperienceSummaryCard
      shared
      summary={{
        enabled: true,
        policy: {
          frequency: 'weekly',
          timezone: 'Asia/Shanghai',
          time: '03:00',
          weekday: 1,
          monthDay: 1,
          source: 'company',
          revision: 4,
          validationMode: 'supported_cases',
          adoptionMode: 'supported_private',
        },
        schedule: {
          state: 'scheduled',
          lastCheckedAt: '2026-10-16T03:00:00Z',
          nextRunAt: '2026-10-23T03:00:00Z',
          lastOccurrence: {
            createdAt: '2026-10-16T03:00:00Z',
            outcome: 'no_sources',
          },
        },
        counts: {
          pendingSources: 101,
          awaitingValidation: 2,
          adoptedTotal: 52,
        },
      }}
    />,
  );
  expect(html).toContain('公司设置');
  expect(html).toContain('每周');
  expect(html).toContain('没有新增反馈');
  expect(html).toContain('101 条');
  expect(html).toContain('52 条');
  expect(html).toContain('私人反馈、经验内容及技能版本仅本人可见');
  expect(html).not.toContain('自动沉淀尚未启用');
});

it.each([0, 1])(
  'does not label a successful zero-draft receipt pending validation (%i sources)',
  (count) => {
    const html = renderToStaticMarkup(
      <ExperienceDraftCard
        batch={{
          id: randomUUID(),
          runId: count ? randomUUID() : null,
          instanceId: randomUUID(),
          status: 'succeeded',
          state: count ? 'pending_validation' : 'not_ready',
          validations: [],
          validationNotes: [],
          adoptions: [],
          revision: count ? 1 : null,
          digest: count ? 'sha256:' + 'a'.repeat(64) : null,
          createdAt: new Date().toISOString(),
          errorCode: null,
          sourceIds: count ? [candidate.id] : [],
          drafts: [],
        }}
      />,
    );
    expect(html).toContain(count ? '未形成新经验' : '本次没有新增反馈');
    expect(html).not.toContain('经验草稿 · 待验证');
  },
);
