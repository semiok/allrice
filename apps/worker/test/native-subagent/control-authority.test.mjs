/* global AbortController, process */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { gate, hold, host, text } from './fixture.mjs';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  spawn: mocks.spawn,
}));
afterEach(() => vi.restoreAllMocks());

function execution(rootId) {
  return {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Complete the request.',
      userRequest: '执行当前任务',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke'],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      credentialReference: 'test:local-synthetic',
      baseUrl: null,
    },
    storageObjects: [],
    workDirectory: process.cwd(),
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: randomUUID(),
      ALLRICE_WORKSPACE_ID: randomUUID(),
      ALLRICE_OWNER_ID: randomUUID(),
      ALLRICE_RUN_ID: randomUUID(),
      ALLRICE_JOB_ID: randomUUID(),
      ALLRICE_ATTEMPT: '1',
    },
    signal: new AbortController().signal,
    attempt: 1,
    generation: 1,
    threadId: rootId,
    tools: [],
    onEvent: async () => {},
  };
}

it.each([
  ['tool', 'resolve', false],
  ['tool', 'reject', false],
  ['model-authority', 'resolve', false],
  ['model-authority', 'reject', false],
  ['model-preflight', 'resolve', false],
  ['model-preflight', 'reject', false],
  ['tool', 'resolve', true],
])(
  'single Stop abandons A %s/%s; same Host B is fenced (current revoke=%s)',
  async (phase, outcome, revokeCurrent) => {
    // Only process placement is injected. Both public RPC peers, the Host,
    // native child loop and the two adapter.execute() lifetimes are real.
    const rootId = 'dsh-controls-root',
      a = execution(rootId);
    const aEntered = gate(),
      aRelease = gate(),
      bEntered = gate(),
      bRelease = gate();
    const authorizing = gate(),
      releaseAuthority = gate(),
      lateReturn = gate();
    let activeRun = 'A',
      held = false,
      holdAuthority = false,
      holdPreflight = false;
    const grant = () => ({ validUntil: Date.now() + 60_000 });
    const suspended = async () => {
      authorizing.resolve();
      await releaseAuthority.promise;
      if (outcome === 'reject') throw Error('old A authority revoked');
      return grant();
    };
    a.nativeRunAuthority = () => async () => {
      if (holdAuthority) {
        holdAuthority = false;
        return suspended();
      }
      return grant();
    };
    a.modelPreflight = vi.fn(async () => {
      if (holdPreflight) {
        holdPreflight = false;
        await suspended();
      }
    });
    const childProcess = Object.assign(new EventEmitter(), {
      pid: 31337,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const exit = () => {
      childProcess.emit('exit', 0, null);
      childProcess.emit('close', 0, null);
    };
    childProcess.kill = vi.fn(exit);
    mocks.spawn.mockReturnValue(childProcess);
    const client = new DshProtocolClient({
      command: 'in-process-test',
      args: [],
      cwd: process.cwd(),
      environment: {},
      requestTimeoutMs: 5_000,
    });
    const peer = new JsonRpcLineTransport(
      childProcess.stdin,
      childProcess.stdout,
    );
    const setHandler = client.setRequestHandler.bind(client);
    vi.spyOn(client, 'setRequestHandler').mockImplementation((handler) =>
      setHandler(
        handler &&
          (async (method, params) => {
            const target =
              !held &&
              method === 'allrice/run-authorize' &&
              params.runId === a.executionEnvironment.ALLRICE_RUN_ID &&
              params.nativeSessionId !== rootId &&
              params.kind === (phase === 'tool' ? 'tool' : 'model');
            if (target) {
              held = true;
              if (phase === 'model-preflight') holdPreflight = true;
              else holdAuthority = true;
            }
            try {
              const value = await handler(method, params);
              if (target) lateReturn.resolve({ ok: true, value });
              return value;
            } catch (error) {
              if (target) lateReturn.resolve({ ok: false, error });
              throw error;
            }
          }),
      ),
    );
    peer.start();
    const h = await host({
      rootId,
      runId: a.executionEnvironment.ALLRICE_RUN_ID,
      bridge: (method, params, signal) => peer.request(method, params, signal),
      onNotification: ({ method, params }) => peer.notify(method, params),
      model: async (r) => {
        if (r.sessionId !== rootId)
          return [
            {
              type: 'tool-call',
              id: 'child-list',
              name: 'list_agents',
              arguments: '{}',
            },
          ];
        if (activeRun === 'A') {
          aEntered.resolve();
          await hold(r.signal, aRelease);
          return text('A完成');
        }
        bEntered.resolve();
        await hold(r.signal, bRelease);
        return revokeCurrent
          ? [
              {
                type: 'tool-call',
                id: 'current-root-list',
                name: 'list_agents',
                arguments: '{}',
              },
            ]
          : text('B完成');
      },
    });
    peer.onRequest(async (method, params) => {
      const value = await h.server.handleRequest(method, params);
      if (method === 'shutdown') setImmediate(exit);
      return value;
    });
    await h.server.handleRequest('run/end', {
      sessionId: rootId,
      runId: a.executionEnvironment.ALLRICE_RUN_ID,
    });
    const environment = a.executionEnvironment;
    const runtime = {
      id: randomUUID(),
      sessionId: rootId,
      client,
      nativeTools: [],
      organizationId: environment.ALLRICE_ORGANIZATION_ID,
      workspaceId: environment.ALLRICE_WORKSPACE_ID,
      ownerId: environment.ALLRICE_OWNER_ID,
      productSessionId: a.kernel.sessionId,
      nativePin: {
        nativeSessionId: rootId,
        contextKind: 'chat',
        contextId: a.kernel.sessionId,
        organizationId: environment.ALLRICE_ORGANIZATION_ID,
        workspaceId: environment.ALLRICE_WORKSPACE_ID,
        ownerId: environment.ALLRICE_OWNER_ID,
        bindingBasis: 'business_root_origin',
        rootOrigin: { source: { kind: 'chat', sessionId: a.kernel.sessionId } },
        rootOriginDigest: `sha256:${'a'.repeat(64)}`,
        storageNamespace: 'native-control-test',
      },
    };
    vi.spyOn(
      DshRuntimePool.prototype,
      'hasApprovedNativeLaunch',
    ).mockReturnValue(false);
    vi.spyOn(DshRuntimePool.prototype, 'describeNativeSession').mockReturnValue(
      null,
    );
    vi.spyOn(DshRuntimePool.prototype, 'get').mockReturnValue(runtime);
    const acquire = vi
      .spyOn(DshRuntimePool.prototype, 'acquire')
      .mockResolvedValue({
        runtime,
        fresh: false,
        preparation: {
          reuseStatus: 'reused',
          reuseDecisionMs: 0,
          canonicalRootMs: 0,
          credentialResolveMs: 0,
          runtimeInitializeMs: 0,
          setSystemPromptMs: 0,
          storageSyncMs: 0,
          rootOriginMs: 0,
        },
      });
    vi.spyOn(DshRuntimePool.prototype, 'touch').mockImplementation(() => {});
    const interrupt = vi.spyOn(client, 'interrupt');
    const adapter = new DshHarnessAdapter({
      runtimeCommand: 'in-process-test',
    });
    try {
      const first = adapter.execute(a).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error }),
      );
      await aEntered.promise;
      const child = await h.spawn();
      await authorizing.promise;
      const scope = {
        rootRunId: environment.ALLRICE_RUN_ID,
        nativeRootId: rootId,
        generation: a.generation,
        jobId: environment.ALLRICE_JOB_ID,
        jobAttempt: a.attempt,
        rootOriginDigest: runtime.nativePin.rootOriginDigest,
        storageNamespace: runtime.nativePin.storageNamespace,
      };
      expect(
        await adapter.nativeSubagentControl({
          scope,
          input: {
            requestId: randomUUID(),
            kind: 'interrupt',
            parentSessionId: rootId,
            childSessionId: child.childId,
            mode: 'continuable',
          },
        }),
      ).toEqual({ kind: 'interrupt', accepted: true });
      await child.result;
      aRelease.resolve();
      expect(await first).toMatchObject({ ok: true });
      expect(runtime.executionObservation).toBeUndefined();
      activeRun = 'B';
      const authorityB = vi.fn(async () => grant());
      const b = {
        ...a,
        generation: 2,
        nativeRunAuthority: () => authorityB,
        modelPreflight: vi.fn(),
        executionEnvironment: {
          ...environment,
          ALLRICE_RUN_ID: randomUUID(),
          ALLRICE_JOB_ID: randomUUID(),
        },
      };
      const second = adapter.execute(b).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error }),
      );
      await bEntered.promise;
      const preflights = a.modelPreflight.mock.calls.length;
      releaseAuthority.resolve();
      const late = await lateReturn.promise;
      expect(late.ok).toBe(false);
      expect(late.error.message).toBe('DSH_RUN_SESSION_DENIED');
      expect(a.modelPreflight).toHaveBeenCalledTimes(preflights);
      expect(interrupt).not.toHaveBeenCalled();
      expect(h.root.status).toBe('running');
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(runtime.executionObservation.runId).toBe(
        b.executionEnvironment.ALLRICE_RUN_ID,
      );
      if (revokeCurrent)
        authorityB.mockRejectedValue(Error('current B authority revoked'));
      bRelease.resolve();
      const completed = await second;
      expect(completed.ok).toBe(!revokeCurrent);
      if (revokeCurrent) {
        expect(interrupt).toHaveBeenCalledWith(rootId);
        expect(completed.error).toMatchObject({
          code: 'EMPLOYEE_CONTENT_CHECK_UNAVAILABLE',
          cause: { message: 'current B authority revoked' },
        });
      } else expect(interrupt).not.toHaveBeenCalled();
    } finally {
      aRelease.resolve();
      bRelease.resolve();
      releaseAuthority.resolve();
      // This in-process fixture owns the SDK, not the executable wrapper.
      // Keep its missing wrapper receipt unconfirmed; never invent a proof.
      await client.close().catch((error) => {
        expect(error.code).toBe('DSH_RUNTIME_CLOSE_UNCONFIRMED');
        expect(error.evidence).toMatchObject({
          shutdownAcknowledged: true,
          wrapperCleanupConfirmed: false,
          terminationAttempted: null,
          process: {
            state: 'exited',
            stdioClosed: true,
            exitCode: 0,
            signal: null,
          },
        });
      });
      await adapter.close().catch((error) => {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          errors: [{ errors: [{ code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED' }] }],
        });
      });
      peer.close();
    }
  },
  15_000,
);
