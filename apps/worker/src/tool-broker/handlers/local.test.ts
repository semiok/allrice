import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolExecutionInput } from '../types.js';
const ports = vi.hoisted(() => ({
  create: vi.fn(),
  wait: vi.fn(),
  cloud: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createLocalCommandOperation: ports.create,
  waitLocalCommandOperation: ports.wait,
  createCloudCommandOperation: ports.cloud,
  executionResourceObserver: ports.observe,
}));
import { RuntimePolicyError } from '@allrice/database';
import { executeControlledLocalCommand } from './local.js';
const input = {
  context: {},
  call: { id: 'synthetic', name: 'local.process.execute', arguments: {} },
  storageRoot: '/tmp/unused',
} as RiceToolExecutionInput;
beforeEach(() => vi.clearAllMocks());
it('keeps an explicitly local unavailable call bound locally without execution, waiting or a cross-end call', async () => {
  ports.create.mockRejectedValueOnce(
    new RuntimePolicyError('local_runner_unavailable'),
  );
  const result = await executeControlledLocalCommand({ input, arguments: {} });
  const payload = JSON.parse(result.modelContent);
  expect(payload).toMatchObject({
    executed: false,
    status: 'environment_unavailable',
    executionLocation: 'local',
    executionChoice: {
      location: 'local',
      status: 'unavailable',
      reason: 'local_inputs_required',
    },
  });
  expect(payload).not.toHaveProperty('recoveryTool');
  expect(payload.nextAction).toContain('用户明确允许云端');
  expect(payload.nextAction).toContain('新的工具调用');
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(ports.wait).not.toHaveBeenCalled();
  expect(ports.cloud).not.toHaveBeenCalled();
  expect(ports.observe).not.toHaveBeenCalled();
});
it('does not turn an authority denial into cloud execution or a successful tool result', async () => {
  ports.create.mockRejectedValueOnce(
    new RuntimePolicyError('membership_denied'),
  );
  await expect(
    executeControlledLocalCommand({ input, arguments: {} }),
  ).rejects.toThrow('membership_denied');
  expect(ports.wait).not.toHaveBeenCalled();
  expect(ports.cloud).not.toHaveBeenCalled();
  expect(ports.observe).not.toHaveBeenCalled();
});
