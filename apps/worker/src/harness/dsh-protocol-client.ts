import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { HandlerError } from '../errors.js';

export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface DshProtocolLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  requestTimeoutMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class DshProtocolClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(value: DshNotification) => void>();
  private readonly closed: Promise<void>;
  private requestId = 0;
  private closing = false;
  private terminalError: Error | null = null;

  constructor(private readonly launch: DshProtocolLaunch) {
    this.child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    // Drain stderr without surfacing it: an upstream runtime must never be
    // able to smuggle credential-bearing diagnostics into job errors.
    this.child.stderr.resume();
    this.closed = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.fail(
          new HandlerError(
            'DSH_RUNTIME_UNAVAILABLE',
            `DSH runtime could not start: ${error.message}`,
            true,
          ),
        );
      });
      this.child.once('close', (code, signal) => {
        if (!this.closing || this.pending.size > 0) {
          this.fail(
            new HandlerError(
              'DSH_RUNTIME_CLOSED',
              `DSH runtime closed (${signal ?? code ?? 'unknown'})`,
              !this.closing,
            ),
          );
        }
        resolve();
      });
    });
  }

  subscribe(listener: (value: DshNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(input: {
    cwd: string;
    provider: string;
    model: string;
    maxTokens?: number;
    expectedVersion?: string;
  }) {
    const { expectedVersion, ...params } = input;
    const result = await this.request('initialize', params);
    const serverInfo = record(result.serverInfo);
    if (
      serverInfo?.name !== 'deepseek-harness-sdk-runtime' ||
      typeof serverInfo.version !== 'string'
    ) {
      throw new HandlerError(
        'DSH_PROTOCOL_MISMATCH',
        'DSH runtime returned an incompatible server identity',
        false,
      );
    }
    if (
      expectedVersion &&
      serverInfo.version !== expectedVersion &&
      !serverInfo.version.startsWith(`${expectedVersion}-`)
    ) {
      throw new HandlerError(
        'DSH_VERSION_MISMATCH',
        `DSH runtime version ${serverInfo.version} does not match the approved AllRice distribution`,
        false,
      );
    }
    return { name: serverInfo.name, version: serverInfo.version };
  }

  async prompt(sessionId: string, text: string) {
    const result = await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
    if (typeof result.messageId !== 'string' || !result.messageId) {
      throw new HandlerError(
        'DSH_PROTOCOL_MISMATCH',
        'DSH runtime returned no durable prompt receipt',
        false,
      );
    }
    return result.messageId;
  }

  async interrupt(sessionId: string) {
    return this.request('session/interrupt', { sessionId }, 10_000);
  }

  async steer(sessionId: string, text: string) {
    return this.request('session/steer', { sessionId, text }, 10_000);
  }

  async compact(sessionId: string) {
    return this.request('session/compact', { sessionId });
  }

  async recover(sessionId: string) {
    return this.request('session/recover', { sessionId });
  }

  async closeSession(sessionId: string) {
    return this.request('session/close', { sessionId }, 10_000);
  }

  async providerStatus() {
    return this.request('provider/status', undefined, 10_000);
  }

  async authorizeCodex() {
    return this.request('provider/authorize-codex', undefined, 20 * 60_000);
  }

  async cancelCodexAuthorization() {
    return this.request('provider/cancel-codex', undefined, 10_000);
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    try {
      await this.request('shutdown', undefined, 2_000);
    } catch {
      // Shutdown is best-effort; process isolation remains authoritative.
    }
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, 2_000);
      timer.unref();
    }
    return this.closed;
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs = this.launch.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HandlerError(
            'DSH_REQUEST_TIMEOUT',
            `DSH ${method} request timed out`,
            true,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  private handleLine(line: string) {
    let frame: Record<string, unknown> | null = null;
    try {
      frame = record(JSON.parse(line));
    } catch {
      // Protocol stdout is reserved for JSON-RPC; one invalid line is fatal.
    }
    if (!frame) {
      this.fail(
        new HandlerError(
          'DSH_PROTOCOL_MISMATCH',
          'DSH runtime emitted malformed JSON-RPC',
          false,
        ),
      );
      return;
    }
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      const error = record(frame.error);
      if (error) {
        pending.reject(
          new HandlerError(
            'DSH_REQUEST_FAILED',
            typeof error.message === 'string'
              ? error.message
              : 'DSH runtime rejected the request',
            true,
          ),
        );
        return;
      }
      const result = record(frame.result);
      if (!result) {
        pending.reject(
          new HandlerError(
            'DSH_PROTOCOL_MISMATCH',
            'DSH runtime returned a malformed response',
            false,
          ),
        );
        return;
      }
      pending.resolve(result);
      return;
    }
    if (typeof frame.method === 'string') {
      const params = record(frame.params);
      if (!params) return;
      for (const listener of this.listeners) {
        listener({ method: frame.method, params });
      }
    }
  }

  private fail(error: Error) {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
