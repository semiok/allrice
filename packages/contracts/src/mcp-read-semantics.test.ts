import { expect, it } from 'vitest';
import { mcpCallIsReadOnly } from './mcp.ts';
const check = (
  name: string,
  method: string,
  endpoint = 'https://api.githubcopilot.com/mcp/',
) =>
  mcpCallIsReadOnly({
    endpoint,
    tool: { name, risk: 'write' },
    arguments: { method },
  });
it.each(['pull_request_read', 'mcp__app__pull_request_read'])(
  'recognizes the official %s read methods despite legacy write classification',
  (name) => {
    expect(check(name, 'get')).toBe(true);
    expect(check(name, 'get_files')).toBe(true);
    expect(check(name, 'merge')).toBe(false);
  },
);
it('does not infer read permission from names on custom endpoints or write methods', () => {
  expect(
    check('pull_request_read', 'get', 'https://mcp.example.test/mcp'),
  ).toBe(false);
  expect(
    check('pull_request_read', 'get', 'https://api.githubcopilot.com/other'),
  ).toBe(false);
  expect(
    check(
      'pull_request_read',
      'get',
      'https://api.githubcopilot.com.evil.test/mcp/',
    ),
  ).toBe(false);
  expect(check('merge_pull_request', 'get')).toBe(false);
  expect(check('pull_request_review_write', 'get')).toBe(false);
  expect(check('get_file_contents', '')).toBe(true);
});
