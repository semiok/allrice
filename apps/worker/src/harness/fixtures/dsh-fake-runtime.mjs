import process from 'node:process';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers';

let seq = 0;
let initializedProvider = '';
const turns = new Map();
const pendingToolRequests = new Map();

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function event(sessionId, type, data) {
  notify('session.event', {
    sessionId,
    event: { type, seq: seq++, time: Date.now(), data },
  });
}

function assistant(sessionId, turn, text, usageMode = '') {
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  for (const delta of [text.slice(0, midpoint), text.slice(midpoint)]) {
    if (!delta) continue;
    event(sessionId, 'assistant/chunk', {
      turn,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: delta },
    });
  }
  event(sessionId, 'assistant/message', {
    turn,
    step: 0,
    message: {
      id: `assistant-${seq}`,
      role: 'assistant',
      content:
        usageMode === 'usage-zero-after-delta' ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: initializedProvider, model: 'fake' },
    },
    ...(usageMode === 'usage-missing'
      ? {}
      : {
          usage:
            usageMode === 'usage-synthetic-zero'
              ? {
                  inputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 0,
                }
              : usageMode === 'usage-complete'
                ? {
                    inputTokens: 11,
                    cacheReadTokens: 3,
                    cacheWriteTokens: 2,
                    outputTokens: 5,
                  }
                : usageMode === 'usage-zero-after-delta'
                  ? {
                      inputTokens: 11,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                      outputTokens: 0,
                    }
                  : { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 },
        }),
  });
  event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
}

function reasoning(sessionId, turn, step = 0) {
  event(sessionId, 'assistant/chunk', {
    turn,
    step,
    chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
  });
  event(sessionId, 'assistant/chunk', {
    turn,
    step,
    chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
  });
  event(sessionId, 'assistant/chunk', {
    turn,
    step,
    chunk: {
      type: 'block-end',
      index: 0,
      block: { kind: 'reasoning', text: 'private reasoning' },
    },
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (
    typeof frame.id === 'string' &&
    !frame.method &&
    pendingToolRequests.has(frame.id)
  ) {
    const pending = pendingToolRequests.get(frame.id);
    pendingToolRequests.delete(frame.id);
    event(pending.sessionId, 'tool/result', {
      turn: pending.turn,
      step: 1,
      ...(frame.error ? { error: frame.error } : {}),
      message: {
        content: [
          {
            type: 'tool-result',
            toolCallId: pending.callId,
            content: [
              {
                type: 'text',
                text:
                  frame.result?.modelContent ??
                  frame.error?.message ??
                  'tool failed',
              },
            ],
          },
        ],
      },
    });
    assistant(
      pending.sessionId,
      pending.turn,
      frame.error ? pending.failureAnswer : pending.successAnswer,
    );
    notify('session.status', {
      sessionId: pending.sessionId,
      status: 'idle',
    });
    return;
  }
  if (frame.method === 'initialize') {
    initializedProvider = frame.params.provider;
    respond(frame.id, {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: '0.1.1-rc.2-fake',
      },
      capabilities: {
        taskProgress:
          process.env.ALLRICE_PROGRESS_GUARD_ENABLED === '1' &&
          frame.params.model !== 'legacy-progress',
      },
    });
    return;
  }
  if (frame.method === 'shutdown') {
    respond(frame.id, {});
    setImmediate(() => process.exit(0));
    return;
  }
  if (frame.method === 'session/interrupt') {
    respond(frame.id, { interrupted: true });
    notify('session.status', {
      sessionId: frame.params.sessionId,
      status: 'idle',
    });
    return;
  }
  if (frame.method === 'session/compact') {
    respond(frame.id, { compacted: true, compactionId: `compact-${seq++}` });
    return;
  }
  if (frame.method === 'session/projection') {
    respond(frame.id, {
      asOfSeq: seq - 1,
      contextPressure: {
        pressureTokens: 12000,
        projectedTokens: 13516,
        contextWindow: 200000,
      },
    });
    return;
  }
  if (frame.method === 'session/recover') {
    respond(frame.id, { recovered: true, sequence: seq });
    return;
  }
  if (frame.method === 'session/steer') {
    respond(frame.id, { messageId: `steer-${seq++}` });
    return;
  }
  if (frame.method === 'session/close') {
    turns.delete(frame.params.sessionId);
    respond(frame.id, { closed: true });
    return;
  }
  if (frame.method !== 'session/prompt') return;
  const { sessionId, contentBlocks, images = [] } = frame.params;
  const prompt = contentBlocks.map((block) => block.text ?? '').join('');
  const turn = (turns.get(sessionId) ?? 0) + 1;
  turns.set(sessionId, turn);
  const messageId = `user-${seq}`;
  respond(frame.id, { messageId });
  event(sessionId, 'agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{ id: messageId, role: 'user', content: [] }],
  });
  notify('session.status', { sessionId, status: 'running' });
  event(sessionId, 'turn/start', { turn });
  event(sessionId, 'request/header', {
    reason: 'initial',
    header: {
      system: 'system-secret-that-must-not-reach-chatflow',
      tools: [{ name: 'secret-tool', inputSchema: { token: 'secret-token' } }],
      config: { provider: initializedProvider, model: 'fake' },
    },
  });
  event(sessionId, 'request/context', {
    provider: initializedProvider,
    model: 'fake',
    contextWindow: 128000,
  });
  if (prompt.includes('crash after acknowledgement')) {
    event(sessionId, 'assistant/chunk', {
      turn,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'retained partial output' },
    });
    event(sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'retained partial output' }],
      },
      usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 },
    });
    setImmediate(() => process.kill(process.pid, 'SIGKILL'));
    return;
  }
  if (prompt.includes('hang forever')) return;
  let text;
  if (prompt.includes('inspect-images')) {
    text = JSON.stringify({
      count: images.length,
      names: images.map((image) => image.name),
      mediaTypes: images.map((image) => image.mediaType),
    });
  } else if (prompt.trimStart().startsWith('<allrice_tool_result>')) {
    text = 'tool-finished';
  } else if (prompt.includes('use-tool-with-preamble')) {
    text =
      'I will check that now.\n<allrice_tool_call>{"id":"call-1","name":"workspace.file.list","arguments":{"limit":1}}</allrice_tool_call>';
  } else if (prompt.includes('use-tool-with-postamble')) {
    text =
      '<allrice_tool_call>{"id":"call-1","name":"workspace.file.list","arguments":{"limit":1}}</allrice_tool_call>I will summarize after the tool returns.';
  } else if (prompt.includes('use-tool')) {
    text =
      '<allrice_tool_call>{"id":"call-1","name":"workspace.file.list","arguments":{"limit":1}}</allrice_tool_call>';
  } else if (prompt.includes('show-env')) {
    text = JSON.stringify({
      provider: initializedProvider,
      keys: Object.keys(process.env).sort(),
      hasDeepSeek: Boolean(process.env.DEEPSEEK_API_KEY),
      hasOpenAiCompatible: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
    });
  } else if (prompt.includes('inspect-mixed-tool-instructions')) {
    text = JSON.stringify({
      nativeLocalAdvertised: prompt.includes(
        'DSH native tools available for this turn: local.fs.list.',
      ),
      bridgedToolsAdvertised: prompt.includes(
        'additional non-native AllRice tools are available',
      ),
      incorrectlyClaimsOnlyBridgedTools: prompt.includes(
        'The only available tools are the AllRice tenant-scoped tools below.',
      ),
    });
  } else if (prompt.includes('think-first')) {
    reasoning(sessionId, turn, 0);
    text = 'visible answer';
  } else if (prompt.includes('native-result-outcome:')) {
    const outcome = prompt.match(/native-result-outcome:([a-z-]+)/)?.[1];
    reasoning(sessionId, turn, 0);
    event(sessionId, 'tool/call', {
      turn,
      step: 1,
      callId: 'native-result-outcome-1',
      name: 'local_fs_list',
      arguments: JSON.stringify({ secret: 'private-tool-arguments' }),
    });
    event(sessionId, 'tool/result', {
      turn,
      step: 1,
      ...(outcome === 'legacy-error'
        ? {
            error: {
              name: 'TestError',
              code: 'SYNTHETIC_FAILURE',
              message: 'private-error-text',
            },
          }
        : {}),
      message: {
        content: [
          {
            type: 'tool-result',
            toolCallId: 'native-result-outcome-1',
            ...(outcome === 'failed'
              ? { isError: true }
              : outcome === 'succeeded'
                ? { isError: false }
                : outcome === 'truthy-string'
                  ? { isError: 'false' }
                  : {}),
            content: [{ type: 'text', text: 'private-tool-result' }],
          },
        ],
      },
    });
    text = 'native-result-outcome-finished';
  } else if (prompt.includes('native-search')) {
    reasoning(sessionId, turn, 0);
    event(sessionId, 'tool/call', {
      turn,
      step: 1,
      callId: 'native-search-1',
      name: 'web_search',
      arguments: JSON.stringify({ queries: ['NVIDIA price'] }),
    });
    event(sessionId, 'tool/result', {
      turn,
      step: 1,
      message: {
        content: [
          {
            type: 'tool-result',
            toolCallId: 'native-search-1',
            content: [{ type: 'text', text: 'search evidence' }],
          },
        ],
      },
    });
    reasoning(sessionId, turn, 2);
    text = 'native-search-finished';
  } else if (prompt.includes('native-local')) {
    reasoning(sessionId, turn, 0);
    const callId = 'native-local-1';
    const requestId = 'broker-native-local-1';
    event(sessionId, 'tool/call', {
      turn,
      step: 1,
      callId,
      name: 'local_fs_list',
      arguments: JSON.stringify({ path: '.', limit: 20 }),
    });
    pendingToolRequests.set(requestId, {
      sessionId,
      turn,
      callId,
      successAnswer: 'native-local-finished',
      failureAnswer: 'native-local-failed',
    });
    write({
      jsonrpc: '2.0',
      id: requestId,
      method: 'allrice/tool-call',
      params: {
        toolCallId: callId,
        name: 'local.fs.list',
        arguments: { path: '.', limit: 20 },
      },
    });
    return;
  } else if (prompt.includes('native-wechat')) {
    reasoning(sessionId, turn, 0);
    const callId = 'native-wechat-1';
    const requestId = 'broker-native-wechat-1';
    event(sessionId, 'tool/call', {
      turn,
      step: 1,
      callId,
      name: 'wechat_article_search',
      arguments: JSON.stringify({ query: 'AllRice', limit: 3 }),
    });
    pendingToolRequests.set(requestId, {
      sessionId,
      turn,
      callId,
      successAnswer: 'native-wechat-finished',
      failureAnswer: 'native-wechat-failed',
    });
    write({
      jsonrpc: '2.0',
      id: requestId,
      method: 'allrice/tool-call',
      params: {
        toolCallId: callId,
        name: 'wechat.article.search',
        arguments: { query: 'AllRice', limit: 3 },
      },
    });
    return;
  } else {
    text = `turn-${turn}`;
  }
  const multiReceipts = prompt.includes('multi-receipts');
  if (multiReceipts)
    assistant(
      sessionId,
      turn,
      text,
      prompt.includes('missing-then') ? 'usage-missing' : 'usage-complete',
    );
  const usageMode = multiReceipts
    ? 'usage-complete'
    : [
        'usage-missing',
        'usage-synthetic-zero',
        'usage-complete',
        'usage-zero-after-delta',
      ].find((mode) => prompt.includes(mode));
  assistant(sessionId, turn, text, usageMode);
  notify('session.status', { sessionId, status: 'idle' });
});
