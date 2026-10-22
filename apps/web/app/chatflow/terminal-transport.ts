'use client';

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote';
import type { TerminalCreateRequest } from '@deepseek-ai/dsh-api-terminal-controller/types';
import {
  WorkbenchTerminalServerFrameSchema,
  TerminalNativeFrameSchema,
  terminalMaximumPending,
  terminalMaximumScreenBytes,
  workbenchTerminalStreamProtocol,
  workbenchTerminalSocketPath,
  type TerminalInput,
  type TerminalRequest,
  type TerminalTarget,
  type TerminalStreamMode,
  type WorkbenchTerminalBrowserFrame,
} from '@allrice/contracts';

export type TerminalIdentity = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
};
export type TerminalPin = { deviceId: string; grantId: string };
type RemoteResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: Error & { code: string; details?: unknown } };
type NativeFrame = ReturnType<typeof TerminalNativeFrameSchema.parse>;
const maximumBufferedFrames = 4096;
type Pending = {
  result?: (result: RemoteResult) => void;
  next?: (result: IteratorResult<NativeFrame>) => void;
  reject?: (error: Error) => void;
  error?: Error;
  ended?: boolean;
  mode?: TerminalStreamMode;
  inbox?: Array<{ frame: NativeFrame; bytes: number }>;
  fragments?: { total: number; parts: string[]; bytes: number };
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

function remoteError(value: {
  code: string;
  message: string;
  details?: unknown;
}) {
  return Object.assign(new Error(value.message), value, {
    isDSHRemoteError: true,
  });
}

/** AllRice owns authentication and this carrier. The official DSH model owns
 * input ordering, acknowledgements, process identity and reconnect semantics.
 * Push streams use the native gateway's local-inbox semantics. Legacy peers
 * retain their one-item credits. Input and RPC are never replayed. */
export class TerminalCarrier {
  readonly generation = createSnapshotStore<
    { id: number; host: { home: string } } | undefined
  >(undefined);
  readonly state = createSnapshotStore<{
    phase: 'connecting' | 'connected' | 'disconnected' | 'ended';
    target?: TerminalTarget;
    deviceName?: string;
    error?: string;
  }>({ phase: 'connecting' });
  readonly remote: TerminalRemote;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private revision = 0;
  private ended = false;
  private streamMode: TerminalStreamMode = 'pull';
  private bufferedBytes = 0;
  private bufferedFrames = 0;
  onReset?: () => void;

  constructor(
    readonly identity: TerminalIdentity,
    readonly pin: TerminalPin,
    private readonly createCarrierError: (message: string) => Error,
  ) {
    const check = (sessionId: string) => sessionId === identity.sessionId;
    const missing = () => ({
      ok: false as const,
      error: remoteError({
        code: 'session/not-found',
        message: '终端会话不属于当前工作区',
      }),
    });
    const call = (
      sessionId: string,
      action: TerminalRequest['action'],
      args: unknown,
      signal?: AbortSignal,
    ) =>
      check(sessionId)
        ? this.call(action, args, signal)
        : Promise.resolve(missing());
    const stream = (
      sessionId: string,
      action: 'attach' | 'retain',
      id: string,
      signal: AbortSignal,
    ) => {
      if (!check(sessionId)) throw missing().error;
      return this.stream(action, id, signal);
    };
    this.remote = {
      environment: (sessionId: string, signal?: AbortSignal) =>
        call(sessionId, 'environment', {}, signal),
      shells: (sessionId: string, signal?: AbortSignal) =>
        call(sessionId, 'shells', {}, signal),
      list: (sessionId: string) => call(sessionId, 'list', {}),
      create: (
        sessionId: string,
        request: TerminalCreateRequest,
        signal?: AbortSignal,
      ) => call(sessionId, 'create', { request }, signal),
      rename: (sessionId: string, id: string, title: string) =>
        call(sessionId, 'rename', { id, title }),
      close: (sessionId: string, id: string) =>
        call(sessionId, 'close', { id }),
      attach: (
        sessionId: string,
        id: string,
        signal: AbortSignal = new AbortController().signal,
      ) => stream(sessionId, 'attach', id, signal),
      retain: (
        sessionId: string,
        id: string,
        signal: AbortSignal = new AbortController().signal,
      ) => stream(sessionId, 'retain', id, signal),
    } as unknown as TerminalRemote;
    this.connect();
  }

  private connect() {
    if (this.ended) return;
    const query = new URLSearchParams({
      organizationId: this.identity.organizationId,
      workspaceId: this.identity.workspaceId,
      sessionId: this.identity.sessionId,
      deviceId: this.pin.deviceId,
      grantId: this.pin.grantId,
    });
    const url = new URL(
      `${workbenchTerminalSocketPath}?${query}`,
      location.href,
    );
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, workbenchTerminalStreamProtocol);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.ended) return;
      try {
        if (typeof event.data !== 'string') throw Error('终端传输格式无效');
        const frame = WorkbenchTerminalServerFrameSchema.parse(
          JSON.parse(event.data),
        );
        if (frame.type === 'terminal.ready') {
          if (
            frame.target.organizationId !== this.identity.organizationId ||
            frame.target.workspaceId !== this.identity.workspaceId ||
            frame.target.ownerId !== this.identity.ownerId ||
            frame.target.sessionId !== this.identity.sessionId ||
            frame.target.deviceId !== this.pin.deviceId ||
            frame.target.grantId !== this.pin.grantId
          )
            throw Error('终端连接目标不匹配');
          this.attempt = 0;
          this.streamMode = frame.streamMode ?? 'pull';
          this.state.set({
            phase: 'connected',
            target: frame.target,
            deviceName: frame.deviceName,
          });
          this.generation.set({ id: ++this.revision, host: { home: '' } });
          this.onReset?.();
          for (const waiter of this.waiters) waiter.resolve();
          this.waiters.clear();
          return;
        }
        if (frame.type === 'terminal.ended') {
          this.end(frame.error?.message ?? '终端连接已结束');
          return;
        }
        const item = this.pending.get(frame.requestId);
        if (!item) return;
        if (frame.type === 'terminal.result') {
          if (item.result) {
            item.result(
              frame.result.ok
                ? frame.result
                : { ok: false, error: remoteError(frame.result.error) },
            );
            this.clear(frame.requestId);
          } else {
            item.ended = true;
            item.error = frame.result.ok
              ? Error('终端流返回了错误的响应类型')
              : remoteError(frame.result.error);
            item.reject?.(item.error);
            item.next = undefined;
            item.reject = undefined;
            this.clear(frame.requestId);
          }
        } else if (frame.type === 'terminal.finished') {
          if (item.fragments) throw Error('终端屏幕分片未完成');
          item.ended = true;
          if (frame.error) item.error = remoteError(frame.error);
          if (item.next) {
            if (item.error) item.reject?.(item.error);
            else item.next({ done: true, value: undefined });
            item.next = undefined;
            item.reject = undefined;
            this.clear(frame.requestId);
          }
        } else if (frame.type === 'terminal.fragment') {
          const fragments = (item.fragments ??= {
            total: frame.total,
            parts: [],
            bytes: 0,
          });
          if (
            (!item.next && item.mode !== 'push') ||
            !item.inbox ||
            fragments.total !== frame.total ||
            fragments.parts.length !== frame.index
          )
            throw Error('终端屏幕分片顺序无效');
          const bytes = new TextEncoder().encode(frame.data).byteLength;
          if (this.bufferedBytes + bytes > terminalMaximumScreenBytes)
            throw Error('终端屏幕超出传输上限');
          fragments.bytes += bytes;
          this.bufferedBytes += bytes;
          fragments.parts.push(frame.data);
          if (fragments.parts.length === fragments.total) {
            // Replace the fragment reservation with the decoded native item;
            // do not charge both representations to the inbox.
            this.bufferedBytes -= fragments.bytes;
            item.fragments = undefined;
            this.deliver(
              item,
              TerminalNativeFrameSchema.parse(
                JSON.parse(fragments.parts.join('')),
              ),
            );
          }
        } else if (frame.type === 'terminal.frame') {
          if (item.fragments) throw Error('终端屏幕分片未完成');
          this.deliver(item, frame.frame);
        }
      } catch (error) {
        this.end(error instanceof Error ? error.message : '终端传输失败');
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket || this.ended) return;
      if ([1008, 4001, 4003, 4401, 4403].includes(event.code)) {
        this.end('终端连接未获授权，请检查账号和电脑连接');
        return;
      }
      this.generation.set(undefined);
      this.state.set({
        ...this.state.getSnapshot(),
        phase: 'disconnected',
      });
      this.failPending(this.carrierError('Bridge 连接已断开'));
      const wait = Math.min(1000 * 2 ** this.attempt++, 15000);
      this.reconnect = setTimeout(() => this.connect(), wait);
    });
  }

  private deliver(item: Pending, frame: NativeFrame) {
    if (!item.inbox || item.ended) throw Error('终端流状态无效');
    if (!item.next) {
      if (item.mode !== 'push') throw Error('终端未请求的屏幕数据');
      const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
      if (
        this.bufferedBytes + bytes > terminalMaximumScreenBytes ||
        this.bufferedFrames >= maximumBufferedFrames
      )
        throw Error('终端屏幕缓冲区已满');
      item.inbox.push({ frame, bytes });
      this.bufferedBytes += bytes;
      this.bufferedFrames++;
      return;
    }
    const next = item.next;
    item.next = undefined;
    item.reject = undefined;
    next({ done: false, value: frame });
  }

  private carrierError(message: string) {
    return this.createCarrierError(message);
  }

  private async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.ended)
      throw Error(this.state.getSnapshot().error ?? '终端连接已结束');
    if (this.generation.getSnapshot() !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: finish, reject: fail };
      const abort = () => fail(Error('终端请求已取消'));
      const timer = setTimeout(
        () => fail(Error('连接电脑超时，请检查 Bridge')),
        20000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
      };
      function finish() {
        cleanup();
        resolve();
      }
      function fail(error: Error) {
        cleanup();
        reject(error);
      }
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private send(frame: WorkbenchTerminalBrowserFrame) {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.generation.getSnapshot() === undefined
    )
      throw this.carrierError('终端连接不可用');
    const payload = JSON.stringify(frame);
    if (
      this.socket.bufferedAmount +
        new TextEncoder().encode(payload).byteLength >
      terminalMaximumScreenBytes
    )
      throw Error('终端输入缓冲区已满');
    this.socket.send(payload);
  }

  private clear(id: string) {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    if (item.timer) clearTimeout(item.timer);
    item.abort();
    this.discardInbox(item);
  }

  private discardInbox(item: Pending) {
    for (const entry of item.inbox ?? []) {
      this.bufferedBytes -= entry.bytes;
      this.bufferedFrames--;
    }
    if (item.inbox) item.inbox.length = 0;
    this.bufferedBytes -= item.fragments?.bytes ?? 0;
    item.fragments = undefined;
  }

  private async call(
    action: TerminalRequest['action'],
    args: unknown,
    signal?: AbortSignal,
  ): Promise<RemoteResult> {
    try {
      await this.ready(signal);
      if (this.pending.size >= terminalMaximumPending)
        throw Error('终端请求过多，请稍后重试');
      const requestId = crypto.randomUUID();
      return await new Promise<RemoteResult>((resolve) => {
        const cancel = () => {
          if (!this.pending.has(requestId)) return;
          try {
            this.send({ version: 1, type: 'terminal.cancel', requestId });
          } catch {
            /* disconnected: no replay */
          }
          this.clear(requestId);
          resolve({
            ok: false,
            error: remoteError({
              code: 'gateway/cancelled',
              message: '终端请求已取消',
            }),
          });
        };
        const item: Pending = {
          result: resolve,
          abort: () => signal?.removeEventListener('abort', cancel),
          timer: setTimeout(cancel, action === 'close' ? 30000 : 20000),
        };
        this.pending.set(requestId, item);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          this.send({
            version: 1,
            type: 'terminal.request',
            requestId,
            action,
            args,
          });
        } catch (error) {
          this.clear(requestId);
          resolve({
            ok: false,
            error: remoteError({
              code: 'gateway/internal',
              message: error instanceof Error ? error.message : '终端请求失败',
            }),
          });
        }
      });
    } catch (error) {
      return {
        ok: false,
        error: remoteError({
          code: signal?.aborted ? 'gateway/cancelled' : 'gateway/internal',
          message: error instanceof Error ? error.message : '终端连接失败',
        }),
      };
    }
  }

  private stream(action: 'attach' | 'retain', id: string, signal: AbortSignal) {
    const requestId = crypto.randomUUID();
    const item: Pending = {
      inbox: [],
      abort: () => signal.removeEventListener('abort', cancel),
    };
    let opened = false;
    const cancel = () => {
      if (this.pending.has(requestId)) {
        try {
          this.send({ version: 1, type: 'terminal.cancel', requestId });
        } catch {
          /* detach never replays */
        }
      }
      item.ended = true;
      item.next?.({ done: true, value: undefined });
      item.next = undefined;
      item.reject = undefined;
      this.clear(requestId);
      this.discardInbox(item);
    };
    const iterator: AsyncIterableIterator<NativeFrame> & {
      send(input: TerminalInput): void;
    } = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        signal.throwIfAborted();
        const entry = item.inbox?.shift();
        if (entry) {
          this.bufferedBytes -= entry.bytes;
          this.bufferedFrames--;
          return { done: false, value: entry.frame };
        }
        if (item.error) {
          this.clear(requestId);
          throw item.error;
        }
        if (item.ended) {
          this.clear(requestId);
          return { done: true, value: undefined };
        }
        if (!opened) {
          await this.ready(signal);
          signal.throwIfAborted();
          if (item.ended) return { done: true, value: undefined };
          if (!opened) {
            if (this.pending.size >= terminalMaximumPending)
              throw Error('终端连接过多');
            opened = true;
            item.mode = this.streamMode;
            this.pending.set(requestId, item);
            signal.addEventListener('abort', cancel, { once: true });
            this.send({
              version: 1,
              type: 'terminal.request',
              requestId,
              action,
              args: { id },
            });
          }
        }
        if (item.next) throw Error('终端流不能并发读取');
        return await new Promise<IteratorResult<NativeFrame>>(
          (resolve, reject) => {
            item.next = resolve;
            item.reject = reject;
            try {
              if (item.mode === 'pull')
                this.send({ version: 1, type: 'terminal.next', requestId });
            } catch (error) {
              item.next = undefined;
              item.reject = undefined;
              reject(error);
            }
          },
        );
      },
      return: async () => {
        cancel();
        return { done: true, value: undefined };
      },
      send: (input) => {
        if (item.ended || item.error || !this.pending.has(requestId))
          throw this.carrierError('终端流已结束');
        this.send({ version: 1, type: 'terminal.input', requestId, input });
      },
    };
    return iterator;
  }

  private failPending(error: Error) {
    for (const [id, item] of this.pending) {
      item.error = error;
      item.result?.({
        ok: false,
        error: remoteError({
          code: 'gateway/internal',
          message: error.message,
        }),
      });
      item.reject?.(error);
      item.next = undefined;
      item.reject = undefined;
      this.clear(id);
    }
  }

  private end(message: string) {
    this.ended = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.generation.set(undefined);
    this.state.set({
      ...this.state.getSnapshot(),
      phase: 'ended',
      error: message,
    });
    this.failPending(Error(message));
    for (const waiter of this.waiters) waiter.reject(Error(message));
    this.waiters.clear();
    this.socket?.close();
  }

  dispose() {
    this.end('终端页面已退出');
  }
}
