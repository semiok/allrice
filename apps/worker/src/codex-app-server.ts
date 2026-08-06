import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { HandlerError } from './errors.js';

const maximumOutputBytes = 2_000_000;

export interface CodexDynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface CodexAppServerEvent {
  kind: 'tool';
  name: string;
  status: string;
  toolCallId: string;
  label: string;
  summary?: string;
  itemCount?: number;
  source: 'codex' | 'tool_broker';
}

export interface CodexAppServerToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CodexAppServerToolResult {
  modelContent: string;
  summary: string;
  itemCount?: number;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

function runtimeToolName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toolEventFromItem(
  item: Record<string, unknown>,
  status: string,
): CodexAppServerEvent | null {
  const type = stringValue(item.type);
  if (type !== 'commandExecution' && type !== 'mcpToolCall') return null;
  return {
    kind: 'tool',
    name: type,
    label: type === 'mcpToolCall' ? '调用受控工具' : '执行运行时工具',
    toolCallId: stringValue(item.id) ?? `${type}-unknown`,
    status,
    source: 'codex',
  };
}

export async function runCodexAppServerTurn(input: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  developerInstructions: string;
  prompt: string;
  networkAllowed: boolean;
  tools: readonly CodexDynamicToolDefinition[];
  signal?: AbortSignal;
  onEvent: (event: CodexAppServerEvent) => Promise<void>;
  onToolCall: (
    call: CodexAppServerToolCall,
  ) => Promise<CodexAppServerToolResult>;
}) {
  const runtimeTools = new Map(
    input.tools.map((tool) => [runtimeToolName(tool.name), tool] as const),
  );
  if (runtimeTools.size !== input.tools.length) {
    throw new HandlerError(
      'CODEX_DYNAMIC_TOOL_COLLISION',
      'Two Tool Broker names map to the same Codex dynamic tool name',
      false,
    );
  }
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pendingRequests = new Map<string | number, PendingRequest>();
  let requestId = 0;
  let outputBytes = 0;
  let answer = '';
  let answerDelta = '';
  let completed = false;
  let lineChain = Promise.resolve();
  let terminalError: Error | null = null;
  let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const turnCompleted = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  void turnCompleted.catch(() => undefined);

  const send = (message: JsonRpcMessage) => {
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      send({ id, method, params });
    });
  };
  const fail = (error: Error) => {
    if (!terminalError) terminalError = error;
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    rejectTurn(error);
    if (!child.killed) child.kill('SIGTERM');
  };
  const abort = () =>
    fail(new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false));
  input.signal?.addEventListener('abort', abort, { once: true });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maximumOutputBytes) {
      fail(
        new HandlerError(
          'CODEX_OUTPUT_LIMIT',
          'Codex output exceeded the execution limit',
          false,
        ),
      );
    }
  });

  const handleDynamicToolCall = async (message: JsonRpcMessage) => {
    const params = message.params ?? {};
    const requestedName = stringValue(params.tool);
    const callId = stringValue(params.callId);
    const argumentsValue = objectValue(params.arguments);
    const tool = requestedName ? runtimeTools.get(requestedName) : undefined;
    if (!tool || !callId || !argumentsValue || message.id === undefined) {
      send({
        id: message.id,
        error: { code: -32602, message: 'Invalid dynamic tool request' },
      });
      return;
    }
    const name = tool.name;
    await input.onEvent({
      kind: 'tool',
      name,
      label: name,
      toolCallId: callId,
      status: 'started',
      source: 'tool_broker',
    });
    try {
      const result = await input.onToolCall({
        id: callId,
        name,
        arguments: argumentsValue,
      });
      await input.onEvent({
        kind: 'tool',
        name,
        label: name,
        toolCallId: callId,
        status: 'completed',
        source: 'tool_broker',
        summary: result.summary,
        itemCount: result.itemCount,
      });
      send({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: result.modelContent }],
          success: true,
        },
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'tool execution failed';
      await input.onEvent({
        kind: 'tool',
        name,
        label: name,
        toolCallId: callId,
        status: 'failed',
        source: 'tool_broker',
        summary: detail,
      });
      send({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: `Tool error: ${detail}` }],
          success: false,
        },
      });
    }
  };

  const handleMessage = async (line: string) => {
    outputBytes += Buffer.byteLength(line);
    if (outputBytes > maximumOutputBytes) {
      throw new HandlerError(
        'CODEX_OUTPUT_LIMIT',
        'Codex output exceeded the execution limit',
        false,
      );
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error !== undefined) &&
      !message.method
    ) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new HandlerError(
            'CODEX_APP_SERVER_ERROR',
            message.error.message ?? 'Codex app-server request failed',
            false,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === 'item/tool/call' && message.id !== undefined) {
      await handleDynamicToolCall(message);
      return;
    }
    if (message.id !== undefined && message.method) {
      send({
        id: message.id,
        error: { code: -32601, message: 'Unsupported server request' },
      });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      answerDelta += stringValue(message.params?.delta) ?? '';
      return;
    }
    if (message.method === 'item/started') {
      const item = objectValue(message.params?.item);
      const event = item ? toolEventFromItem(item, 'started') : null;
      if (event) await input.onEvent(event);
      return;
    }
    if (message.method === 'item/completed') {
      const item = objectValue(message.params?.item);
      if (!item) return;
      if (item.type === 'agentMessage') {
        answer = stringValue(item.text) ?? answer;
      }
      const event = toolEventFromItem(
        item,
        stringValue(item.status) ?? 'completed',
      );
      if (event) await input.onEvent(event);
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = objectValue(message.params?.tokenUsage);
      const last = objectValue(tokenUsage?.last);
      usage = {
        inputTokens: Number(last?.inputTokens ?? 0),
        cachedInputTokens: Number(last?.cachedInputTokens ?? 0),
        outputTokens: Number(last?.outputTokens ?? 0),
      };
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = objectValue(message.params?.turn);
      const status = stringValue(turn?.status);
      if (status === 'completed') {
        completed = true;
        resolveTurn();
      } else {
        const turnError = objectValue(turn?.error);
        throw new HandlerError(
          status === 'interrupted' ? 'EXECUTION_ABORTED' : 'CODEX_EXEC_FAILED',
          stringValue(turnError?.message) ??
            `Codex turn ended with status ${status ?? 'unknown'}`,
          false,
        );
      }
    }
  };

  lines.on('line', (line) => {
    lineChain = lineChain.then(() => handleMessage(line)).catch(fail);
  });
  child.on('error', (error) => fail(error));
  const processClosed = new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      input.signal?.removeEventListener('abort', abort);
      lines.close();
      if (!completed && !terminalError) {
        fail(
          new HandlerError(
            'CODEX_EXEC_FAILED',
            `Codex app-server exited unsuccessfully (${code ?? signal ?? 'unknown'})`,
            false,
          ),
        );
      }
      resolve();
    });
  });

  try {
    await request('initialize', {
      clientInfo: {
        name: 'allrice',
        title: 'AllRice Worker',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    send({ method: 'initialized', params: {} });
    const threadResult = await request('thread/start', {
      model: input.model,
      cwd: input.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'allrice_worker',
      baseInstructions: input.developerInstructions,
      config: {
        mcp_servers: {},
        plugins: {},
        project_doc_max_bytes: 0,
        web_search: input.networkAllowed ? 'live' : 'disabled',
      },
      dynamicTools: input.tools.map((tool) => ({
        type: 'function',
        name: runtimeToolName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    const thread = objectValue(threadResult.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) {
      throw new HandlerError(
        'CODEX_APP_SERVER_ERROR',
        'Codex app-server did not return a thread id',
        false,
      );
    }
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: input.model,
      effort: input.reasoningEffort,
    });
    await turnCompleted;
    await lineChain;
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
    await processClosed;
  }

  if (terminalError) throw terminalError;
  const finalAnswer = answer.trim() ? answer : answerDelta;
  if (!finalAnswer.trim()) {
    throw new HandlerError(
      'CODEX_EMPTY_RESPONSE',
      'Codex completed without a final response',
      false,
    );
  }
  return { answer: finalAnswer, usage };
}
