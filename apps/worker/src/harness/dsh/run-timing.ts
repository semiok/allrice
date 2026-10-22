import { performance } from 'node:perf_hooks';

const points = [
  'preparationCompleted',
  'firstNativeChunk',
  'firstVisibleText',
  'nativeTurnEnded',
  'beforePublication',
  'publicationCompleted',
] as const;
const contentPhases = [
  'nativeDispatch',
  'modelAdmission',
  'toolDispatch',
  'sceneLoad',
  'personalSkill',
  'inputGate',
  'deliveryRepair',
  'afterNativeResult',
  'beforeDeliveryValidation',
  'beforePublication',
  'other',
] as const;

export type DshRunTimingPoint = (typeof points)[number];
export type DshContentCheckPhase = (typeof contentPhases)[number];
export type DshRunTimingOutcome =
  'completed' | 'partial' | 'failed' | 'aborted' | 'waiting';

type ContentCheckTotals = {
  calls: number;
  failed: number;
  pending: number;
  /** Sum of this phase's observed spans, including unfinished spans at finish. */
  durationMs: number;
};

/** Worker observations only. These fields do not describe a child process's
 * socket or Provider request; missing native transport measurements stay null. */
export type DshRunTimingReport = {
  schemaVersion: 1;
  event: 'allrice.dsh_run_timing';
  scope: 'harness-execute';
  runId: string | null;
  sessionId: string | null;
  attempt: number | null;
  generation: number | null;
  outcome: DshRunTimingOutcome;
  elapsedMs: number;
  points: Record<DshRunTimingPoint, number | null>;
  contentChecks: {
    calls: number;
    failed: number;
    pending: number;
    /** Sum of all check spans; overlapping checks count separately here. */
    sumMs: number;
    /** Time covered by any check; overlapping checks count only once here. */
    unionMs: number;
    phases: Record<DshContentCheckPhase, ContentCheckTotals>;
  };
  /** Worker receipt of model-start to model-finish progress, including inner
   * guards and IPC. This does not measure Provider wire duration. */
  modelChain: {
    calls: number;
    completed: number;
    /** Sum of paired start/finish spans; excludes unclosed calls. */
    durationMs: number;
    unclosed: number;
    unclosedDurationMs: number;
    truncated: boolean;
  };
  capabilities: {
    wireTransport: false;
    requestPrepared: false;
    socket: false;
    requestSent: false;
    firstProviderEvent: false;
  };
  wire: {
    requestPreparedMs: null;
    socketConnectedMs: null;
    requestSentMs: null;
    firstProviderEventMs: null;
  };
};

type ContentPhaseState = ContentCheckTotals & { pendingStarts: number };
type ModelSpan = { start: number; end: number | null };

const pointNames = new Set<string>(points);
const phaseNames = new Set<string>(contentPhases);
const outcomeNames = new Set<string>([
  'completed',
  'partial',
  'failed',
  'aborted',
  'waiting',
]);
const maxModelSpans = 256;

function identity(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : null;
}

function counter(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

/** Bounded, observe-only Run timing. No extra admission, retry or persistence
 * authority; operations keep their original result and exception identity. */
export class DshRunTiming {
  private readonly clock: () => number;
  private origin: number | null;
  private lastElapsedMs = 0;
  private finished = false;
  private readonly marks = Object.fromEntries(
    points.map((point) => [point, null]),
  ) as Record<DshRunTimingPoint, number | null>;
  private readonly checks = Object.fromEntries(
    contentPhases.map((phase) => [
      phase,
      { calls: 0, failed: 0, pending: 0, durationMs: 0, pendingStarts: 0 },
    ]),
  ) as Record<DshContentCheckPhase, ContentPhaseState>;
  private activeChecks = 0;
  private unionStart = 0;
  private checkUnionMs = 0;
  private readonly models = new Map<string, ModelSpan>();
  private modelsTruncated = false;
  private readonly runId: string | null;
  private readonly sessionId: string | null;
  private readonly attempt: number | null;
  private readonly generation: number | null;
  private readonly onDiagnostic: (report: DshRunTimingReport) => void;

  constructor(options: {
    runId: string | null;
    sessionId: string | null;
    attempt: number;
    generation: number;
    onDiagnostic: (report: DshRunTimingReport) => void;
    clock?: () => number;
  }) {
    this.clock = options.clock ?? (() => performance.now());
    this.origin = this.readClock();
    this.runId = identity(options.runId);
    this.sessionId = identity(options.sessionId);
    this.attempt = counter(options.attempt);
    this.generation = counter(options.generation);
    this.onDiagnostic = options.onDiagnostic;
  }

  /** Record first observations, except the final native turn's end. Offsets
   * share this harness execute call's clock and exclude prior queue time. */
  mark(point: DshRunTimingPoint): void {
    if (this.finished || !pointNames.has(point)) return;
    if (point === 'nativeTurnEnded' || this.marks[point] === null)
      this.marks[point] = this.elapsed();
  }

  async checkContent(
    phase: DshContentCheckPhase,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.finished) {
      await operation();
      return;
    }
    const entry = this.checks[phaseNames.has(phase) ? phase : 'other'];
    const start = this.elapsed();
    entry.calls++;
    entry.pending++;
    entry.pendingStarts += start;
    if (this.activeChecks++ === 0) this.unionStart = start;
    let failed = false;
    try {
      await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A final report is a snapshot. A late operation still returns/throws
      // normally, but cannot change or emit another report for this Run.
      if (!this.finished) {
        const end = this.elapsed();
        entry.durationMs += end - start;
        entry.pending--;
        entry.pendingStarts -= start;
        if (failed) entry.failed++;
        if (--this.activeChecks === 0)
          this.checkUnionMs += end - this.unionStart;
      }
    }
  }

  modelStarted(callId: string): void {
    if (this.finished) return;
    const id = identity(callId);
    if (!id || this.models.has(id)) return;
    if (this.models.size >= maxModelSpans) {
      this.modelsTruncated = true;
      return;
    }
    this.models.set(id, { start: this.elapsed(), end: null });
  }

  modelFinished(callId: string): void {
    if (this.finished) return;
    const id = identity(callId);
    const span = id ? this.models.get(id) : undefined;
    if (span && span.end === null) span.end = this.elapsed();
  }

  finish(outcome: DshRunTimingOutcome): void {
    if (this.finished) return;
    this.finished = true;
    const end = this.elapsed();
    const phases = {} as Record<DshContentCheckPhase, ContentCheckTotals>;
    const totals = { calls: 0, failed: 0, pending: 0, sumMs: 0 };
    for (const phase of contentPhases) {
      const entry = this.checks[phase];
      phases[phase] = {
        calls: bounded(entry.calls),
        failed: bounded(entry.failed),
        pending: bounded(entry.pending),
        durationMs: bounded(
          entry.durationMs + entry.pending * end - entry.pendingStarts,
        ),
      };
      totals.calls += phases[phase].calls;
      totals.failed += phases[phase].failed;
      totals.pending += phases[phase].pending;
      totals.sumMs += phases[phase].durationMs;
    }
    const modelChain = {
      calls: this.models.size,
      completed: 0,
      durationMs: 0,
      unclosed: 0,
      unclosedDurationMs: 0,
      truncated: this.modelsTruncated,
    };
    for (const span of this.models.values()) {
      if (span.end === null) {
        modelChain.unclosed++;
        modelChain.unclosedDurationMs += end - span.start;
      } else {
        modelChain.completed++;
        modelChain.durationMs += span.end - span.start;
      }
    }
    const report: DshRunTimingReport = {
      schemaVersion: 1,
      event: 'allrice.dsh_run_timing',
      scope: 'harness-execute',
      runId: this.runId,
      sessionId: this.sessionId,
      attempt: this.attempt,
      generation: this.generation,
      outcome: outcomeNames.has(outcome) ? outcome : 'failed',
      elapsedMs: end,
      points: { ...this.marks },
      contentChecks: {
        calls: bounded(totals.calls),
        failed: bounded(totals.failed),
        pending: bounded(totals.pending),
        sumMs: bounded(totals.sumMs),
        unionMs: bounded(
          this.checkUnionMs +
            (this.activeChecks > 0 ? end - this.unionStart : 0),
        ),
        phases,
      },
      modelChain: {
        ...modelChain,
        durationMs: bounded(modelChain.durationMs),
        unclosedDurationMs: bounded(modelChain.unclosedDurationMs),
      },
      capabilities: {
        wireTransport: false,
        requestPrepared: false,
        socket: false,
        requestSent: false,
        firstProviderEvent: false,
      },
      wire: {
        requestPreparedMs: null,
        socketConnectedMs: null,
        requestSentMs: null,
        firstProviderEventMs: null,
      },
    };
    try {
      // Also absorb an async logger rejection without awaiting it. Logging
      // does not add a Run completion barrier or change its outcome.
      Promise.resolve(this.onDiagnostic(report)).catch(() => {});
    } catch {
      /* Operator diagnostics cannot change business execution. */
    }
  }

  private readClock(): number | null {
    try {
      const value = this.clock();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private elapsed(): number {
    const value = this.readClock();
    if (value !== null) {
      // If the initial diagnostic sample failed, start from the first valid
      // sample instead of treating an absolute clock value as Run duration.
      this.origin ??= value;
      // Keep sub-millisecond precision: rounding each endpoint can exaggerate
      // a short span when its observations straddle a millisecond boundary.
      this.lastElapsedMs = bounded(
        Math.max(this.lastElapsedMs, value - this.origin),
      );
    }
    return this.lastElapsedMs;
  }
}
