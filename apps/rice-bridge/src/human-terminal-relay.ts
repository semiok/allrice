import {
  BridgeTerminalServerFrameSchema,
  TerminalNativeFrameSchema,
  terminalMaximumPending,
  terminalMaximumScreenBytes,
  terminalRpcArguments,
  type BridgeTerminalClientFrame,
  type BridgeTerminalServerFrame,
  type TerminalInput,
} from '@allrice/contracts';
import {
  type HumanTerminalHost,
  isHumanTerminalAuthorityUnknown,
  type HumanTerminalOwner,
} from './human-terminal-host.js';

type Send = (frame: BridgeTerminalClientFrame) => Promise<boolean>;
type Failure = NonNullable<
  Extract<BridgeTerminalClientFrame, { type: 'terminal.finished' }>['error']
>;
type Request = {
  readonly id: string;
  readonly action: string;
  readonly abort: AbortController;
  readonly input: TerminalInputQueue;
  readonly ready: Promise<void>;
  readonly markReady: () => void;
  iterator?: AsyncIterator<unknown>;
  nextPending: boolean;
  finished: boolean;
};
type Channel = {
  readonly id: string;
  readonly target: Extract<
    BridgeTerminalServerFrame,
    { type: 'terminal.open' }
  >['target'];
  readonly send: Send;
  readonly abort: AbortController;
  readonly owner: Promise<HumanTerminalOwner>;
  readonly requests: Map<string, Request>;
  readonly seen: Set<string>;
  opened: boolean;
  ended: boolean;
  inputBytes: number;
  admission: Promise<void>;
};

/** A typed carrier only. It never allocates PTYs, parses shell output, rewrites
 * control bytes or replays commands. Each downstream credit pulls one item
 * from the original DSH iterator, preserving native output backpressure. */
export class HumanTerminalRelay {
  private readonly channels = new Map<string, Channel>();
  private closed = false;
  private validation: Promise<void> | null = null;

  constructor(private readonly host: HumanTerminalHost) {}

  receive(value: BridgeTerminalServerFrame, send: Send) {
    const frame = BridgeTerminalServerFrameSchema.parse(value);
    void this.dispatch(frame, send)
      .catch(async (error: unknown) => {
        const channel = this.channels.get(frame.id);
        if (channel) await this.end(channel, false, failure(error));
        else
          await send({
            version: 1,
            type: 'terminal.ended',
            id: frame.id,
            error: failure(error),
          });
      })
      .catch(() => {});
  }

  /** Physical WSS loss detaches streams; native terminal processes are retained.
   * Credential changes, explicit Bridge stop and authenticated revocation use
   * dispose/revoke instead. */
  async disconnect() {
    await Promise.all(
      [...this.channels.values()].map((channel) => this.end(channel)),
    );
  }

  revalidate() {
    return (this.validation ??= this.host.revalidate().finally(() => {
      this.validation = null;
    }));
  }

  async dispose() {
    this.closed = true;
    await this.disconnect();
    await this.validation;
    await this.host.dispose();
  }

  private async dispatch(frame: BridgeTerminalServerFrame, send: Send) {
    if (this.closed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
    if (frame.type === 'terminal.open') {
      if (this.channels.has(frame.id))
        throw Error('HUMAN_TERMINAL_DUPLICATE_CHANNEL');
      if (this.channels.size >= 8)
        throw Error('HUMAN_TERMINAL_CHANNEL_LIMIT_REACHED');
      const channel: Channel = {
        id: frame.id,
        target: frame.target,
        send,
        abort: new AbortController(),
        owner: this.host.acquire(frame.target),
        requests: new Map(),
        seen: new Set(),
        opened: false,
        ended: false,
        inputBytes: 0,
        admission: Promise.resolve(),
      };
      this.channels.set(channel.id, channel);
      await channel.owner;
      if (channel.ended) return;
      channel.opened = true;
      await this.emit(channel, {
        version: 1,
        type: 'terminal.ready',
        id: channel.id,
      });
      return;
    }
    const channel = this.channels.get(frame.id);
    if (!channel || channel.ended)
      throw Error('HUMAN_TERMINAL_CHANNEL_UNAVAILABLE');
    if (frame.type === 'terminal.end') {
      await this.end(channel, frame.revoke === true);
      return;
    }
    if (!channel.opened) throw Error('HUMAN_TERMINAL_CHANNEL_UNAVAILABLE');
    // Filesystem validation is asynchronous. Preserve physical WS admission
    // order without waiting for a long-lived stream's next item or an RPC.
    channel.admission = channel.admission.then(() =>
      this.admit(channel, frame),
    );
    await channel.admission;
  }

  private async admit(
    channel: Channel,
    frame: Exclude<
      BridgeTerminalServerFrame,
      { type: 'terminal.open' | 'terminal.end' }
    >,
  ) {
    if (channel.ended) return;
    // Local grants may change while a physical connection remains healthy.
    try {
      await this.host.validate(channel.target);
    } catch (error) {
      await this.end(
        channel,
        !isHumanTerminalAuthorityUnknown(error),
        failure(error),
      );
      return;
    }
    if (channel.ended) return;
    if (frame.type === 'terminal.request') {
      if (channel.seen.has(frame.requestId))
        throw Error('HUMAN_TERMINAL_DUPLICATE_REQUEST');
      if (
        channel.seen.size >= 4096 ||
        channel.requests.size >= terminalMaximumPending
      )
        throw Error('HUMAN_TERMINAL_REQUEST_LIMIT_REACHED');
      channel.seen.add(frame.requestId);
      let markReady!: () => void;
      const request: Request = {
        id: frame.requestId,
        action: frame.action,
        abort: new AbortController(),
        input: new TerminalInputQueue(
          inputOverhead(channel.id, frame.requestId),
          (delta) => {
            channel.inputBytes += delta;
          },
          () => channel.inputBytes,
        ),
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
        markReady: () => markReady(),
        nextPending: false,
        finished: false,
      };
      channel.requests.set(request.id, request);
      void this.start(channel, request, frame).catch((error: unknown) =>
        this.end(channel, false, failure(error)).catch(() => {}),
      );
      return;
    }
    const request = channel.requests.get(frame.requestId);
    // Late cancellation/credit/input cannot resurrect an old request or shell.
    if (!request || request.finished) return;
    if (frame.type === 'terminal.cancel') {
      await this.finish(channel, request);
    } else if (frame.type === 'terminal.input') {
      if (request.action !== 'attach')
        throw Error('HUMAN_TERMINAL_INPUT_UNAVAILABLE');
      request.input.push(frame.input);
    } else if (frame.type === 'terminal.next') {
      if (request.action !== 'attach' && request.action !== 'retain')
        throw Error('HUMAN_TERMINAL_STREAM_UNAVAILABLE');
      if (request.nextPending) throw Error('HUMAN_TERMINAL_DUPLICATE_CREDIT');
      request.nextPending = true;
      void this.pull(channel, request);
    }
  }

  private async pull(channel: Channel, request: Request) {
    try {
      await request.ready;
      if (request.finished || channel.ended) return;
      const next = await request.iterator!.next();
      if (request.finished || channel.ended) return;
      if (next.done) await this.finish(channel, request);
      else await this.emitNative(channel, request, next.value);
    } catch (error) {
      await this.finish(channel, request, failure(error)).catch(() => {});
    } finally {
      request.nextPending = false;
    }
  }

  private async start(
    channel: Channel,
    request: Request,
    frame: Extract<BridgeTerminalServerFrame, { type: 'terminal.request' }>,
  ) {
    const streaming = frame.action === 'attach' || frame.action === 'retain';
    try {
      const owner = await channel.owner;
      const args = terminalRpcArguments[frame.action].parse(frame.args);
      const signal = AbortSignal.any([
        request.abort.signal,
        channel.abort.signal,
      ]);
      signal.throwIfAborted();
      if (frame.action === 'attach' || frame.action === 'retain') {
        const stream = owner.stream(
          frame.action,
          (args as { id: string }).id,
          signal,
          request.input,
          {
            maxBytes: inputMaximumBytes,
            frameOverheadBytes: request.input.overhead,
          },
        );
        request.iterator = stream[Symbol.asyncIterator]();
      } else {
        const value = await owner.call(frame.action, args, signal);
        if (!request.finished && !channel.ended)
          await this.emit(channel, {
            version: 1,
            type: 'terminal.result',
            id: channel.id,
            requestId: request.id,
            result: { ok: true, value },
          });
        await this.finish(channel, request, undefined, false);
      }
    } catch (error) {
      if (!request.finished && !channel.ended && !streaming)
        await this.emit(channel, {
          version: 1,
          type: 'terminal.result',
          id: channel.id,
          requestId: request.id,
          result: { ok: false, error: failure(error) },
        });
      await this.finish(
        channel,
        request,
        streaming ? failure(error) : undefined,
        streaming,
      );
    } finally {
      request.markReady();
    }
  }

  private async emitNative(channel: Channel, request: Request, value: unknown) {
    const frame = TerminalNativeFrameSchema.parse(value);
    const json = JSON.stringify(frame);
    if (Buffer.byteLength(json) > terminalMaximumScreenBytes)
      throw Error('HUMAN_TERMINAL_SCREEN_LIMIT_REACHED');
    if (Buffer.byteLength(json) <= 500_000) {
      await this.emit(channel, {
        version: 1,
        type: 'terminal.frame',
        id: channel.id,
        requestId: request.id,
        frame,
      });
      return;
    }
    const parts: string[] = [];
    for (let start = 0; start < json.length;) {
      let end = Math.min(start + 131_072, json.length);
      // Keep surrogate pairs together so per-fragment UTF-8 accounting equals
      // the complete native JSON, including at the exact 2 MiB boundary.
      const previous = json.charCodeAt(end - 1);
      const next = json.charCodeAt(end);
      if (
        end < json.length &&
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      )
        end--;
      parts.push(json.slice(start, end));
      start = end;
    }
    const total = parts.length;
    for (let index = 0; index < total; index++) {
      if (request.finished || channel.ended) return;
      await this.emit(channel, {
        version: 1,
        type: 'terminal.fragment',
        id: channel.id,
        requestId: request.id,
        index,
        total,
        data: parts[index]!,
      });
    }
  }

  private async finish(
    channel: Channel,
    request: Request,
    error?: Failure,
    notify = true,
  ) {
    if (request.finished) return;
    request.finished = true;
    request.abort.abort(error);
    await request.input.return();
    await request.iterator?.return?.();
    if (channel.requests.get(request.id) === request)
      channel.requests.delete(request.id);
    if (!channel.ended && notify)
      await this.emit(channel, {
        version: 1,
        type: 'terminal.finished',
        id: channel.id,
        requestId: request.id,
        ...(error ? { error } : {}),
      });
  }

  private async end(channel: Channel, revoke = false, error?: Failure) {
    if (channel.ended) return;
    channel.ended = true;
    this.channels.delete(channel.id);
    channel.abort.abort(error);
    const results = await Promise.allSettled(
      [...channel.requests.values()].map((request) =>
        this.finish(channel, request, undefined, false),
      ),
    );
    const owner = await channel.owner.catch(() => null);
    if (owner) await this.host.release(owner, revoke);
    const cleanupFailure = results.find(
      (result) => result.status === 'rejected',
    );
    await channel.send({
      version: 1,
      type: 'terminal.ended',
      id: channel.id,
      ...(error || cleanupFailure
        ? {
            error:
              error ??
              failure(
                cleanupFailure?.status === 'rejected'
                  ? cleanupFailure.reason
                  : undefined,
              ),
          }
        : {}),
    });
  }

  private async emit(channel: Channel, frame: BridgeTerminalClientFrame) {
    if (channel.ended || !(await channel.send(frame))) {
      void this.end(channel).catch(() => {});
      throw Error('HUMAN_TERMINAL_CARRIER_CLOSED');
    }
  }
}

const inputMaximumBytes = 262_144;
function inputOverhead(id: string, requestId: string) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        version: 1,
        type: 'terminal.input',
        id,
        requestId,
        input: 0,
      }),
    ) - 1
  );
}

/** Bounded single-consumer invocation uplink. Native DSH owns sequence checks
 * and provider ACKs; this queue accounts only for the carrier's encoded bytes. */
class TerminalInputQueue implements AsyncIterableIterator<TerminalInput> {
  private readonly queue: { value: TerminalInput; bytes: number }[] = [];
  private bytes = 0;
  private closed = false;
  private waiting?: (item: IteratorResult<TerminalInput>) => void;

  constructor(
    readonly overhead: number,
    private readonly changed: (delta: number) => void,
    private readonly channelBytes: () => number,
  ) {}

  [Symbol.asyncIterator]() {
    return this;
  }

  push(value: TerminalInput) {
    if (this.closed) throw Error('HUMAN_TERMINAL_INPUT_CLOSED');
    const bytes = Buffer.byteLength(JSON.stringify(value)) + this.overhead;
    if (
      this.bytes + bytes > inputMaximumBytes ||
      this.channelBytes() + bytes > terminalMaximumScreenBytes
    )
      throw Error('HUMAN_TERMINAL_INPUT_LIMIT_REACHED');
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting({ done: false, value });
    } else {
      this.queue.push({ value, bytes });
      this.bytes += bytes;
      this.changed(bytes);
    }
  }

  next(): Promise<IteratorResult<TerminalInput>> {
    const item = this.queue.shift();
    if (item) {
      this.bytes -= item.bytes;
      this.changed(-item.bytes);
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    if (this.waiting)
      return Promise.reject(Error('HUMAN_TERMINAL_UPLINK_ALREADY_CONSUMED'));
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  return(): Promise<IteratorResult<TerminalInput>> {
    this.closed = true;
    this.queue.length = 0;
    this.changed(-this.bytes);
    this.bytes = 0;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
    return Promise.resolve({ done: true, value: undefined });
  }
}

function failure(error: unknown): Failure {
  if (
    error &&
    typeof error === 'object' &&
    'isDSHRemoteError' in error &&
    error.isDSHRemoteError === true &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return {
      code: error.code,
      message:
        error instanceof Error ? error.message.slice(0, 8192) : '终端连接失败',
      ...('details' in error &&
      error.details &&
      typeof error.details === 'object' &&
      !Array.isArray(error.details)
        ? { details: error.details as Record<string, unknown> }
        : {}),
    };
  return {
    code: 'terminal/unavailable',
    message:
      error instanceof Error ? error.message.slice(0, 8192) : '终端连接失败',
  };
}
