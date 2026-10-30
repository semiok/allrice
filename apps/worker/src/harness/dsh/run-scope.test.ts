import { expect, it } from 'vitest';
import type {
  DshNotification,
  DshProtocolClient,
} from '../dsh-protocol-client.js';
import { assertNativeControlScope, nativeRunScope } from './run-scope.js';
import type { NativeSubagentControlScope } from '@allrice/contracts';
import type { DshRuntime } from './runtime-pool.js';

it('child controls stay on the exact active Run/Job, generation and storage source', () => {
  const scope: NativeSubagentControlScope = {
    rootRunId: 'run',
    nativeRootId: 'root',
    generation: 3,
    jobId: 'job',
    jobAttempt: 2,
    rootOriginDigest: 'digest',
    storageNamespace: '/source',
  };
  const runtime = {
    sessionId: 'root',
    nativeGeneration: 3,
    productSessionId: 'business-session',
    organizationId: 'org',
    workspaceId: 'workspace',
    ownerId: 'owner',
    executionObservation: {
      runId: 'run',
      jobId: 'job',
      attempt: 2,
      generation: 3,
    },
    nativePin: {
      nativeSessionId: 'root',
      contextKind: 'chat',
      bindingBasis: 'business_root_origin',
      contextId: 'business-session',
      organizationId: 'org',
      workspaceId: 'workspace',
      ownerId: 'owner',
      rootOriginDigest: 'digest',
      storageNamespace: '/source',
    },
  } as DshRuntime;
  expect(assertNativeControlScope(runtime, scope)).toBe(runtime);
  for (const mismatch of [
    { productSessionId: 'foreign' },
    { organizationId: 'foreign' },
    { workspaceId: 'foreign' },
    { ownerId: 'foreign' },
  ])
    expect(() =>
      assertNativeControlScope({ ...runtime, ...mismatch }, scope),
    ).toThrow();
  expect(() => assertNativeControlScope(undefined, scope)).toThrow();
  expect(() =>
    assertNativeControlScope(
      { ...runtime, executionObservation: undefined },
      scope,
    ),
  ).toThrow();
  for (const mismatch of [
    { rootRunId: 'later-run' },
    { nativeRootId: 'foreign-root' },
    { jobId: 'other-job' },
    { jobAttempt: 3 },
    { generation: 4 },
    { rootOriginDigest: 'other-origin' },
    { storageNamespace: '/other-tenant' },
  ])
    expect(() =>
      assertNativeControlScope(runtime, { ...scope, ...mismatch }),
    ).toThrow('NATIVE_CONTROL_SCOPE_MISMATCH');
});

it('only accepts ordered root/child start attribution from this owned Run', () => {
  let notice!: (value: DshNotification) => void;
  const scope = nativeRunScope(
    {
      subscribe: (listener: typeof notice) => {
        notice = listener;
        return () => {};
      },
    } as DshProtocolClient,
    'root',
    'run',
  );
  const root = {
    runId: 'run',
    rootSessionId: 'root',
    nativeSessionId: 'root',
    parentSessionId: null,
    delegationDepth: 0,
  };
  const child = {
    ...root,
    nativeSessionId: 'child',
    parentSessionId: 'root',
    delegationDepth: 1,
  };
  expect(() => scope.check(child)).toThrow('原生调用不属于当前运行');
  const start = (params: Record<string, unknown>) =>
    notice({ method: 'allrice.run-session', params });
  start(child);
  expect(() => scope.check(child)).toThrow();
  start(root);
  start(child);
  expect(scope.check({ ...child, action: 'check' })).toEqual({
    nativeSessionId: 'child',
    action: 'check',
  });
  for (const forged of [
    { runId: 'other' },
    { rootSessionId: 'other-tenant' },
    { parentSessionId: 'foreign' },
    { delegationDepth: 0 },
  ])
    expect(() => scope.check({ ...child, ...forged })).toThrow();
  start({ ...child, nativeSessionId: 'forged', parentSessionId: 'missing' });
  expect(() => scope.check({ ...child, nativeSessionId: 'forged' })).toThrow();
});
