import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  codexExecArguments,
  materializeSkillBundle,
  normalizeCodexEvent,
} from './codex.js';

describe('Codex SkillRun adapter', () => {
  it('keeps subscription execution ephemeral and disables credential-reading shell tools', () => {
    const args = codexExecArguments(
      {
        command: 'codex',
        authHome: '/credentials',
        model: 'configured-model',
        reasoningEffort: 'high',
        storageRoot: '/storage',
      },
      '/isolated/run',
      ['model:invoke', 'network:outbound'],
    );
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('shell_tool');
    expect(args).toContain('unified_exec');
    expect(args).toContain('computer_use');
    expect(args).toContain('browser_use_full_cdp_access');
    expect(args).toContain('browser_use');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('normalizes only durable, secret-free Codex event fields', () => {
    expect(
      normalizeCodexEvent(
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            status: 'completed',
            command: 'printenv SECRET',
            output: 'must-not-be-persisted',
          },
        }),
      ),
    ).toEqual({
      kind: 'tool',
      name: 'command_execution',
      label: '执行运行时工具',
      toolCallId: 'command_execution-unknown',
      status: 'completed',
      source: 'codex',
    });
    expect(
      normalizeCodexEvent(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'tool-1', type: 'mcp_tool_call' },
        }),
      ),
    ).toEqual({
      kind: 'tool',
      name: 'mcp_tool_call',
      label: '调用受控工具',
      toolCallId: 'tool-1',
      status: 'started',
      source: 'codex',
    });
    expect(
      normalizeCodexEvent(
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 12,
            cached_input_tokens: 4,
            output_tokens: 7,
          },
        }),
      ),
    ).toEqual({
      kind: 'usage',
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 7 },
    });
    expect(normalizeCodexEvent('not json')).toBeNull();
  });

  it('materializes validated regular files into an isolated directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-skill-'));
    await materializeSkillBundle(
      {
        schemaVersion: 1,
        entrypoint: 'SKILL.md',
        files: [
          { path: 'SKILL.md', content: '# Test skill' },
          { path: 'references/example.md', content: 'safe' },
        ],
      },
      directory,
    );
    await expect(
      readFile(join(directory, 'skill-artifact', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Test skill');
    await expect(
      readFile(
        join(directory, 'skill-artifact', 'references/example.md'),
        'utf8',
      ),
    ).resolves.toBe('safe');
  });
});
