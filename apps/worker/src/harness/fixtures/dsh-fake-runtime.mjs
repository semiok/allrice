import process from 'node:process';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers';

let seq = 0;
let initializedProvider = '';
const turns = new Map();

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

function assistant(sessionId, turn, text) {
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
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: initializedProvider, model: 'fake' },
    },
    usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 },
  });
  event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    initializedProvider = frame.params.provider;
    respond(frame.id, {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: '0.1.1-rc.2-fake',
      },
    });
    return;
  }
  if (frame.method === 'shutdown') {
    respond(frame.id, {});
    setImmediate(() => process.exit(0));
    return;
  }
  if (frame.method !== 'session/prompt') return;
  const { sessionId, contentBlocks } = frame.params;
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
  if (prompt.includes('hang forever')) return;
  let text;
  if (prompt.trimStart().startsWith('<allrice_tool_result>')) {
    text = 'tool-finished';
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
  } else if (prompt.includes('think-first')) {
    text = '<think>private reasoning</think>\n\nvisible answer';
  } else {
    text = `turn-${turn}`;
  }
  assistant(sessionId, turn, text);
  notify('session.status', { sessionId, status: 'idle' });
});
