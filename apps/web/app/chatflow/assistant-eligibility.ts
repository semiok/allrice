import type { AssistantPreference } from '@allrice/contracts';
import type { Employee, Workspace } from './chatflow-types';

export type AssistantUnavailableReason =
  'feature_disabled' | 'model_unsupported' | 'employee_not_enabled';

/** Display hint only, never authority. A frozen server Session model wins over
 * an employee's subsequently changed default. Only an unfrozen Session uses
 * that default; unknown providers remain unavailable. The Worker still checks
 * its actual server-owned provider protocol and current permissions. */
export function assistantEligibility(input: {
  enabled: boolean;
  sessionId?: string | null;
  sessionModels: Workspace['sessionModels'];
  employee?: Pick<Employee, 'currentVersion'>;
}): {
  eligible: boolean;
  unavailableReason: AssistantUnavailableReason | null;
} {
  if (!input.enabled)
    return { eligible: false, unavailableReason: 'feature_disabled' };
  const frozen = input.sessionId
    ? input.sessionModels.find((model) => model.sessionId === input.sessionId)
    : undefined;
  const provider = frozen
    ? frozen.provider
    : input.employee?.currentVersion.manifest.runtimePolicy?.provider;
  // Legacy google is normalized only for this display; no request route changes.
  const displayProvider = provider === 'google' ? 'gemini' : provider;
  if (displayProvider !== 'gemini' && displayProvider !== 'openai-compatible')
    return { eligible: false, unavailableReason: 'model_unsupported' };
  if (
    !input.employee?.currentVersion.manifest.capabilityBindings?.toolNames.includes(
      'assistant.delegate',
    )
  )
    return { eligible: false, unavailableReason: 'employee_not_enabled' };
  return { eligible: true, unavailableReason: null };
}

/** Clamp the actual next-task request, not just the checkbox. An unavailable
 * model must not inherit the UI's default allow=true or a prior model's choice. */
export function assistantPreferenceForTask(input: {
  enabled: boolean;
  deliveryMode: string;
  eligible: boolean;
  allowAssistants: boolean;
}): AssistantPreference | undefined {
  if (!input.enabled || input.deliveryMode !== 'follow_up') return undefined;
  return {
    mode: 'daily',
    allowAssistants: input.eligible && input.allowAssistants,
  };
}
