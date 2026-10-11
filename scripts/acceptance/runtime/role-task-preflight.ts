/** Read-only checks before a paid role task. Callers must obtain these facts
 * from the actual published employee and persisted ordinary QA authority. */
export function assertRoleTaskPreflight(input: {
  expectedRevisionId: string;
  publishedRevisionId: string;
  model: string;
  expectedModel: string;
  reasoningEffort: string;
  expectedReasoningEffort: string;
  tools: readonly string[];
  requiredTools: readonly string[];
  ordinaryAccount: boolean;
  platformIsolated: boolean;
  backendReady: boolean;
  executionGrantEnabled: boolean;
}) {
  const failures: string[] = [];
  if (
    !input.expectedRevisionId ||
    input.expectedRevisionId !== input.publishedRevisionId
  )
    failures.push('published_revision_mismatch');
  if (
    input.model !== input.expectedModel ||
    input.reasoningEffort !== input.expectedReasoningEffort
  )
    failures.push('model_configuration_mismatch');
  if (input.requiredTools.some((tool) => !input.tools.includes(tool)))
    failures.push('required_tool_unavailable');
  if (!input.ordinaryAccount || !input.platformIsolated)
    failures.push('isolated_ordinary_account_required');
  if (!input.backendReady || !input.executionGrantEnabled)
    failures.push('execution_authority_not_ready');
  if (failures.length) throw Error('ROLE_TASK_PREFLIGHT:' + failures.join(','));
  return { passed: true as const, revisionId: input.publishedRevisionId };
}
