import { describe, expect, it } from 'vitest';
import { classifyMcpFailure, mcpFailureCopy } from './mcp-failure.ts';

const denied = {
  code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  tool: 'mcp__app__merge_pull_request',
  output: JSON.stringify({
    isError: true,
    error: {
      message:
        'failed to merge pull request: PUT https://api.github.com/repos/semiok/allrice/pulls/200/merge: 403 Resource not accessible by personal access token []',
    },
  }),
};
describe('MCP reported errors vs missing receipts', () => {
  it('identifies the recorded GitHub denial without exposing remote content', () => {
    const kind = classifyMcpFailure(denied)!;
    expect(kind).toBe('github_merge_permission');
    expect(mcpFailureCopy[kind].detail).toContain('Contents');
    expect(mcpFailureCopy[kind].detail).not.toContain('semiok');
    expect(mcpFailureCopy[kind].detail).toContain('不会自动重试');
  });
  it.each([
    { endpoint: 'https://other.example.test/mcp' },
    { tool: 'mcp__app__other' },
    {
      output: JSON.stringify({
        isError: false,
        error: { message: JSON.parse(denied.output).error.message },
      }),
    },
    {
      output: JSON.stringify({
        isError: true,
        content: [
          { type: 'text', text: JSON.parse(denied.output).error.message },
        ],
      }),
    },
    { output: 'invalid json' },
  ])(
    'does not turn unrelated or malformed output into a permission finding: %j',
    (overrides) => {
      expect(classifyMcpFailure({ ...denied, ...overrides })).toBe(
        'remote_error',
      );
    },
  );
  it('ignores successful content, including text that quotes a failure', () => {
    expect(classifyMcpFailure({ ...denied, code: null })).toBeNull();
  });
  it('separates pre-dispatch unavailability, authentication and missing post-dispatch receipts', () => {
    expect(classifyMcpFailure({ code: 'MCP_UNAVAILABLE' })).toBe('unavailable');
    expect(classifyMcpFailure({ code: 'MCP_CREDENTIAL_UNAVAILABLE' })).toBe(
      'authentication',
    );
    expect(classifyMcpFailure({ code: 'MCP_UNKNOWN' })).toBe('result_unknown');
    expect(classifyMcpFailure({ code: 'MCP_INVALID_SCHEMA' })).toBeNull();
  });
});
