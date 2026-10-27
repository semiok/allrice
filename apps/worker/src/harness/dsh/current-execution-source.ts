import { harnessContextKey } from '@allrice/contracts';
import {
  NativeRunExecutionBindingSchema,
  nativeRootDigest,
  type NativeRootOrigin,
  type NativeSessionPin,
  type NativeRunExecutionBinding,
} from '@allrice/database';
import type { HarnessExecutionInput } from '../adapter.js';

/** Match a trusted SQL result to this exact Worker call before selecting an
 * executor. Original source kernels stay unchanged; synthetic preview version
 * IDs must never be mistaken for immutable platform revision IDs. */
export function currentExecutionForNativeInput(
  input: Pick<HarnessExecutionInput, 'kernel' | 'executionEnvironment'>,
  origin: NativeRootOrigin | null | undefined,
  value: NativeRunExecutionBinding | null | undefined,
  pin?: NativeSessionPin,
) {
  if ((origin?.schemaVersion === 2) !== (value != null))
    throw Error('DSH_NATIVE_ARTIFACT_EXECUTION_BINDING_REQUIRED');
  if (value == null) return null;
  const leased = NativeRunExecutionBindingSchema.parse(value);
  const isTest = leased.kind === 'current_platform_test_run_execution';
  const current = isTest ? leased.test : leased;
  const env = input.executionEnvironment;
  const bad = () => {
    throw Error('DSH_NATIVE_ARTIFACT_EXECUTION_BINDING_MISMATCH');
  };
  if (
    !origin ||
    origin.schemaVersion !== 2 ||
    current.originDigest !== nativeRootDigest(origin) ||
    current.scope.organizationId !== env.ALLRICE_ORGANIZATION_ID ||
    current.scope.workspaceId !== env.ALLRICE_WORKSPACE_ID ||
    current.scope.ownerId !== env.ALLRICE_OWNER_ID ||
    current.execution.artifactId !== origin.artifactId ||
    current.execution.generation !== origin.distributionGeneration ||
    current.execution.profileId !== origin.profileId ||
    (current.source.packageChecksum ?? undefined) !==
      input.kernel.runtimePackageChecksum ||
    (current.source.declaredGeneration ?? undefined) !==
      input.kernel.runtimeDistributionGeneration ||
    (pin &&
      (pin.bindingBasis !== 'business_root_origin' ||
        pin.rootOriginDigest !== current.originDigest))
  )
    return bad();
  if (isTest) {
    if (
      origin.contextKind !== 'platform_employee_test' ||
      leased.test.scope.testId !== origin.contextId ||
      leased.test.scope.testId !== harnessContextKey(input.kernel) ||
      leased.runId !== env.ALLRICE_RUN_ID ||
      leased.jobId !== env.ALLRICE_JOB_ID ||
      String(leased.attempt) !== env.ALLRICE_ATTEMPT
    )
      return bad();
    if ('internalTask' in input.kernel) {
      if (
        leased.test.source.purpose !== 'experience_validation' ||
        input.kernel.internalTask.kind !== 'experience_validation' ||
        input.kernel.nativeContextId !== leased.test.scope.testId
      )
        return bad();
    } else if (
      leased.test.source.purpose === 'experience_validation' ||
      input.kernel.sessionId !== leased.test.scope.testId
    )
      return bad();
  } else if (
    origin.contextKind !== 'chat' ||
    leased.scope.runId !== env.ALLRICE_RUN_ID ||
    leased.scope.sessionId !== input.kernel.sessionId ||
    leased.source.employeeVersionId !== input.kernel.employeeVersionId
  )
    return bad();
  return current;
}
