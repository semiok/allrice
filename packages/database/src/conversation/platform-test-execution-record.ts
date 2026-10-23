import {
  assertCurrentPlatformTestOrigin,
  assertPlatformTestExecutionBinding,
  CurrentPlatformTestOriginSchema,
  type PlatformTestExecutionScope,
  type PlatformTestPurpose,
} from './current-platform-test-binding.ts';

/** Private frozen test row, never the latest mutable platform draft. */
export interface PlatformTestExecutionRecord {
  id: string;
  employee_id: string;
  revision_id: string;
  purpose: PlatformTestPurpose;
  frozen_definition: unknown;
  frozen_runtime_profile: unknown;
  frozen_native_skills: unknown;
  frozen_package_checksum: string | null;
  native_root_origin: unknown;
  native_execution_binding: unknown;
}

/** For V2 only: the first INSERT checked this definition checksum under the
 * original revision lock. Testing revisions may later be recompiled; reading
 * their current checksum here would reject a valid already-frozen queue item.
 * This check neither reads current deployment approval nor grants a lease. */
export function readCurrentPlatformTestExecutionRecord(
  row: PlatformTestExecutionRecord,
  expectedScope: Omit<PlatformTestExecutionScope, 'testId'>,
) {
  const stored = CurrentPlatformTestOriginSchema.parse(row.native_root_origin);
  const scope = { ...expectedScope, testId: row.id };
  const source = {
    platformEmployeeId: row.employee_id,
    platformRevisionId: row.revision_id,
    purpose: row.purpose,
    definitionChecksum: stored.birthSource.definitionChecksum,
    definition: row.frozen_definition,
    runtimeProfile: row.frozen_runtime_profile,
    nativeSkills: row.frozen_native_skills,
    packageChecksum: row.frozen_package_checksum,
  };
  const origin = assertCurrentPlatformTestOrigin(stored, { scope, source });
  const executionBinding = assertPlatformTestExecutionBinding(
    row.native_execution_binding,
    { origin, scope, source },
  );
  return { origin, executionBinding };
}
