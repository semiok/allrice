import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import {
  claimMethodFileExecution,
  createEmployeeMethodFileOperation,
  getEmployeeMethodTest,
} from '@allrice/database';
import { runCloudCommandOperation } from './cloud-runner/executor.js';
import { executeEmployeeMethodFileStep } from './employee-method-file-tests.js';

vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  claimMethodFileExecution: vi.fn(),
  createEmployeeMethodFileOperation: vi.fn(),
  getEmployeeMethodTest: vi.fn(),
}));
vi.mock('./cloud-runner/executor.js', () => ({
  runCloudCommandOperation: vi.fn(),
}));

const operationId = randomUUID();
const readOperation = vi.fn();
const operation = {
  snapshot: { binding: { task: { scope: {} }, attempt: { operationId } } },
  ledger: { readOperation },
} as unknown as Awaited<ReturnType<typeof createEmployeeMethodFileOperation>>;
const input = () => ({
  context: {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    policySnapshot: { subjectId: randomUUID() },
  } as ExecutionContext,
  testId: randomUUID(),
  leaseToken: randomUUID(),
  jobAttempt: 1,
  call: {
    id: randomUUID(),
    name: 'platform.employee.method.step',
    arguments: { stage: 'normalize', script: 'console.log("fixture")' },
  },
  signal: new AbortController().signal,
  storageRoot: '/tmp/allrice-method-file-handler-unit',
  onUnverified: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createEmployeeMethodFileOperation).mockResolvedValue(operation);
  vi.mocked(getEmployeeMethodTest).mockResolvedValue({
    files: [],
    assertion: null,
    coverage: 'fixed_file_flow',
  } as unknown as Awaited<ReturnType<typeof getEmployeeMethodTest>>);
});

it('reads an active duplicate without reentering executor recovery or stopping the original', async () => {
  vi.mocked(claimMethodFileExecution).mockResolvedValue(false);
  readOperation.mockResolvedValue({ status: 'running' });
  const args = input();
  const result = await executeEmployeeMethodFileStep(args);
  expect(runCloudCommandOperation).not.toHaveBeenCalled();
  expect(readOperation).toHaveBeenCalledWith({}, operationId);
  expect(JSON.parse(result.modelContent as string)).toMatchObject({
    operationId,
    status: 'running',
    reconciled: true,
  });
  expect(args.onUnverified).not.toHaveBeenCalled();
});

it('retains the unverified flag when the executor returns an unknown physical outcome', async () => {
  vi.mocked(claimMethodFileExecution).mockResolvedValue(true);
  vi.mocked(runCloudCommandOperation).mockResolvedValue({
    operationId,
    status: 'unknown',
    artifacts: [],
    output: '',
  } as Awaited<ReturnType<typeof runCloudCommandOperation>>);
  const args = input();
  await executeEmployeeMethodFileStep(args);
  expect(runCloudCommandOperation).toHaveBeenCalledOnce();
  expect(args.onUnverified).toHaveBeenCalledWith('METHOD_FILE_UNKNOWN');
});
