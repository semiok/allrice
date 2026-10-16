/** A UI observation boundary, not permission to abandon an effect or release a
 * journal lock. Normal shutdown has a 30s VM-stop deadline, 6.5s browser close
 * confirmation and bounded 5s network attempts. After 60s the native host must
 * offer recovery; the original cleanup continues and may still finish later. */
export const desktopShutdownWaitMs = 60_000;

export type BridgeStopPhase =
  | 'control'
  | 'foreground'
  | 'browser'
  | 'preparation'
  | 'heartbeat'
  | 'folder_watchers'
  | 'local_processes'
  | 'sandbox'
  | 'receipts'
  | 'journal';

export class DesktopShutdown {
  private started: number | null = null;
  private phaseStarted = 0;
  private phase: BridgeStopPhase = 'control';
  private status: 'waiting' | 'overdue' | 'failed' | 'completed' = 'waiting';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private history: { phase: BridgeStopPhase; elapsedMs: number }[] = [];

  constructor(private readonly changed: () => void) {}

  begin() {
    if (this.started !== null) return;
    this.started = this.phaseStarted = performance.now();
    this.history.push({ phase: this.phase, elapsedMs: 0 });
    this.timer = setTimeout(() => {
      this.status = 'overdue';
      this.changed();
    }, desktopShutdownWaitMs);
    this.changed();
  }

  enter(phase: BridgeStopPhase) {
    if (this.started === null || this.phase === phase) return;
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.history.push({ phase, elapsedMs: this.elapsed });
    if (this.history.length > 16) this.history.shift();
    this.changed();
  }

  finish(confirmed: boolean) {
    if (this.started === null) return;
    clearTimeout(this.timer);
    this.status = confirmed ? 'completed' : 'failed';
    this.changed();
  }

  dispose() {
    clearTimeout(this.timer);
  }

  private get elapsed() {
    return Math.max(
      0,
      Math.round(performance.now() - (this.started ?? performance.now())),
    );
  }

  snapshot() {
    if (this.started === null) return null;
    return {
      phase: this.phase,
      status: this.status,
      elapsedMs: this.elapsed,
      phaseElapsedMs: Math.max(
        0,
        Math.round(performance.now() - this.phaseStarted),
      ),
      waitLimitMs: desktopShutdownWaitMs,
      history: this.history.map((item) => ({ ...item })),
    };
  }
}
