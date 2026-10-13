import { record, shortText } from './event-projector.js';

/** DSH live frames have their own revision/index, not durable Session seqs. */
export class DshAssistantStream {
  private revision = 0;
  private lastAttemptId: string | undefined;
  private active:
    | { attemptId: string; turn: number; step: number; nextIndex: number }
    | undefined;

  accept(value: unknown): Record<string, unknown> | null {
    const frame = record(value);
    if (!frame) return null;
    const attemptId = shortText(frame.attemptId, 512);
    const revision = frame.revision;
    if (
      !attemptId ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision <= this.revision
    )
      return null;
    if (frame.type === 'start') {
      if (
        attemptId === this.lastAttemptId ||
        !Number.isSafeInteger(frame.turn) ||
        !Number.isSafeInteger(frame.step) ||
        Number(frame.turn) < 0 ||
        Number(frame.step) < 0
      )
        return null;
      this.active = {
        attemptId,
        turn: Number(frame.turn),
        step: Number(frame.step),
        nextIndex: 0,
      };
      this.lastAttemptId = attemptId;
    } else if (
      !this.active ||
      attemptId !== this.active.attemptId ||
      frame.index !== this.active.nextIndex
    ) {
      return null;
    }
    const active = this.active;
    if (!active) return null;
    const chunk = record(frame.chunk);
    const outcome = record(frame.outcome);
    if (frame.type === 'chunk') {
      if (!chunk || typeof chunk.type !== 'string') return null;
      active.nextIndex += 1;
    } else if (frame.type === 'end') {
      if (
        !outcome ||
        !['committed', 'abandoned'].includes(String(outcome.kind))
      )
        return null;
      this.active = undefined;
    } else if (frame.type !== 'start') {
      return null;
    }
    this.revision = revision;
    return {
      type: `assistant/live-${frame.type}`,
      // Keep the transient identity distinct from durable numeric seqs.
      seq: `live:${attemptId}:${revision}`,
      time: typeof frame.time === 'number' ? frame.time : Date.now(),
      data: {
        turn: active.turn,
        step: active.step,
        attemptId,
        revision,
        ...(frame.type === 'chunk' ? { chunk } : {}),
        ...(frame.type === 'end' ? { outcome } : {}),
      },
    };
  }
}
