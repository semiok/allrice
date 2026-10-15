import {
  sandboxExecutionBudgetSpec,
  runtimeContractEqual,
  type EmployeeExecutionSnapshot,
  type CloudCommand,
} from '@allrice/contracts';
import { RuntimePolicyError } from './runtime-policy.ts';

export function assertCloudExecutionBudget(
  command: CloudCommand,
  snapshot: EmployeeExecutionSnapshot | undefined,
  privateExecution: boolean,
) {
  if (!command.executionBudget && !command.arguments.execution) return;
  if (process.env.ALLRICE_SANDBOX_EXECUTION_V1_ENABLED !== '1')
    throw new RuntimePolicyError('sandbox_execution_not_enabled');
  if (
    privateExecution ||
    snapshot?.schemaVersion !== 2 ||
    !snapshot.sandboxExecutionPolicy ||
    !command.arguments.execution ||
    !runtimeContractEqual(
      command.executionBudget,
      sandboxExecutionBudgetSpec(
        command.arguments.execution,
        snapshot.sandboxExecutionPolicy,
      ),
    )
  )
    throw new RuntimePolicyError('sandbox_execution_policy_changed');
}
