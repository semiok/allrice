import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  EmployeeKernelRequestSchema,
  InternalKernelRequestSchema,
} from '@allrice/contracts';
import {
  source,
  scope,
} from '../../../../packages/database/src/conversation/platform-test-binding.fixture.ts';
import {
  newCurrentPlatformTestOrigin,
  freezePlatformTestExecutionBinding,
  type PlatformTestPurpose,
} from '../../../../packages/database/src/conversation/current-platform-test-binding.ts';
import { newNativeGeneration } from '../../../../packages/database/src/conversation/current-execution-binding.ts';
import { LeasedPlatformTestExecutionBindingSchema } from '../../../../packages/database/src/conversation/native-run-execution-binding.ts';
import { currentExecutionForNativeInput } from '../../src/harness/dsh/current-execution-source.ts';

beforeEach(() => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
function fixture(
  purpose: PlatformTestPurpose = 'platform_preview',
  generation: typeof newNativeGeneration = newNativeGeneration,
) {
  const own = scope(),
    s = source(generation, 'bundled', purpose);
  const origin = newCurrentPlatformTestOrigin({ scope: own, source: s });
  const binding = LeasedPlatformTestExecutionBindingSchema.parse({
    kind: 'current_platform_test_run_execution',
    test: freezePlatformTestExecutionBinding({ origin, scope: own, source: s }),
    runId: randomUUID(),
    jobId: randomUUID(),
    attempt: 2,
  });
  const common = {
    schemaVersion: 1,
    harness: 'dsh',
    employeeAssignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    systemInstructions: 'Authorized fixture only',
    userRequest: 'Use the supplied input',
    bootstrapConversation: '',
    authorizedMemoryContext: '',
    grantedCapabilities: [],
    skillVersionIds: [],
    runtimePackageChecksum: s.packageChecksum,
    runtimeDistributionGeneration: generation,
  };
  const kernel =
    purpose === 'experience_validation'
      ? InternalKernelRequestSchema.parse({
          ...common,
          sessionId: null,
          userMessageId: null,
          assistantMessageId: null,
          nativeContextId: own.testId,
          internalTask: {
            kind: 'experience_validation',
            occurrenceId: randomUUID(),
          },
        })
      : EmployeeKernelRequestSchema.parse({
          ...common,
          sessionId: own.testId,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
        });
  const input = {
    kernel,
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: own.organizationId,
      ALLRICE_WORKSPACE_ID: own.workspaceId,
      ALLRICE_OWNER_ID: own.ownerId,
      ALLRICE_RUN_ID: binding.runId,
      ALLRICE_JOB_ID: binding.jobId,
      ALLRICE_ATTEMPT: '2',
    },
  };
  return { input, origin, binding };
}
it.each([
  'platform_preview',
  'method_candidate',
  'experience_validation',
] as const)(
  '%s selects the approved executor while retaining its original current package and synthetic version',
  (purpose) => {
    const f = fixture(purpose),
      original = JSON.stringify(f.input);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
    expect(
      currentExecutionForNativeInput(f.input, f.origin, f.binding),
    ).toEqual(f.binding.test);
    expect(JSON.stringify(f.input)).toBe(original);
  },
);
it('accepts the current declared package without changing original source facts', () => {
  const f = fixture('method_candidate', newNativeGeneration);
  expect(currentExecutionForNativeInput(f.input, f.origin, f.binding)).toEqual(
    f.binding.test,
  );
});
it.each([
  'ALLRICE_ORGANIZATION_ID',
  'ALLRICE_WORKSPACE_ID',
  'ALLRICE_OWNER_ID',
  'ALLRICE_RUN_ID',
  'ALLRICE_JOB_ID',
  'ALLRICE_ATTEMPT',
] as const)('rejects a different actual Worker %s', (key) => {
  const f = fixture();
  f.input.executionEnvironment[key] =
    key === 'ALLRICE_ATTEMPT' ? '3' : randomUUID();
  expect(() =>
    currentExecutionForNativeInput(f.input, f.origin, f.binding),
  ).toThrow('BINDING_MISMATCH');
});
it.each(['runtimePackageChecksum', 'runtimeDistributionGeneration'] as const)(
  'rejects substituting the original kernel %s',
  (key) => {
    const f = fixture();
    if (key === 'runtimePackageChecksum')
      f.input.kernel.runtimePackageChecksum = 'sha256:' + 'b'.repeat(64);
    else f.input.kernel.runtimeDistributionGeneration = newNativeGeneration;
    expect(() =>
      currentExecutionForNativeInput(f.input, f.origin, f.binding),
    ).toThrow('BINDING_MISMATCH');
  },
);
it('rejects a different native context, even with the same source package', () => {
  const f = fixture('experience_validation');
  if (!('internalTask' in f.input.kernel)) throw Error('fixture');
  f.input.kernel.nativeContextId = randomUUID();
  expect(() =>
    currentExecutionForNativeInput(f.input, f.origin, f.binding),
  ).toThrow('BINDING_MISMATCH');
});
it('rejects an ordinary preview kernel for an experience validation purpose', () => {
  const f = fixture('experience_validation'),
    ordinary = fixture();
  f.input.kernel = EmployeeKernelRequestSchema.parse({
    ...ordinary.input.kernel,
    sessionId: f.binding.test.scope.testId,
    runtimePackageChecksum: f.binding.test.source.packageChecksum,
  });
  expect(() =>
    currentExecutionForNativeInput(f.input, f.origin, f.binding),
  ).toThrow('BINDING_MISMATCH');
});
it('requires the SQL-issued binding for v2 and refuses to attach it to historical roots', () => {
  const f = fixture();
  expect(() => currentExecutionForNativeInput(f.input, f.origin, null)).toThrow(
    'BINDING_REQUIRED',
  );
  expect(() =>
    currentExecutionForNativeInput(f.input, null, f.binding),
  ).toThrow('BINDING_REQUIRED');
  expect(currentExecutionForNativeInput(f.input, null, null)).toBeNull();
});
it('rejects leaking a lease token through the private prepare result shape', () => {
  const f = fixture();
  expect(() =>
    LeasedPlatformTestExecutionBindingSchema.parse({
      ...f.binding,
      leaseToken: randomUUID(),
    }),
  ).toThrow();
});
