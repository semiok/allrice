import {
  BootstrapCoverageResultSchema,
  type BootstrapCoverageQuery,
  type BootstrapReceipt,
} from '@allrice/contracts';
import type { DshCloseObservationDetails } from '@allrice/database';
import type { SessionReferenceSnapshot } from '@allrice/contracts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import type {
  DshNativeSkillSnapshot,
  EmployeeRuntimeScene,
} from '@allrice/contracts';
import type { HarnessImageInput } from './adapter.js';

import { HandlerError } from '../errors.js';

export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | undefined;
}

export type DshInboundRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface DshProtocolLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  requestTimeoutMs: number;
  observeClose?: (details: DshCloseObservationDetails) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface DshRuntimeProcessState {
  state: 'running' | 'exited' | 'unknown';
  stdioClosed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** A spawned transport closed before any SDK/root initialization. This is not
 * a public SDK shutdown/dispose receipt and must never confirm a durable owner. */
export interface DshNeverCreatedCloseReceipt {
  version: 2;
  kind: 'never_created';
  initializeStarted: false;
  moduleLoadStarted: false;
  sdkCreated: false;
  rootCreated: false;
  priorFramesFlushed: true;
}

function neverCreatedCloseReceipt(
  value: Record<string, unknown> | null,
): DshNeverCreatedCloseReceipt | null {
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'initializeStarted,kind,moduleLoadStarted,priorFramesFlushed,rootCreated,sdkCreated,version' ||
    value.version !== 2 ||
    value.kind !== 'never_created' ||
    value.initializeStarted !== false ||
    value.moduleLoadStarted !== false ||
    value.sdkCreated !== false ||
    value.rootCreated !== false ||
    value.priorFramesFlushed !== true
  )
    return null;
  return Object.freeze({
    version: 2,
    kind: 'never_created',
    initializeStarted: false,
    moduleLoadStarted: false,
    sdkCreated: false,
    rootCreated: false,
    priorFramesFlushed: true,
  });
}

export interface DshRuntimeCloseEvidence {
  process: DshRuntimeProcessState;
  shutdownAcknowledged: boolean;
  wrapperCleanupConfirmed: boolean;
  /** Transport-only success; never an SDK/root public-close confirmation. */
  emptyTransportClosed?: boolean;
  emptyCloseReceipt?: DshNeverCreatedCloseReceipt | null;
  terminationAttempted: 'SIGTERM' | 'SIGKILL' | null;
}

export class DshRuntimeCloseError extends HandlerError {
  constructor(public readonly evidence: DshRuntimeCloseEvidence) {
    super(
      'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      'DSH runtime closure remains unconfirmed; process facts are retained',
      false,
    );
  }
}

export class DshProtocolClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(value: DshNotification) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly closed: Promise<void>;
  private inboundRequestHandler: DshInboundRequestHandler | null = null;
  private requestId = 0;
  private closing = false;
  private initializeStarted = false;
  private closeTask: Promise<void> | undefined;
  private processExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private stdioClosed = false;
  private closeEvidence: DshRuntimeCloseEvidence | null = null;
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
    this.child.stdin.on('error', () =>
      this.fail(
        new HandlerError(
          'DSH_RUNTIME_CLOSED',
          'DSH runtime input stream closed',
          false,
        ),
      ),
    );
    this.child.once('exit', (code, signal) => {
      this.processExit = { code, signal };
    });
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
        this.processExit = { code, signal };
        this.stdioClosed = true;
        this.fail(
          new HandlerError(
            'DSH_RUNTIME_CLOSED',
            `DSH runtime closed (${signal ?? code ?? 'unknown'})`,
            !this.closing,
          ),
        );
        resolve();
      });
    });
  }

  subscribe(listener: (value: DshNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Prompt acknowledgement is not turn completion. Notify idle waiters too,
   * including listeners installed after a process has already terminated. */
  onFailure(listener: (error: Error) => void) {
    if (this.terminalError) listener(this.terminalError);
    else this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  setRequestHandler(handler: DshInboundRequestHandler | null) {
    this.inboundRequestHandler = handler;
  }

  async initialize(input: {
    cwd: string;
    provider: string;
    model: string;
    nativeTools?: string[];
    nativeSkills?: DshNativeSkillSnapshot[];
    contentScenes?: EmployeeRuntimeScene[];
    maxTokens?: number;
    expectedVersion?: string;
    requireTaskProgress?: boolean;
    requireDurableQuestions?: boolean;
    requireContentGuard?: boolean;
  }) {
    const {
      expectedVersion,
      requireTaskProgress,
      requireDurableQuestions,
      requireContentGuard,
      ...params
    } = input;
    const result = await this.request('initialize', {
      ...params,
      ...(requireContentGuard ? { requireContentGuard: true } : {}),
    });
    const serverInfo = record(result.serverInfo);
    if (
      input.contentScenes?.length &&
      record(result.capabilities)?.contentScenes !== true
    )
      throw new HandlerError(
        'DSH_SCENE_PROVIDER_UNAVAILABLE',
        'DSH did not activate the scene provider',
        false,
      );
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
    if (
      requireContentGuard &&
      record(result.capabilities)?.contentGuard !== true
    )
      throw new HandlerError(
        'DSH_CONTENT_GUARD_UNAVAILABLE',
        'DSH did not activate current content authorization',
        false,
      );
    if (
      requireTaskProgress &&
      record(result.capabilities)?.taskProgress !== true
    )
      throw new HandlerError(
        'DSH_PROGRESS_GUARD_UNAVAILABLE',
        'DSH runtime did not activate the required progress guard',
        false,
      );
    if (
      requireDurableQuestions &&
      record(result.capabilities)?.durableQuestions !== true
    )
      throw new HandlerError(
        'DSH_DURABLE_WAIT_UNAVAILABLE',
        'DSH runtime does not support durable question waits',
        false,
      );
    const timing = record(result.preparation);
    const skillRegistrationMs = timing?.skillRegistrationMs;
    return {
      name: serverInfo.name,
      version: serverInfo.version,
      bootstrapCoverage: record(result.capabilities)?.bootstrapCoverage === 1,
      skillRegistrationMs:
        typeof skillRegistrationMs === 'number' &&
        Number.isFinite(skillRegistrationMs) &&
        skillRegistrationMs >= 0 &&
        skillRegistrationMs <= this.launch.requestTimeoutMs
          ? skillRegistrationMs
          : null,
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    images: readonly HarnessImageInput[] = [],
    sessionReferences: readonly SessionReferenceSnapshot[] = [],
    bootstrapReceipt?: BootstrapReceipt,
  ) {
    const result = await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
      images,
      ...(bootstrapReceipt ? { bootstrapReceipt } : {}),
      ...(sessionReferences.length ? { sessionReferences } : {}),
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

  /** DSH owns the tree wait, including follow-up turns and parked children.
   * Like assistant join, its lifetime belongs to Worker cancellation/lease,
   * not the short RPC acknowledgement timeout. Preserve native rejections. */
  async wait(sessionId: string) {
    return this.request('session/wait', { sessionId }, 0);
  }

  async parkQuestion(sessionId: string, questionId: string) {
    return this.request(
      'session/park-question',
      { sessionId, questionId },
      15_000,
    );
  }

  async answerWait(input: {
    sessionId: string;
    questionId: string;
    turnId: string;
    inputId: string;
    text: string;
  }) {
    return this.request('session/answer-wait', input, 15_000);
  }

  async continueWait(input: {
    sessionId: string;
    questionId: string;
    turnId: string;
    inputId: string;
    text: string;
  }) {
    return this.request('session/continue-wait', input, 15_000);
  }

  /** MET-210: release a Host whose root only waits on a user question. */
  async detachQuestion(sessionId: string) {
    return this.request('session/detach', { sessionId }) as Promise<
      { detached: true; callId: string } | { detached: false; reason: string }
    >;
  }

  /** Resume a stored root without prompting it (DSH resume repair runs). */
  async resume(sessionId: string) {
    return this.request('session/resume', { sessionId });
  }

  async userQuestions(sessionId: string) {
    return this.request('session/user-questions', { sessionId }) as Promise<{
      sequence?: number;
      questions:
        { callId: string; state: string; questions: unknown[] }[] | null;
    }>;
  }

  async questionReply(input: {
    sessionId: string;
    callId: string;
    answers: { id: string; selected: string[]; custom?: string }[];
  }) {
    return this.request('session/question-reply', input) as Promise<{
      queued: boolean;
    }>;
  }

  async steer(
    sessionId: string,
    text: string,
    typed?: {
      inputId: string;
      turnId: string;
      kind: 'steer_current' | 'ask_user';
    },
  ) {
    return this.request('session/steer', { sessionId, text, ...typed }, 10_000);
  }

  async compact(sessionId: string) {
    return this.request('session/compact', { sessionId });
  }

  async sessionProjection(sessionId: string) {
    const result = await this.request(
      'session/projection',
      { sessionId },
      10_000,
    );
    const pressure = record(result.contextPressure);
    const optionalCount = (value: unknown) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
    const contextWindow = optionalCount(pressure?.contextWindow);
    return {
      asOfSeq: optionalCount(result.asOfSeq),
      contextPressure:
        pressure && contextWindow && contextWindow > 0
          ? {
              pressureTokens: optionalCount(pressure.pressureTokens),
              projectedTokens: optionalCount(pressure.projectedTokens),
              contextWindow,
            }
          : null,
    };
  }

  async bootstrapCoverage(sessionId: string, query: BootstrapCoverageQuery) {
    return BootstrapCoverageResultSchema.parse(
      await this.request('session/bootstrap-coverage', { sessionId, query }),
    );
  }

  async recover(sessionId: string) {
    return this.request('session/recover', { sessionId });
  }

  async finalDelivery(
    action: 'bind' | 'candidate' | 'repair' | 'finish',
    params: Record<string, unknown>,
  ) {
    return this.request(`allrice/final-delivery/${action}`, params, 0);
  }

  async closeSession(sessionId: string) {
    return this.request('session/close', { sessionId }, 10_000);
  }

  async providerStatus() {
    return this.request('provider/status', undefined, 10_000);
  }

  async providerQuota() {
    return this.request('provider/quota', undefined, 25_000);
  }

  async authorizeCodex() {
    return this.request('provider/authorize-codex', undefined, 20 * 60_000);
  }

  async cancelCodexAuthorization() {
    return this.request('provider/cancel-codex', undefined, 10_000);
  }

  async generateCodexImage(input: {
    workModel: string;
    imageModel: string;
    prompt: string;
    source?: { mediaType: string; data: string };
  }) {
    return this.request('provider/image-generation', input, 310_000);
  }

  async searchCodexWeb(query: string, maxResults = 5) {
    const result = await this.request(
      'provider/web-search',
      { query, maxResults },
      70_000,
    );
    if (
      result.provider !== 'codex-hosted-search' ||
      typeof result.query !== 'string' ||
      typeof result.output !== 'string' ||
      !Array.isArray(result.results)
    ) {
      throw new HandlerError(
        'DSH_PROTOCOL_MISMATCH',
        'DSH runtime returned a malformed Codex search response',
        false,
      );
    }
    return {
      provider: 'codex-hosted-search' as const,
      query: result.query,
      output: result.output,
      results: result.results,
    };
  }

  processState(): DshRuntimeProcessState {
    return {
      state: this.processExit
        ? 'exited'
        : this.child.pid
          ? 'running'
          : 'unknown',
      stdioClosed: this.stdioClosed,
      exitCode: this.processExit?.code ?? null,
      signal: this.processExit?.signal ?? null,
    };
  }

  closureEvidence(): DshRuntimeCloseEvidence | null {
    return this.closeEvidence
      ? { ...this.closeEvidence, process: this.processState() }
      : null;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = this.performClose();
    return this.closeTask;
  }

  private async waitForProcessClose(timeoutMs: number): Promise<boolean> {
    if (this.stdioClosed) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async performClose() {
    const observationErrors: unknown[] = [];
    const observations: Promise<void>[] = [];
    const observe = (details: DshCloseObservationDetails) => {
      if (!this.launch.observeClose) return;
      // Persistence must never postpone or abandon physical child cleanup.
      // Each rejection is observed immediately and propagated after reaping.
      observations.push(
        Promise.resolve()
          .then(() => this.launch.observeClose!(details))
          .then(
            () => undefined,
            (error) => {
              observationErrors.push(error);
            },
          ),
      );
    };
    observe({ kind: 'close_started' });
    let wrapper: Extract<
      DshCloseObservationDetails,
      { kind: 'close_request' }
    >['wrapper'] = null;
    let emptyCloseReceipt: DshNeverCreatedCloseReceipt | null = null;
    let shutdownAcknowledged = false;
    let wrapperCleanupConfirmed = false;
    let terminationAttempted: 'SIGTERM' | 'SIGKILL' | null = null;
    try {
      const result = await this.request('shutdown', undefined, 2_000);
      shutdownAcknowledged = true;
      const proof = record(result.allriceClose);
      // A local initialize attempt can never be undone by a child claiming
      // it was empty. Keep the original v1 durable observation shape below.
      if (!this.initializeStarted)
        emptyCloseReceipt = neverCreatedCloseReceipt(proof);
      if (
        proof?.version === 1 &&
        typeof proof.sdkShutdown === 'boolean' &&
        typeof proof.rootDisposed === 'boolean' &&
        typeof proof.priorFramesFlushed === 'boolean'
      )
        wrapper = {
          version: 1,
          sdkShutdown: proof.sdkShutdown,
          rootDisposed: proof.rootDisposed,
          priorFramesFlushed: proof.priorFramesFlushed,
        };
      wrapperCleanupConfirmed = !!(
        wrapper?.sdkShutdown &&
        wrapper.rootDisposed &&
        wrapper.priorFramesFlushed
      );
    } catch {
      // Still own and reap this exact child. A failed request can never become
      // a semantic close confirmation solely because the process later exits.
    }
    observe({
      kind: 'close_request',
      acknowledged: shutdownAcknowledged,
      wrapper,
    });
    this.child.stdin.end();
    // Let an acknowledged shutdown finish naturally before escalating. The
    // bounded waits do not abandon cleanup: the real close event is awaited below.
    if (!(await this.waitForProcessClose(2_000))) {
      if (!this.processExit) {
        terminationAttempted = 'SIGTERM';
        this.child.kill('SIGTERM');
      }
      if (!(await this.waitForProcessClose(2_000)) && !this.processExit) {
        terminationAttempted = 'SIGKILL';
        this.child.kill('SIGKILL');
      }
    }
    await this.closed;
    this.lines.close();
    const process = this.processState();
    const emptyTransportClosed = !!(
      emptyCloseReceipt &&
      shutdownAcknowledged &&
      !this.initializeStarted &&
      process.state === 'exited' &&
      process.stdioClosed &&
      process.exitCode === 0 &&
      process.signal === null &&
      terminationAttempted === null
    );
    const evidence: DshRuntimeCloseEvidence = Object.freeze({
      process: Object.freeze(this.processState()),
      shutdownAcknowledged,
      wrapperCleanupConfirmed,
      emptyTransportClosed,
      emptyCloseReceipt,
      terminationAttempted,
    });
    this.closeEvidence = evidence;
    observe({
      kind: 'process_closed',
      fact: {
        source: 'child_close',
        stdioClosed: true,
        exitCode: evidence.process.exitCode,
        signal: evidence.process.signal,
        terminationAttempted,
      },
    });
    await Promise.all(observations);
    const failure =
      !shutdownAcknowledged ||
      (!wrapperCleanupConfirmed &&
        !(emptyTransportClosed && !this.launch.observeClose)) ||
      evidence.process.exitCode !== 0 ||
      evidence.process.signal !== null ||
      terminationAttempted !== null
        ? new DshRuntimeCloseError(evidence)
        : null;
    if (observationErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...observationErrors],
        'DSH runtime close observation remains unconfirmed',
      );
    if (failure) throw failure;
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs = this.launch.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing && method !== 'shutdown')
      return Promise.reject(
        new HandlerError(
          'DSH_RUNTIME_CLOSING',
          'DSH runtime is closing',
          false,
        ),
      );
    // Fence before writing the first initialize frame, including failed or
    // concurrent attempts; absence of an initialize response is not emptiness.
    if (method === 'initialize') this.initializeStarted = true;
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === 0
          ? undefined
          : setTimeout(() => {
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
    if (
      typeof frame.method === 'string' &&
      (typeof frame.id === 'number' || typeof frame.id === 'string')
    ) {
      void this.handleInboundRequest(frame.id, frame.method, frame.params);
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

  private async handleInboundRequest(
    id: number | string,
    method: string,
    rawParams: unknown,
  ) {
    const params = record(rawParams) ?? {};
    try {
      if (!this.inboundRequestHandler) {
        throw new HandlerError(
          'DSH_INBOUND_REQUEST_DENIED',
          'No AllRice Tool Broker request is active',
          false,
        );
      }
      const result = await this.inboundRequestHandler(method, params);
      if (this.terminalError || !this.child.stdin.writable) return;
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
      );
    } catch (error) {
      if (this.terminalError || !this.child.stdin.writable) return;
      const message =
        error instanceof HandlerError
          ? error.message
          : 'AllRice Tool Broker request failed';
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message },
        })}\n`,
      );
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
    for (const listener of this.failureListeners) listener(error);
    this.failureListeners.clear();
  }
}
