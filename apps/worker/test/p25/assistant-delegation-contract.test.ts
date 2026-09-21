import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantRuntime } from '@allrice/database';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';

type Options = Parameters<typeof createAssistantWorkerBridge>[0];
function fixture() {
  const runId = randomUUID();
  const provision = vi.fn(async () => {
    throw Error('fixture_authority_checked');
  });
  const settleUsage = vi.fn(async () => {});
  const runtime = {
    getTree: vi.fn(async () => ({
      instances: [
        {
          runId,
          nativeSessionId: 'root',
          allowedTools: ['assistant.delegate', 'assistant.report'],
        },
      ],
    })),
    provision,
    settleUsage,
    reserveUsage: vi.fn(async () => ({ reserved: true })),
  } as unknown as AssistantRuntime;
  const bridge = createAssistantWorkerBridge({
    runtime,
    task: { rootRunId: runId, scope: {} } as Options['task'],
    context: {} as Options['context'],
    worker: {} as Options['worker'],
    wireNames: {},
    readOnlyTools: new Set(),
  });
  return { bridge, provision, settleUsage };
}
describe('assistant delegation requires an explicit result channel', () => {
  it.each([
    {
      evidence: [{ calculation: '19+23=42' }],
      error: 'assistant_report_invalid',
    },
    { evidence: [], error: 'assistant_report_delivery_required' },
  ])(
    'returns actionable $error without persisting fabricated completion',
    async ({ evidence, error }) => {
      const f = fixture();
      await expect(
        f.bridge.handle('report', {
          nativeSessionId: 'root',
          callId: 'report-1',
          arguments: {
            status: 'completed',
            summary: '42',
            evidence,
            incomplete: [],
          },
        }),
      ).resolves.toMatchObject({ error });
      expect(f.settleUsage).toHaveBeenCalledOnce();
    },
  );
  it.each([{ tools: [] }, { tools: ['web.search'] }])(
    'rejects an undeliverable child before provisioning (%j)',
    async ({ tools }) => {
      const f = fixture();
      await expect(
        f.bridge.handle('delegate', {
          nativeSessionId: 'root',
          callId: 'call-1',
          arguments: { label: 'child', text: 'Compute', tools },
        }),
      ).resolves.toMatchObject({ error: 'assistant_report_required' });
      expect(f.provision).not.toHaveBeenCalled();
      expect(f.settleUsage).toHaveBeenCalledOnce();
    },
  );
  it('passes explicit reporting to authoritative provision without adding any tools', async () => {
    const f = fixture();
    await expect(
      f.bridge.handle('delegate', {
        nativeSessionId: 'root',
        callId: 'call-1',
        arguments: {
          label: 'child',
          text: 'Compute',
          tools: ['assistant.report'],
        },
      }),
    ).rejects.toThrow('fixture_authority_checked');
    expect(f.provision).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['assistant.report'] }),
    );
  });
});
