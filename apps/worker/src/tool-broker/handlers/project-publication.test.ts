import { randomUUID, createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@allrice/database';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, {
  defineTool,
  type ToolExecutionInput,
} from '@deepseek-ai/dsh-tools';
import type { RiceToolExecutionInput } from '../types.js';
import { HandlerError, isConfirmedToolFailure } from '../../errors.js';
import { dshInboundToolHandler } from '../../harness/dsh/tool-bridge.js';

// Real handler/guard/native executor; every DB, storage, and cloud execution
// port is inert. No server, model, project process, or actual file is opened.
const ports = vi.hoisted(() => ({
  select: vi.fn(),
  create: vi.fn(),
  execute: vi.fn(),
  start: vi.fn(),
  budget: vi.fn(),
  local: vi.fn(),
  waitLocal: vi.fn(),
  legacy: vi.fn(),
  publishLocal: vi.fn(),
  service: vi.fn(),
  preflight: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@allrice/database', async (importOriginal) => {
  // Share public error identities without exposing live DB/execution functions.
  const {
    ProjectWorkspaceError,
    RuntimePolicyError,
    ProjectLockPlatformError,
  } = await importOriginal<typeof DatabaseModule>();
  const canonical = (v: unknown): string =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? '{' +
        Object.keys(v)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ':' +
              canonical((v as Record<string, unknown>)[k]),
          )
          .join(',') +
        '}'
      : Array.isArray(v)
        ? '[' + v.map(canonical).join(',') + ']'
        : JSON.stringify(v);
  return {
    ProjectWorkspaceError,
    RuntimePolicyError,
    ProjectLockPlatformError,
    selectProjectExecution: ports.select,
    createCloudProjectOperation: ports.create,
    readProjectWorkflowBudget: ports.budget,
    cloudExecutionEnabled: () => true,
    executeProjectWorkspace: ports.legacy,
    publishLocalProjectArtifacts: ports.publishLocal,
    createLocalCommandOperation: ports.local,
    waitLocalCommandOperation: ports.waitLocal,
    projectServiceWorkerControl: ports.service,
    readProjectService: ports.service,
    executionResourceObserver: () => ({ observe: vi.fn() }),
    cloudStableId: (s: string) => 'synthetic-' + s,
    runtimePolicyDigest: (v: unknown) =>
      'sha256:' + createHash('sha256').update(canonical(v)).digest('hex'),
  };
});
vi.mock('@allrice/storage', () => ({ LocalStorageAdapter: class {} }));
vi.mock('../../cloud-runner/backend.js', () => ({
  CloudRunnerBackend: class {
    preflight = ports.preflight;
  },
}));
vi.mock('../../cloud-runner/executor.js', () => ({
  runCloudCommandOperation: ports.execute,
  startCloudProjectService: ports.start,
  CloudProjectServiceStartError: class extends Error {},
}));
vi.mock('./project-resolution.js', () => ({
  runProjectResolution: ports.resolve,
}));
import { runProjectWorkspace } from './project.js';

function fixture() {
  const runId = randomUUID(),
    operationId = randomUUID(),
    callId = 'finite-project-call';
  const input = {
    sessionId: randomUUID(),
    managedBrowserJobAttempt: 1,
    managedBrowserJobLeaseToken: 'synthetic-owned-lease',
    context: { runId },
    call: { id: callId, name: 'workspace.project', arguments: {} },
    storageRoot: '/unused-synthetic-project-publication-test',
  } as RiceToolExecutionInput;
  const command = {
    action: 'execute',
    project: {
      projectId: operationId,
      snapshot: {
        kind: 'artifact',
        id: randomUUID(),
        checksum: 'sha256:' + 'a'.repeat(64),
      },
    },
    executable: '/usr/local/bin/node',
    args: ['main.cjs'],
    path: '.',
    limits: {
      timeoutMs: 60000,
      outputBytes: 8000,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
    projectPreparation: {
      version: 1,
      projectId: operationId,
      sourceDigest: 'sha256:' + 'b'.repeat(64),
      lockChecksum: 'sha256:' + 'c'.repeat(64),
      offline: true,
      manager: 'pnpm',
      managerVersion: '10.33.3',
      lockPath: 'pnpm-lock.yaml',
      scripts: 'disabled',
      packages: [],
    },
  };
  const created = {
    context: input.context,
    callId,
    snapshot: { binding: { attempt: { operationId } } },
  };
  const result = {
    operationId,
    status: 'failed',
    reason: 'failed',
    stopped: true,
    cleanupConfirmed: true,
    exitCode: 0,
    output: 'already computed; unchanged bytes',
    artifacts: [],
    errorCode: 'project_output_parent_stale',
  };
  ports.select.mockResolvedValue({
    choice: { location: 'cloud', status: 'execute', reason: 'cloud_ready' },
  });
  ports.create.mockResolvedValue(created);
  ports.execute.mockResolvedValue(result);
  const identity = { runId, callId, toolName: 'workspace.project' };
  return { input, command, created, result, identity };
}
function noFallback() {
  for (const port of [
    ports.local,
    ports.waitLocal,
    ports.legacy,
    ports.publishLocal,
    ports.service,
    ports.start,
    ports.preflight,
    ports.resolve,
  ])
    expect(port).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  const forbidden = () => {
    throw Error('Unexpected live/fallback execution');
  };
  for (const port of [
    ports.local,
    ports.waitLocal,
    ports.legacy,
    ports.publishLocal,
    ports.service,
    ports.start,
    ports.preflight,
    ports.resolve,
  ])
    port.mockImplementation(forbidden);
  ports.budget.mockResolvedValue({
    used: { executions: 1 },
    remaining: { executions: 7 },
  });
});

// Real DSH's same-process tool execution path: no agent or model loop exists.
async function nativeAttempt(
  f: ReturnType<typeof fixture>,
  onToolCall?: (
    call: RiceToolExecutionInput['call'],
  ) => Promise<{ modelContent: string; summary: string }>,
) {
  let brokerError: unknown;
  const invoke =
    onToolCall ??
    (async (call) =>
      runProjectWorkspace({
        input: { ...f.input, call },
        arguments: call.arguments,
      }));
  const inbound = dshInboundToolHandler({
    tools: [
      { name: 'workspace.project', description: 'synthetic', inputSchema: {} },
    ],
    onToolCall: async (call) => {
      try {
        return await invoke(call);
      } catch (error) {
        brokerError = error;
        throw error;
      }
    },
  });
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    ctx.tools.register(
      defineTool({
        name: 'workspace_project',
        description: 'Synthetic finite project result, no compute.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (_args, exec) => {
          const response = await inbound('allrice/tool-call', {
            toolCallId: exec.callId,
            name: 'workspace.project',
            arguments: f.command,
          });
          return response.modelContent;
        },
      }),
    );
    const result = await ctx.tools.execute({
      name: 'workspace_project',
      callId: f.input.call.id as ToolExecutionInput['callId'],
      arguments: {},
      signal: new AbortController().signal,
    });
    return { result, error: brokerError };
  } finally {
    await ctx.fiber.dispose();
  }
}

describe('finite project cloud publication result reaches the broker honestly', () => {
  it('returns the existing successful project JSON through real native isError=false', async () => {
    const f = fixture();
    ports.execute.mockResolvedValue({
      ...f.result,
      status: 'succeeded',
      reason: 'completed',
      errorCode: undefined,
      artifacts: [{ objectId: 'synthetic-delivered-object' }],
    });
    const n = await nativeAttempt(f);
    expect(n.error).toBeUndefined();
    expect(n.result.isError).toBe(false);
    expect(
      JSON.parse(
        n.result.content[0]!.type === 'text' ? n.result.content[0]!.text : '',
      ),
    ).toMatchObject({
      status: 'succeeded',
      executionLocation: 'cloud',
      sourceDirectoryModified: false,
      artifacts: [{ objectId: 'synthetic-delivered-object' }],
    });
    expect(ports.execute).toHaveBeenCalledOnce();
    expect(ports.create).toHaveBeenCalledOnce();
    noFallback();
  });
  it('throws the exact confirmed stale-parent failure, renders native isError=true, and never falls back', async () => {
    const f = fixture(),
      n = await nativeAttempt(f);
    expect(n.error).toBeInstanceOf(HandlerError);
    expect(n.error).toMatchObject({
      code: 'project_output_parent_stale',
      retryable: false,
    });
    expect(isConfirmedToolFailure(n.error, f.identity)).toBe(true);
    for (const replacement of [
      { runId: randomUUID() },
      { callId: 'other-call' },
      { toolName: 'python.execute' },
    ])
      expect(
        isConfirmedToolFailure(n.error, { ...f.identity, ...replacement }),
      ).toBe(false);
    expect(
      isConfirmedToolFailure(
        { code: 'project_output_parent_stale' },
        f.identity,
      ),
    ).toBe(false);
    expect(n.result.isError).toBe(true);
    expect(n.result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('project_output_parent_stale'),
      },
    ]);
    expect(n.result.content).toEqual([
      { type: 'text', text: expect.stringContaining('不要自动重执行') },
    ]);
    expect(ports.execute).toHaveBeenCalledExactlyOnceWith(
      f.created,
      expect.objectContaining({}),
    );
    expect(ports.budget).not.toHaveBeenCalled();
    noFallback();
  });
});
