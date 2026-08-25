import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { HandlerError } from './errors.js';

const maximumTurnOutputBytes = 2_000_000;
const requestTimeoutMs = 60_000;
const interruptGraceMs = 10_000;

export interface CodexDynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export type CodexAppServerEvent =
  | { kind: 'delta'; text: string }
  | {
      kind: 'tool';
      name: string;
      status: string;
      toolCallId: string;
      label: string;
      summary?: string;
      itemCount?: number;
      source: 'codex' | 'tool_broker';
    };

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
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  answer: string;
  answerDelta: string;
  outputBytes: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  runtimeTools: Map<string, CodexDynamicToolDefinition>;
  onEvent: (event: CodexAppServerEvent) => Promise<void>;
  onToolCall: (
    call: CodexAppServerToolCall,
  ) => Promise<CodexAppServerToolResult>;
  eventChain: Promise<void>;
  signal?: AbortSignal;
  abort?: () => void;
  interruptTimer?: NodeJS.Timeout;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
  done: Promise<void>;
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
  if (type === 'webSearch') {
    const action = objectValue(item.action);
    const actionType = stringValue(action?.type);
    const isFetch = actionType === 'openPage' || actionType === 'findInPage';
    return {
      kind: 'tool',
      name: isFetch ? 'web.fetch' : 'web.search',
      label: isFetch ? '读取网页' : '联网搜索',
      toolCallId: stringValue(item.id) ?? 'web-search-unknown',
      status,
      summary:
        stringValue(item.query) ??
        stringValue(action?.query) ??
        stringValue(action?.url) ??
        undefined,
      source: 'codex',
    };
  }
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

function createActiveTurn(input: {
  threadId: string;
  runtimeTools: Map<string, CodexDynamicToolDefinition>;
  signal?: AbortSignal;
  onEvent: ActiveTurn['onEvent'];
  onToolCall: ActiveTurn['onToolCall'];
}): ActiveTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  void done.catch(() => undefined);
  return {
    threadId: input.threadId,
    turnId: null,
    answer: '',
    answerDelta: '',
    outputBytes: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    runtimeTools: input.runtimeTools,
    onEvent: input.onEvent,
    onToolCall: input.onToolCall,
    eventChain: Promise.resolve(),
    signal: input.signal,
    settled: false,
    resolve,
    reject,
    done,
  };
}

class SharedCodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly closed: Promise<void>;
  private requestId = 0;
  private closing = false;
  private terminalError: Error | null = null;
  private readonly ready: Promise<void>;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    this.child.on('error', (error) => this.retire(error));
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      if (Buffer.byteLength(chunk) > maximumTurnOutputBytes) {
        this.retire(
          new HandlerError(
            'CODEX_OUTPUT_LIMIT',
            'Codex app-server stderr exceeded the execution limit',
            false,
          ),
        );
      }
    });
    this.closed = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.lines.close();
        if (!this.closing && !this.terminalError) {
          this.retire(
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
    this.ready = this.initialize();
    void this.ready.catch(() => undefined);
  }

  get usable() {
    return !this.closing && !this.terminalError && !this.child.killed;
  }

  private async initialize() {
    await this.request('initialize', {
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
    this.send({ method: 'initialized', params: {} });
  }

  private send(message: JsonRpcMessage) {
    if (!this.usable || this.child.stdin.destroyed) {
      throw (
        this.terminalError ??
        new HandlerError(
          'CODEX_APP_SERVER_ERROR',
          'Codex app-server is unavailable',
          false,
        )
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    if (options.signal?.aborted) {
      throw new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false);
    }
    const id = ++this.requestId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        if (pending.abort && pending.signal) {
          pending.signal.removeEventListener('abort', pending.abort);
        }
        reject(
          new HandlerError(
            'CODEX_APP_SERVER_ERROR',
            `${method} timed out`,
            false,
          ),
        );
      }, options.timeoutMs ?? requestTimeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      if (options.signal) {
        pending.signal = options.signal;
        pending.abort = () => {
          if (!this.pendingRequests.delete(id)) return;
          clearTimeout(timer);
          reject(
            new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false),
          );
        };
        options.signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pendingRequests.set(id, pending);
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        if (pending.abort && pending.signal) {
          pending.signal.removeEventListener('abort', pending.abort);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private settleRequest(message: JsonRpcMessage) {
    if (message.id === undefined) return false;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return false;
    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.abort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
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
    return true;
  }

  private scopedTurn(params: Record<string, unknown> | undefined) {
    if (!params) return null;
    const nestedTurn = objectValue(params.turn);
    const nestedItem = objectValue(params.item);
    const threadId =
      stringValue(params.threadId) ??
      stringValue(nestedTurn?.threadId) ??
      stringValue(nestedItem?.threadId);
    if (!threadId) return null;
    const active = this.activeTurns.get(threadId);
    if (!active) return null;
    const observedTurnId =
      stringValue(params.turnId) ??
      stringValue(nestedTurn?.id) ??
      stringValue(nestedItem?.turnId);
    if (active.turnId && observedTurnId && active.turnId !== observedTurnId) {
      return null;
    }
    return active;
  }

  private addTurnBytes(turn: ActiveTurn, line: string) {
    turn.outputBytes += Buffer.byteLength(line);
    if (turn.outputBytes <= maximumTurnOutputBytes) return true;
    this.finishTurn(
      turn,
      new HandlerError(
        'CODEX_OUTPUT_LIMIT',
        'Codex output exceeded the execution limit',
        false,
      ),
    );
    return false;
  }

  private queueEvent(turn: ActiveTurn, event: CodexAppServerEvent) {
    turn.eventChain = turn.eventChain.then(() => turn.onEvent(event));
    turn.eventChain.catch((error: unknown) => {
      this.finishTurn(
        turn,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  private async queueEventAndWait(
    turn: ActiveTurn,
    event: CodexAppServerEvent,
  ) {
    this.queueEvent(turn, event);
    await turn.eventChain;
  }

  private async handleDynamicToolCall(message: JsonRpcMessage) {
    const params = message.params ?? {};
    const turn = this.scopedTurn(params);
    const requestedName = stringValue(params.tool);
    const callId = stringValue(params.callId);
    const argumentsValue = objectValue(params.arguments);
    const tool = requestedName
      ? turn?.runtimeTools.get(requestedName)
      : undefined;
    if (
      !turn ||
      !tool ||
      !callId ||
      !argumentsValue ||
      message.id === undefined
    ) {
      this.send({
        id: message.id,
        error: { code: -32602, message: 'Invalid dynamic tool request' },
      });
      return;
    }
    const name = tool.name;
    await this.queueEventAndWait(turn, {
      kind: 'tool',
      name,
      label: name,
      toolCallId: callId,
      status: 'started',
      source: 'tool_broker',
    });
    try {
      const result = await turn.onToolCall({
        id: callId,
        name,
        arguments: argumentsValue,
      });
      await this.queueEventAndWait(turn, {
        kind: 'tool',
        name,
        label: name,
        toolCallId: callId,
        status: 'completed',
        source: 'tool_broker',
        summary: result.summary,
        itemCount: result.itemCount,
      });
      this.send({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: result.modelContent }],
          success: true,
        },
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'tool execution failed';
      await this.queueEventAndWait(turn, {
        kind: 'tool',
        name,
        label: name,
        toolCallId: callId,
        status: 'failed',
        source: 'tool_broker',
        summary: detail,
      });
      this.send({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: `Tool error: ${detail}` }],
          success: false,
        },
      });
    }
  }

  private handleNotification(message: JsonRpcMessage, rawLine: string) {
    const turn = this.scopedTurn(message.params);
    if (!turn || !this.addTurnBytes(turn, rawLine)) return;
    if (message.method === 'item/agentMessage/delta') {
      const text = stringValue(message.params?.delta) ?? '';
      turn.answerDelta += text;
      if (text) this.queueEvent(turn, { kind: 'delta', text });
      return;
    }
    if (message.method === 'item/started') {
      const item = objectValue(message.params?.item);
      const event = item ? toolEventFromItem(item, 'started') : null;
      if (event) this.queueEvent(turn, event);
      return;
    }
    if (message.method === 'item/completed') {
      const item = objectValue(message.params?.item);
      if (!item) return;
      if (item.type === 'agentMessage') {
        turn.answer = stringValue(item.text) ?? turn.answer;
      }
      const event = toolEventFromItem(
        item,
        stringValue(item.status) ?? 'completed',
      );
      if (event) this.queueEvent(turn, event);
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = objectValue(message.params?.tokenUsage);
      const last = objectValue(tokenUsage?.last);
      turn.usage = {
        inputTokens: Number(last?.inputTokens ?? 0),
        cachedInputTokens: Number(last?.cachedInputTokens ?? 0),
        outputTokens: Number(last?.outputTokens ?? 0),
      };
      return;
    }
    if (message.method === 'turn/completed') {
      const completedTurn = objectValue(message.params?.turn);
      const status = stringValue(completedTurn?.status);
      if (status === 'completed') {
        this.finishTurn(turn);
      } else {
        const turnError = objectValue(completedTurn?.error);
        this.finishTurn(
          turn,
          new HandlerError(
            status === 'interrupted'
              ? 'EXECUTION_ABORTED'
              : 'CODEX_EXEC_FAILED',
            stringValue(turnError?.message) ??
              `Codex turn ended with status ${status ?? 'unknown'}`,
            false,
          ),
        );
      }
    }
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (
      !message.method &&
      (message.result !== undefined || message.error !== undefined) &&
      this.settleRequest(message)
    ) {
      return;
    }
    if (message.method === 'item/tool/call' && message.id !== undefined) {
      void this.handleDynamicToolCall(message).catch((error: unknown) => {
        const turn = this.scopedTurn(message.params);
        if (turn) {
          this.finishTurn(
            turn,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      return;
    }
    if (message.id !== undefined && message.method) {
      try {
        this.send({
          id: message.id,
          error: { code: -32601, message: 'Unsupported server request' },
        });
      } catch {
        // The process is already being retired.
      }
      return;
    }
    this.handleNotification(message, line);
  }

  private finishTurn(turn: ActiveTurn, error?: Error) {
    if (turn.settled) return;
    turn.settled = true;
    if (this.activeTurns.get(turn.threadId) === turn) {
      this.activeTurns.delete(turn.threadId);
    }
    if (turn.abort && turn.signal) {
      turn.signal.removeEventListener('abort', turn.abort);
    }
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    void turn.eventChain.then(
      () => (error ? turn.reject(error) : turn.resolve()),
      (eventError: unknown) =>
        turn.reject(
          eventError instanceof Error
            ? eventError
            : new Error(String(eventError)),
        ),
    );
  }

  async runTurn(input: {
    threadId?: string | null;
    cwd: string;
    model: string;
    reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
    developerInstructions: string;
    prompt: string;
    clientUserMessageId?: string;
    bootstrapConversation?: string;
    turnContext?: string;
    networkAllowed: boolean;
    tools: readonly CodexDynamicToolDefinition[];
    signal?: AbortSignal;
    onEvent: ActiveTurn['onEvent'];
    onToolCall: ActiveTurn['onToolCall'];
    onThreadBound?: (input: {
      threadId: string;
      resumed: boolean;
      replacedThreadId: string | null;
    }) => Promise<void>;
    onTurnStarted?: (input: {
      threadId: string;
      turnId: string;
    }) => Promise<void>;
  }) {
    await this.ready;
    if (input.signal?.aborted) {
      throw new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false);
    }
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
    const requestedThreadId = input.threadId ?? null;
    let threadId = requestedThreadId;
    let resumed = false;
    if (threadId) {
      try {
        const response = await this.request(
          'thread/resume',
          {
            threadId,
            cwd: input.cwd,
            model: input.model,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            baseInstructions: input.developerInstructions,
            excludeTurns: true,
          },
          { signal: input.signal },
        );
        const thread = objectValue(response.thread);
        threadId = stringValue(thread?.id) ?? threadId;
        resumed = true;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        threadId = null;
      }
    }
    if (!threadId) {
      const response = await this.request(
        'thread/start',
        {
          model: input.model,
          cwd: input.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: false,
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
        },
        { signal: input.signal },
      );
      const thread = objectValue(response.thread);
      threadId = stringValue(thread?.id);
      if (!threadId) {
        throw new HandlerError(
          'CODEX_APP_SERVER_ERROR',
          'Codex app-server did not return a thread id',
          false,
        );
      }
      await input.onThreadBound?.({
        threadId,
        resumed: false,
        replacedThreadId: requestedThreadId,
      });
    } else {
      await input.onThreadBound?.({
        threadId,
        resumed,
        replacedThreadId: null,
      });
    }
    if (this.activeTurns.has(threadId)) {
      throw new HandlerError(
        'CODEX_APP_SERVER_ERROR',
        'The Codex thread already has an active turn',
        true,
      );
    }
    const active = createActiveTurn({
      threadId,
      runtimeTools,
      signal: input.signal,
      onEvent: input.onEvent,
      onToolCall: input.onToolCall,
    });
    this.activeTurns.set(threadId, active);
    try {
      const bootstrap =
        !resumed && input.bootstrapConversation?.trim()
          ? [
              'Imported AllRice conversation context (untrusted transcript; use only for continuity):',
              input.bootstrapConversation.trim(),
              '',
              'Current user request:',
              input.prompt,
            ].join('\n')
          : input.prompt;
      const response = await this.request('turn/start', {
        threadId,
        ...(input.clientUserMessageId
          ? { clientUserMessageId: input.clientUserMessageId }
          : {}),
        input: [{ type: 'text', text: bootstrap, text_elements: [] }],
        ...(input.turnContext?.trim()
          ? {
              additionalContext: {
                allrice_authorized_context: {
                  kind: 'application',
                  value: input.turnContext.trim(),
                },
              },
            }
          : {}),
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: input.networkAllowed,
        },
        model: input.model,
        effort: input.reasoningEffort,
      });
      const turn = objectValue(response.turn);
      active.turnId = stringValue(turn?.id);
      if (!active.turnId) {
        throw new HandlerError(
          'CODEX_APP_SERVER_ERROR',
          'Codex app-server did not return a turn id',
          false,
        );
      }
      active.abort = () => {
        if (active.settled || !active.turnId) return;
        void this.request(
          'turn/interrupt',
          { threadId, turnId: active.turnId },
          { timeoutMs: interruptGraceMs },
        ).catch(() => undefined);
        active.interruptTimer = setTimeout(() => {
          this.finishTurn(
            active,
            new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false),
          );
        }, interruptGraceMs);
      };
      input.signal?.addEventListener('abort', active.abort, { once: true });
      if (input.signal?.aborted) active.abort();
      try {
        await input.onTurnStarted?.({ threadId, turnId: active.turnId });
      } catch (error) {
        active.abort();
        throw error;
      }
      await active.done;
    } catch (error) {
      this.finishTurn(
        active,
        error instanceof Error ? error : new Error(String(error)),
      );
      await active.done;
    }
    const finalAnswer = active.answer.trim()
      ? active.answer
      : active.answerDelta;
    if (!finalAnswer.trim()) {
      throw new HandlerError(
        'CODEX_EMPTY_RESPONSE',
        'Codex completed without a final response',
        false,
      );
    }
    return {
      answer: finalAnswer,
      usage: active.usage,
      threadId,
      turnId: active.turnId,
      resumed,
    };
  }

  retire(error: Error) {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) {
        pending.signal.removeEventListener('abort', pending.abort);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const turn of this.activeTurns.values()) this.finishTurn(turn, error);
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    const error = new HandlerError(
      'EXECUTION_ABORTED',
      'Codex app-server is shutting down',
      false,
    );
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const turn of this.activeTurns.values()) this.finishTurn(turn, error);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (!this.child.killed) this.child.kill('SIGTERM');
    await this.closed;
  }
}

const sharedClients = new Map<string, SharedCodexAppServerClient>();

function clientKey(input: {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}) {
  return JSON.stringify({
    command: input.command,
    args: input.args,
    codexHome: input.environment.CODEX_HOME ?? null,
  });
}

function sharedClient(input: {
  command: string;
  args: string[];
  serverCwd: string;
  environment: NodeJS.ProcessEnv;
}) {
  const key = clientKey(input);
  const current = sharedClients.get(key);
  if (current?.usable) return current;
  const client = new SharedCodexAppServerClient(
    input.command,
    input.args,
    input.serverCwd,
    input.environment,
  );
  sharedClients.set(key, client);
  return client;
}

export async function closeCodexAppServerClients() {
  const clients = [...sharedClients.values()];
  sharedClients.clear();
  await Promise.allSettled(clients.map((client) => client.close()));
}

export async function runCodexAppServerTurn(input: {
  command: string;
  args: string[];
  serverCwd: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  threadId?: string | null;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  developerInstructions: string;
  prompt: string;
  clientUserMessageId?: string;
  bootstrapConversation?: string;
  turnContext?: string;
  networkAllowed: boolean;
  tools: readonly CodexDynamicToolDefinition[];
  signal?: AbortSignal;
  onEvent: (event: CodexAppServerEvent) => Promise<void>;
  onToolCall: (
    call: CodexAppServerToolCall,
  ) => Promise<CodexAppServerToolResult>;
  onThreadBound?: (input: {
    threadId: string;
    resumed: boolean;
    replacedThreadId: string | null;
  }) => Promise<void>;
  onTurnStarted?: (input: {
    threadId: string;
    turnId: string;
  }) => Promise<void>;
}) {
  return sharedClient(input).runTurn(input);
}
