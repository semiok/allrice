import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  closeCodexAppServerClients,
  codexAppServerArguments,
  codexExecArguments,
  compactCodexAppServerThread,
  executeCodexHarness,
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
    expect(args).toContain('web_search="live"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('locks app-server turns to host-provided tools without shell access', () => {
    const args = codexAppServerArguments(['model:invoke']);
    expect(args.slice(0, 2)).toEqual(['app-server', '--stdio']);
    expect(args).toContain('shell_tool');
    expect(args).toContain('unified_exec');
    expect(args).toContain('mcp_servers={}');
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('browser_use');
  });

  it('keeps a dynamic tool call and final answer inside one app-server process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-app-server-'));
    const executable = join(directory, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(require('node:path').join(__dirname, 'spawn.log'), '1\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(require('node:path').join(__dirname, 'requests.log'), JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
  if (message.method === 'thread/start') {
    if (message.params.dynamicTools?.[0]?.name !== 'workspace_file_list') process.exit(9);
    if (message.params.ephemeral !== false || message.params.historyMode !== undefined) process.exit(12);
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  }
  if (message.method === 'thread/resume') {
    if (message.params.threadId !== 'thread-1') process.exit(11);
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  }
  if (message.method === 'thread/compact/start') {
    send({ id: message.id, result: {} });
    send({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-1' } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'web-1', query: 'current weather', action: { type: 'search', query: 'current weather' } } } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'web-1', query: 'current weather', action: { type: 'search', query: 'current weather' } } } });
    send({ id: 90, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'workspace_file_list', arguments: { limit: 2 } } });
  }
  if (message.id === 90 && message.result) {
    if (message.result.success !== true) process.exit(10);
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '找到' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '两个文件。' } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'message-1', text: '找到两个文件。', phase: null, memoryCitation: null } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 8 } } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
  }
});
`,
      'utf8',
    );
    await chmod(executable, 0o700);
    const previousCommand = process.env.ALLRICE_CODEX_COMMAND;
    process.env.ALLRICE_CODEX_COMMAND = executable;
    const events: unknown[] = [];
    let threadId: string | null = null;
    try {
      const run = (existingThreadId?: string | null) =>
        executeCodexHarness({
          storageObjects: [],
          workDirectory: directory,
          executionEnvironment: {},
          systemInstructions: 'You are Rice.',
          prompt: '列出文件',
          providerSnapshot: {
            provider: 'codex',
            authMode: 'chatgpt_subscription',
            model: 'test-model',
            reasoningEffort: 'high',
            sandbox: 'workspace-write',
          },
          grantedCapabilities: ['model:invoke', 'storage:read'],
          signal: new AbortController().signal,
          onEvent: async (event) => {
            events.push(event);
          },
          toolDefinitions: [
            {
              name: 'workspace.file.list',
              description: 'List files',
              inputSchema: { type: 'object' },
            },
          ],
          onToolCall: async (call) => {
            expect(call).toMatchObject({
              id: 'call-1',
              name: 'workspace.file.list',
              arguments: { limit: 2 },
            });
            return {
              modelContent: '[{"id":"one"},{"id":"two"}]',
              summary: '找到 2 个可访问文件',
              itemCount: 2,
            };
          },
          conversationRuntime: {
            threadId: existingThreadId,
            clientUserMessageId: 'message-1',
            onThreadBound: async (binding) => {
              threadId = binding.threadId;
            },
          },
        });
      const result = await run();
      expect(result.answer).toBe('找到两个文件。');
      expect(result.usage).toEqual({
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 8,
      });
      expect(await readFile(join(directory, 'spawn.log'), 'utf8')).toBe('1\n');
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          toolCallId: 'call-1',
          status: 'completed',
          source: 'tool_broker',
          itemCount: 2,
        }),
      );
      expect(events).toContainEqual({
        kind: 'message',
        text: '找到两个文件。',
        source: 'codex',
      });
      expect(events).toContainEqual({ kind: 'delta', text: '找到' });
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          name: 'web.search',
          label: '联网搜索',
          status: 'completed',
          source: 'codex',
        }),
      );
      expect(threadId).toBe('thread-1');
      await expect(
        compactCodexAppServerThread(threadId!),
      ).resolves.toBeUndefined();
      await expect(run(threadId)).resolves.toMatchObject({
        answer: '找到两个文件。',
      });
      expect(await readFile(join(directory, 'spawn.log'), 'utf8')).toBe('1\n');
      const requests = (await readFile(join(directory, 'requests.log'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) => JSON.parse(line) as { method?: string; params?: object },
        );
      expect(
        requests.filter((request) => request.method === 'thread/start'),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === 'thread/resume'),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === 'thread/compact/start'),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.method === 'turn/start'),
      ).toHaveLength(2);
      expect(
        requests.find((request) => request.method === 'turn/start')?.params,
      ).toMatchObject({ clientUserMessageId: 'message-1' });
    } finally {
      await closeCodexAppServerClients();
      if (previousCommand === undefined)
        delete process.env.ALLRICE_CODEX_COMMAND;
      else process.env.ALLRICE_CODEX_COMMAND = previousCommand;
    }
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
