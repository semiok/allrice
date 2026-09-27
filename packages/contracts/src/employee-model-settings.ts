import type { PlatformEmployeeDefinition } from './platform-employees.ts';

type ModelPolicy = PlatformEmployeeDefinition['modelPolicy'];
type Effort = ModelPolicy['reasoningEffort'];

export const EMPLOYEE_PROVIDER_OPTIONS = [
  { value: 'openai-codex', label: 'Codex 订阅' },
] as const;

/** The levels connected by this AllRice release, not every vendor API level.
 * Keep historical schemas permissive; validate new configuration separately.
 * Sources and adapter limitations: docs/architecture/allrice-2.0/model-settings.md.
 */
export function employeeReasoningSettings(provider: string, model: string) {
  const id = model.trim() === '3.8flash' ? 'gemini-3.8-flash' : model.trim();
  let efforts: Effort[] = [];
  if (provider === 'openai-codex') {
    // Exact IDs in this pinned pi-ai Codex catalog, not a family-name guess.
    if (
      [
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.5',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ].includes(id)
    ) {
      efforts = ['low', 'medium', 'high', 'xhigh'];
    }
  }
  return {
    efforts,
    defaultEffort: (efforts.includes('medium') ? 'medium' : 'high') as Effort,
    label: '推理强度（reasoning effort）',
  };
}

export function employeeModelPolicyProblem(policy: ModelPolicy): string | null {
  if (
    !EMPLOYEE_PROVIDER_OPTIONS.some((item) => item.value === policy.provider)
  ) {
    return '该 Provider 已从新配置入口移除，请使用平台统一的 Codex 订阅配置；历史记录不受影响。';
  }
  const settings = employeeReasoningSettings(policy.provider, policy.model);
  if (!settings.efforts.length) {
    return '当前模型尚未核验推理档位，不能保存或发布；请使用已支持的模型。';
  }
  if (!settings.efforts.includes(policy.reasoningEffort)) {
    return `当前模型不支持此推理档位，请选择：${settings.efforts.join('、')}。`;
  }
  return null;
}

export function switchEmployeeModelProvider(
  policy: ModelPolicy,
  provider: (typeof EMPLOYEE_PROVIDER_OPTIONS)[number]['value'],
): ModelPolicy {
  if (policy.provider === provider) return policy;
  const model = 'gpt-5.6-luna';
  const settings = employeeReasoningSettings(provider, model);
  return {
    ...policy,
    provider,
    model,
    reasoningEffort: settings.efforts.includes(policy.reasoningEffort)
      ? policy.reasoningEffort
      : settings.defaultEffort,
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
    fallbackModels: [],
  };
}
