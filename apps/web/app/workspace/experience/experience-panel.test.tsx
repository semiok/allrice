import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExperienceCandidate } from '@allrice/contracts';
import { ExperienceReviewCard } from './experience-panel';
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
