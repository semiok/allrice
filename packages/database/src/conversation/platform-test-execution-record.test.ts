import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DSH_MISSING_FROZEN_GENERATION } from '@allrice/contracts';
import { source, scope } from './platform-test-binding.fixture.ts';
import {
  freezePlatformTestExecutionBinding,
  newCurrentPlatformTestOrigin,
  type PlatformTestPurpose,
} from './current-platform-test-binding.ts';
import {
  readCurrentPlatformTestExecutionRecord,
  type PlatformTestExecutionRecord,
} from './platform-test-execution-record.ts';

const current = 'sha256:' + 'a'.repeat(64);
beforeEach(() => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
});
afterEach(() => vi.unstubAllEnvs());
function row(purpose: PlatformTestPurpose = 'platform_preview') {
  const s = source(DSH_MISSING_FROZEN_GENERATION, 'bundled', purpose),
    own = scope();
  const origin = newCurrentPlatformTestOrigin({ source: s, scope: own });
  const binding = freezePlatformTestExecutionBinding({
    origin,
    source: s,
    scope: own,
  });
  const record: PlatformTestExecutionRecord = {
    id: own.testId,
    employee_id: s.platformEmployeeId,
    revision_id: s.platformRevisionId,
    purpose,
    frozen_definition: s.definition,
    frozen_runtime_profile: s.runtimeProfile,
    frozen_native_skills: s.nativeSkills,
    frozen_package_checksum: s.packageChecksum,
    native_root_origin: origin,
    native_execution_binding: binding,
  };
  const expectedScope = {
    organizationId: own.organizationId,
    workspaceId: own.workspaceId,
    ownerId: own.ownerId,
  };
  return { record, expectedScope, origin, binding };
}
it.each([
  'platform_preview',
  'method_candidate',
  'experience_validation',
] as const)(
  '%s original queued source is independent of a later recompiled revision or deployment',
  (purpose) => {
    const f = row(purpose),
      original = JSON.stringify(f.record);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
    // A latest-revision checksum is deliberately not an argument to this reader.
    expect(
      readCurrentPlatformTestExecutionRecord(f.record, f.expectedScope),
    ).toEqual({ origin: f.origin, executionBinding: f.binding });
    expect(JSON.stringify(f.record)).toBe(original);
  },
);
it.each(['organizationId', 'workspaceId', 'ownerId'] as const)(
  'rejects a different authorized %s scope',
  (key) => {
    const f = row();
    expect(() =>
      readCurrentPlatformTestExecutionRecord(f.record, {
        ...f.expectedScope,
        [key]: randomUUID(),
      }),
    ).toThrow();
  },
);
it.each(['id', 'employee_id', 'revision_id'] as const)(
  'rejects replacing original test row identity %s',
  (key) => {
    const f = row();
    expect(() =>
      readCurrentPlatformTestExecutionRecord(
        { ...f.record, [key]: randomUUID() },
        f.expectedScope,
      ),
    ).toThrow();
  },
);
it('rejects purpose substitution, absent binding, and a binding from another test', () => {
  const f = row();
  for (const changed of [
    { ...f.record, purpose: 'experience_validation' as const },
    { ...f.record, native_execution_binding: null },
    { ...f.record, native_execution_binding: row().binding },
  ])
    expect(() =>
      readCurrentPlatformTestExecutionRecord(changed, f.expectedScope),
    ).toThrow();
});
it.each([
  'frozen_definition',
  'frozen_runtime_profile',
  'frozen_native_skills',
  'frozen_package_checksum',
] as const)('rejects corrupt frozen source %s', (key) => {
  const f = row();
  expect(() =>
    readCurrentPlatformTestExecutionRecord(
      { ...f.record, [key]: null },
      f.expectedScope,
    ),
  ).toThrow();
});
it('does not treat legacy NULL/v1 as permission to synthesize a current binding', () => {
  const f = row();
  for (const legacy of [null, { schemaVersion: 1 }]) {
    expect(() =>
      readCurrentPlatformTestExecutionRecord(
        { ...f.record, native_root_origin: legacy },
        f.expectedScope,
      ),
    ).toThrow();
  }
});
