import { describe, expect, it } from 'vitest';
import { assertRoleTaskPreflight } from './role-task-preflight.ts';
const input = {
  expectedRevisionId: 'published-new',
  publishedRevisionId: 'published-new',
  model: 'gpt-6.1-sol',
  expectedModel: 'gpt-6.1-sol',
  reasoningEffort: 'xhigh',
  expectedReasoningEffort: 'xhigh',
  tools: ['workspace.project', 'cloud.process.execute', 'browser.workspace'],
  requiredTools: [
    'workspace.project',
    'cloud.process.execute',
    'browser.workspace',
  ],
  ordinaryAccount: true,
  platformIsolated: true,
  backendReady: true,
  executionGrantEnabled: true,
};
describe('actual role task preflight', () => {
  it('rejects the outdated programmer clone before invoking a model', () => {
    expect(() =>
      assertRoleTaskPreflight({ ...input, tools: ['workspace.project'] }),
    ).toThrow('required_tool_unavailable');
  });
  it('accepts a ready, frozen ordinary role without changing its tools', () => {
    expect(assertRoleTaskPreflight(input).passed).toBe(true);
    expect(input.tools).toHaveLength(3);
  });
  it.each([
    { publishedRevisionId: 'old' },
    { model: 'other' },
    { reasoningEffort: 'medium' },
    { ordinaryAccount: false },
    { platformIsolated: false },
    { backendReady: false },
    { executionGrantEnabled: false },
  ])('rejects stale configuration or missing authority %j', (change) => {
    expect(() => assertRoleTaskPreflight({ ...input, ...change })).toThrow(
      'ROLE_TASK_PREFLIGHT',
    );
  });
});
