import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cloudToolchainImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';

const guard = vi.hoisted(() => ({
  open: vi.fn(),
  renew: vi
    .fn<(expiresAt: number) => Promise<void>>()
    .mockResolvedValue(undefined),
  close: vi.fn(),
}));
vi.mock('./project-service-guard.js', () => ({
  openCloudProjectServiceGuard: guard.open,
  openCloudSandboxExecutionGuard: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

it.each(['root', 'network', 'service'])(
  'binds the physical service lease to the admitted %s deadline',
  async (earliest) => {
    const now = Date.now(),
      serviceDeadline = now + (earliest === 'service' ? 60000 : 3600000),
      effectiveDeadline =
        earliest === 'service' ? serviceDeadline : now + 30000,
      deadline = new Date(effectiveDeadline).toISOString(),
      attemptId = randomUUID();
    guard.open.mockResolvedValue(guard);
    class Backend extends CloudRunnerBackend {
      override async json<T>() {
        return { Id: 'a'.repeat(64) } as T;
      }
      override async call() {
        return Buffer.alloc(0);
      }
    }
    const backend = new Backend(),
      stdin = new PassThrough();
    Reflect.set(backend, 'attachInput', async () => stdin);
    Reflect.set(backend, 'runProjectService', async () => ({
      stopped: true,
      reason: 'completed',
      exitCode: 0,
    }));
    const execute = Reflect.get(backend, 'executeAdmittedPlan').bind(backend);
    await execute(
      {
        command: { kind: 'project', imageDigest: cloudToolchainImageV1 },
        config: {
          Labels: {
            'xyz.bplabs.allrice.cloud.deadline': String(effectiveDeadline),
          },
        },
      },
      {
        attemptId,
        deadlineAt: deadline,
        maintainLease: async () => true,
        projectService: {
          hardDeadlineAt: new Date(serviceDeadline).toISOString(),
          exchange: async () => ({
            stopRequested: false,
            leaseExpiresAt: new Date(now + 15000).toISOString(),
            projectService: {
              expiresAt: new Date(serviceDeadline).toISOString(),
            },
          }),
        },
      },
      now,
      effectiveDeadline,
    );
    expect(guard.open).toHaveBeenCalledExactlyOnceWith(attemptId, deadline);
    expect(guard.renew).toHaveBeenCalled();
    expect(guard.renew.mock.calls[0]![0]).toBeLessThanOrEqual(
      effectiveDeadline,
    );
    expect(guard.close).toHaveBeenCalled();
    stdin.destroy();
  },
);
