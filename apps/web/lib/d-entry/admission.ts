import { createHash } from 'node:crypto';
import {
  DEntryAdmissionSchema,
  DEntryMountSchema,
  DEntryRolloutPolicySchema,
  selectDEntryGeneration,
  type DEntryIdentity,
  type DEntryRolloutPolicy,
  type ExecutionGeneration,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  getSessionExecutionGeneration,
} from '@allrice/database';
import { resolveDEntryIdentity } from './identity';

/** Select the current entrance without ever repinning an existing thread.
 * A disabled 4.0 thread remains cold-readable but cannot continue through 3.x. */
export async function resolveDEntryAdmission(
  context: RequestContext,
  input: unknown,
  policyInput: DEntryRolloutPolicy,
) {
  const identity = await resolveDEntryIdentity(context, input, 'execute');
  const policy = DEntryRolloutPolicySchema.parse(policyInput);
  const selected = selectDEntryGeneration(policy, identity);
  const executionGeneration = identity.threadId
    ? await getSessionExecutionGeneration(
        context,
        identity.workspaceId,
        identity.threadId,
      )
    : selected;
  if (executionGeneration === '4.0' && selected !== '4.0')
    throw new DataAccessError('authorization_denied');
  return DEntryAdmissionSchema.parse({
    identity,
    executionGeneration,
    policyRevision: policy.revision,
  });
}

/** runtimeBindingRef comes from the current host route/profile/lease, never
 * from browser JSON. Thread navigation on the same Host does not remount it. */
export function dEntryClientMount(
  identity: DEntryIdentity,
  executionGeneration: ExecutionGeneration,
  runtimeBindingRef: string,
) {
  const remountKey = createHash('sha256')
    .update(
      JSON.stringify([
        identity.organizationId,
        identity.personId,
        identity.employeeInstanceId,
        identity.employeeRevision,
        identity.employeeVersionId,
        executionGeneration,
        runtimeBindingRef,
      ]),
    )
    .digest('hex');
  return DEntryMountSchema.parse({
    identity,
    executionGeneration,
    bindingRef: runtimeBindingRef,
    remountKey,
  });
}
