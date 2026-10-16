import {
  sandboxExecutionBudgetSpec,
  runtimeContractEqual,
  type EmployeeExecutionSnapshot,
  type RuntimeLocalCommand,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import { RuntimePolicyError } from './runtime-policy.ts';

/** Re-evaluate the frozen Run policy at every admission/renewal. A Bridge's
 * report proves protocol availability only; it cannot choose or extend caps. */
export function assertLocalSandboxExecutionBudget(
  command: RuntimeLocalCommand | RuntimeLocalPythonPayload,
  snapshot: EmployeeExecutionSnapshot | undefined,
) {
  const request = command.arguments.execution;
  if (!command.executionBudget && !request) return;
  if (process.env.ALLRICE_SANDBOX_EXECUTION_V1_ENABLED !== '1')
    throw new RuntimePolicyError('sandbox_execution_not_enabled');
  if (
    ('background' in command.arguments && command.arguments.background) ||
    snapshot?.schemaVersion !== 2 ||
    !snapshot.sandboxExecutionPolicy ||
    !request ||
    !runtimeContractEqual(
      command.executionBudget,
      sandboxExecutionBudgetSpec(request, snapshot.sandboxExecutionPolicy),
    )
  )
    throw new RuntimePolicyError('sandbox_execution_policy_changed');
}
