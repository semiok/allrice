import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  employeeManifest,
  employeeManifestChecksum,
  newCurrentEmployeeChatOrigin,
  validateEmployeeExecutionSource,
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
} from '@allrice/database';
import { DshRuntimePool } from './runtime-pool.js';
import { currentExecutionForNativeInput } from './current-execution-source.js';
import type { HarnessExecutionInput } from '../adapter.js';
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const a = `sha256:${'a'.repeat(64)}`,
    b = `sha256:${'b'.repeat(64)}`;
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', a);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', a);
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID(),
    sessionId = randomUUID(),
    runId = randomUUID();
  const manifest = employeeManifest({
    key: 'u1-synthetic-worker',
    name: 'Synthetic',
    description: 'No real runtime',
    toolNames: [],
  });
  const sourceInput = {
    employeeVersionId: randomUUID(),
    manifest,
    configChecksum: employeeManifestChecksum(manifest),
  };
  const origin = newCurrentEmployeeChatOrigin({
    organizationId,
    workspaceId,
    ownerId,
    sessionId,
    source: sourceInput,
  });
  const { source, sourcePolicy } = validateEmployeeExecutionSource(sourceInput);
  const transition = {
    requestId: randomUUID(),
    sequence: 1,
    digest: `sha256:${'c'.repeat(64)}`,
    scope: {
      contextKind: 'chat',
      contextId: sessionId,
      organizationId,
      workspaceId,
      ownerId,
    },
    originDigest: nativeRootDigest(origin),
    target: {
      artifactId: b,
      generation: origin.distributionGeneration,
      profileId: 'restricted',
    },
    storageNamespace: `/synthetic/${organizationId}/${workspaceId}/${ownerId}/${sessionId}/sessions`,
  };
  const payload = {
    schemaVersion: 2,
    kind: 'current_employee_execution',
    scope: { organizationId, workspaceId, ownerId, sessionId, runId },
    originDigest: nativeRootDigest(origin),
    source,
    sourcePolicy,
    execution: transition.target,
    executionSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    transition,
  };
  const binding = EmployeeRunExecutionBindingSchema.parse({
    ...payload,
    digest: nativeRootDigest(payload),
  });
  const input = {
    kernel: { sessionId, employeeVersionId: source.employeeVersionId },
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: organizationId,
      ALLRICE_WORKSPACE_ID: workspaceId,
      ALLRICE_OWNER_ID: ownerId,
      ALLRICE_RUN_ID: runId,
    },
  } as unknown as HarnessExecutionInput;
  return { input, origin, binding, a, b };
}
it('a valid private-ref shape plus matching deployment env is NOT actual native artifact approval', () => {
  const f = fixture();
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', f.b);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', f.b);
  expect(
    currentExecutionForNativeInput(f.input, f.origin, f.binding)?.execution
      .artifactId,
  ).toBe(f.b);
  const pool = new DshRuntimePool({
    runtimeCommand: process.execPath,
    runtimeArgs: ['/synthetic-not-approved/runtime.mjs'],
    cordisConfig: '/synthetic-not-approved/profile.yml',
  });
  expect(() =>
    pool.describeNativeSession(
      f.input,
      `dsh-${f.input.kernel.sessionId}`,
      undefined,
      f.origin,
      f.binding,
    ),
  ).toThrow(/ARTIFACT/);
  expect(pool.get(`dsh-${f.input.kernel.sessionId}`)).toBeUndefined();
});
it('forged run or owner mapping is denied before artifact selection', () => {
  const f = fixture();
  expect(() =>
    currentExecutionForNativeInput(
      {
        ...f.input,
        executionEnvironment: {
          ...f.input.executionEnvironment,
          ALLRICE_RUN_ID: randomUUID(),
        },
      },
      f.origin,
      f.binding,
    ),
  ).toThrow('MISMATCH');
  expect(() =>
    currentExecutionForNativeInput(
      {
        ...f.input,
        executionEnvironment: {
          ...f.input.executionEnvironment,
          ALLRICE_OWNER_ID: randomUUID(),
        },
      },
      f.origin,
      f.binding,
    ),
  ).toThrow('MISMATCH');
});
