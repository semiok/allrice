import { HandlerError } from '../../errors.js';

/** One budget for cancellation RPCs, late receipts, usage reads and flush.
 * Reserve the last five seconds of the database's 30s window for the existing
 * native client shutdown (2s RPC, then TERM/KILL). Never renew this budget. */
export class ReceiptDrainWindow {
  private deadline: number | undefined;
  private cutoffTimer: NodeJS.Timeout | undefined;
  private disposal: Promise<void> | undefined;
  constructor(private readonly closeOwnedHost: () => Promise<void>) {}
  get started() {
    return this.deadline !== undefined;
  }
  begin(durableDeadline?: string) {
    const hinted =
      durableDeadline === undefined
        ? Infinity
        : Date.parse(durableDeadline) - 5_000;
    const next = Math.min(
      this.deadline ?? Date.now() + 25_000,
      Number.isFinite(hinted) ? hinted : Infinity,
    );
    if (this.deadline === next) return;
    this.deadline = next;
    if (this.cutoffTimer) clearTimeout(this.cutoffTimer);
    this.cutoffTimer = setTimeout(
      () => {
        void this.drop().catch(() => {});
      },
      Math.max(0, next - Date.now()),
    );
    this.cutoffTimer.unref();
  }
  drop() {
    return (this.disposal ??= this.closeOwnedHost());
  }
  async within<T>(
    operation: () => Promise<T>,
    durableDeadline?: string,
  ): Promise<T> {
    this.begin(durableDeadline);
    const remaining = this.deadline! - Date.now();
    const timeout = () =>
      new HandlerError(
        'DSH_DRAIN_TIMEOUT',
        'Native stop receipts did not finish within the original bounded window',
        false,
      );
    if (remaining <= 0) throw timeout();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout()), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  dispose() {
    if (this.cutoffTimer) clearTimeout(this.cutoffTimer);
  }
}
