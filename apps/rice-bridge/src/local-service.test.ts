import { describe, it, expect, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalServiceInputSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { LocalCommandRunner } from './local-command-runner.js';
import {
  LocalServiceRunner,
  localServiceStopReason,
} from './local-service-runner.js';
import { fixtureId } from './journal-fixtures.js';

function command() {
  return RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['server.mjs'],
      path: '.',
      files: [{ path: 'server.mjs', sha256: 'sha256:' + 'a'.repeat(64) }],
      imageDigest: localCommandToolchainImageV1,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 10000,
        outputBytes: 8192,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
      background: {
        durationMs: 10000,
        readiness: { kind: 'tcp', port: 3100, path: '/', timeoutMs: 5000 },
        stdin: {
          mode: 'none',
          maxRequests: 1,
          maxBytes: 100,
          requestTimeoutMs: 1000,
        },
      },
    },
  });
}
describe('P09-c explicit service contract boundaries', () => {
  it.each(['lease_lost', 'canceled'] as const)(
    'classifies %s at the exact hard deadline as timeout, but preserves a genuinely earlier stop',
    (reason) => {
      expect(localServiceStopReason(reason, 1000, 999)).toBe(reason);
      expect(localServiceStopReason(reason, 1000, 1000)).toBe('timeout');
      expect(localServiceStopReason(reason, 1000, 1001)).toBe('timeout');
      let first: ReturnType<typeof localServiceStopReason> | null = null;
      first ??= localServiceStopReason(reason, 1000, 999);
      first ??= localServiceStopReason('lease_lost', 1000, 1001);
      expect(first).toBe(reason);
    },
  );
  it('rejects a changed approved image before any daemon or file access', async () => {
    const runner = new LocalCommandRunner({
      socketPath: '/synthetic/docker.sock',
      imageDigest: localCommandToolchainImageV1,
    });
    const preflight = vi.spyOn(runner, 'preflight');
    const input = command();
    input.arguments.imageDigest = 'sha256:' + 'b'.repeat(64);
    await expect(
      new LocalServiceRunner(runner).execute('/synthetic', input, {
        processId: fixtureId(6),
        attemptId: fixtureId(7),
        hardDeadlineAt: new Date(Date.now() + 10000).toISOString(),
        maintainLease: async () => ({
          leaseExpiresAt: new Date(Date.now() + 1000).toISOString(),
          stopRequested: false,
          inputs: [],
        }),
        onEvent: async () => {},
        prepareInput: async () => 'new',
      }),
    ).rejects.toMatchObject({ code: 'TOOLCHAIN_CHANGED' });
    expect(preflight).not.toHaveBeenCalled();
  });
  it('cannot accidentally execute a background payload through the foreground path', async () => {
    const runner = new LocalCommandRunner({
      socketPath: '/synthetic/docker.sock',
      imageDigest: localCommandToolchainImageV1,
    });
    await expect(
      runner.execute('/synthetic', command(), { attemptId: fixtureId(7) }),
    ).rejects.toMatchObject({ code: 'SERVICE_MANAGER_REQUIRED' });
  });
  it('requires finite duration and rejects unsupported readiness host fields', () => {
    const a = command();
    a.arguments.background!.durationMs = 300001;
    expect(RuntimeLocalCommandSchema.safeParse(a).success).toBe(false);
    const b = command();
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...b,
        arguments: {
          ...b.arguments,
          background: {
            ...b.arguments.background,
            readiness: {
              ...b.arguments.background!.readiness,
              host: 'example.com',
            },
          },
        },
      }).success,
    ).toBe(false);
  });
  it('EOF never carries text and the bounded input size is measured as UTF-8', () => {
    const value = {
      inputId: fixtureId(1),
      requestId: fixtureId(2),
      sequence: 0,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      digest: 'sha256:' + 'a'.repeat(64),
      kind: 'eof',
      text: 'unexpected',
    };
    expect(RuntimeLocalServiceInputSchema.safeParse(value).success).toBe(false);
    expect(
      RuntimeLocalServiceInputSchema.safeParse({
        ...value,
        kind: 'text',
        text: '测试'.repeat(1000),
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalServiceInputSchema.safeParse({ ...value, text: '' }).success,
    ).toBe(true);
  });
});
