import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractionStatusPanel } from './interaction-status';

describe('P26 pending approvals remain visible without the retired history panel', () => {
  it('keeps precise-action approval visible without treating chat as authorization', () => {
    const operationId = randomUUID();
    const html = renderToStaticMarkup(
      <InteractionStatusPanel
        sessionId={randomUUID()}
        error=""
        onArtifact={() => {}}
        data={{
          runtime: null,
          inputs: [],
          pendingActions: [
            {
              approvalId: randomUUID(),
              operationId,
              runId: randomUUID(),
              expiresAt: '2026-09-14T12:00:00Z',
            },
          ],
        }}
      />,
    );
    expect(html).toContain('aria-label="等你确认的操作"');
    expect(html).toContain(`#operation-${operationId}`);
    expect(html).toContain('在对话里回复或认可计划，不等于允许这些操作');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('交互与任务记录');
  });
  it('uses in-page action navigation when wired, without a reload that loses draft/review state', () => {
    const html = renderToStaticMarkup(
      <InteractionStatusPanel
        sessionId={randomUUID()}
        error=""
        onArtifact={() => {}}
        onOperation={() => {}}
        data={{
          runtime: null,
          inputs: [],
          pendingActions: [
            {
              approvalId: randomUUID(),
              operationId: randomUUID(),
              runId: randomUUID(),
              expiresAt: '2026-09-21T12:00:00Z',
            },
          ],
        }}
      />,
    );
    expect(html).toMatch(
      /<button type="button" class="[^"]+">查看并确认<\/button>/,
    );
    expect(html).not.toContain('href="?session=');
    expect(html).toContain('在对话里回复或认可计划，不等于允许这些操作');
  });
});
