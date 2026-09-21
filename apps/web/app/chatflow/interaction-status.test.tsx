import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractionStatusPanel } from './interaction-status';

describe('P26 pending approvals remain outside collapsed history', () => {
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
    expect(html.indexOf('aria-label="待批准动作"')).toBeLessThan(
      html.indexOf('<details'),
    );
    expect(html).toContain(`#operation-${operationId}`);
    expect(html).toContain('不会通过聊天或计划认可代替授权');
    expect(html).not.toContain('<details open');
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
    expect(html).toContain(
      '<button type="button">查看精确动作与批准／拒绝</button>',
    );
    expect(html).not.toContain('href="?session=');
    expect(html).toContain('不会通过聊天或计划认可代替授权');
  });
});
