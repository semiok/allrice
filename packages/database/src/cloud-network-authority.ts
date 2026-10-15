import {
  runtimeFeatureEnabled,
  type CloudCommand,
  type CloudExecutionProfile,
  type EmployeeExecutionSnapshot,
  type RuntimeContentRef,
  type RuntimeDataScope,
} from '@allrice/contracts';
import { RuntimePolicyError } from './runtime-policy.ts';

/** Additional outbound authority, independent of access to a cloud file. Runs
 * with a historical offline payload never gain networking from a new profile. */
export function assertCloudNetworkAuthority(
  command: CloudCommand,
  profile: CloudExecutionProfile,
  snapshot: EmployeeExecutionSnapshot | undefined,
  privateExecution = false,
) {
  if (command.network === 'none') return;
  const grant = profile.sandboxNetwork;
  if (
    !runtimeFeatureEnabled('ALLRICE_SANDBOX_NETWORK_ENABLED') ||
    privateExecution ||
    !snapshot ||
    !grant ||
    !snapshot.capabilitySnapshot.grantedCapabilities.includes(
      'network:outbound',
    ) ||
    (snapshot.employee.definition.schemaVersion === 2 &&
      snapshot.employee.definition.securityPolicy.deniedCapabilities.includes(
        'network:outbound',
      )) ||
    command.network.origins.some((origin) => !grant.origins.includes(origin))
  )
    throw new RuntimePolicyError('sandbox_network_not_authorized');
  if (command.arguments.inputs.length && !grant.allowInputTransfer)
    throw new RuntimePolicyError('sandbox_network_transfer_not_authorized');
}

/** Freeze external transfer separately from the existing cloud execution copy.
 * Exact approval/member automation then covers these files AND destinations. */
export function cloudInputTransferScopes(
  content: RuntimeContentRef[],
  operationId: string,
  network?: { command: CloudCommand; grantId: string; grantVersion: number },
): RuntimeDataScope[] {
  const scopes: RuntimeDataScope[] = content.map((item) => ({
    content: item,
    sourceTargetId: null,
    purpose: 'execution_input',
    destination: 'cloud_execution',
    authorizationId: operationId,
    authorizationVersion: 1,
  }));
  if (network && network.command.network !== 'none') {
    for (const item of content)
      scopes.push({
        content: item,
        sourceTargetId: null,
        purpose: 'execution_input',
        destination: 'external_service',
        externalNetwork: network.command.network,
        authorizationId: network.grantId,
        authorizationVersion: network.grantVersion,
      });
  }
  return scopes;
}
