import { expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolExecutionInput } from '../types.js';
const ports = vi.hoisted(() => ({ create: vi.fn(), wait: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createLocalCommandOperation: ports.create,
  waitLocalCommandOperation: ports.wait,
}));
import { RuntimePolicyError } from '@allrice/database';
import { executeControlledLocalCommand } from './local.js';
const input = {
  context: {},
  call: { id: 'synthetic', name: 'local.process.execute', arguments: {} },
  storageRoot: '/tmp/unused',
} as RiceToolExecutionInput;
it('provides the existing cloud execution route when no local runner is available, without claiming execution', async () => {
  ports.create.mockRejectedValueOnce(
    new RuntimePolicyError('local_runner_unavailable'),
  );
  const result = await executeControlledLocalCommand({ input, arguments: {} });
  expect(JSON.parse(result.modelContent)).toMatchObject({
    executed: false,
    status: 'environment_unavailable',
    recoveryTool: 'cloud.process.execute',
  });
  expect(ports.wait).not.toHaveBeenCalled();
});
it('does not turn an authority denial into cloud execution or a successful tool result', async () => {
  ports.create.mockRejectedValueOnce(
    new RuntimePolicyError('membership_denied'),
  );
  await expect(
    executeControlledLocalCommand({ input, arguments: {} }),
  ).rejects.toThrow('membership_denied');
});
