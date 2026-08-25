import type { HarnessEvent } from '@allrice/contracts';

type AssistantDelta = Extract<HarnessEvent, { type: 'assistant.delta' }>;

export class HarnessEventBatcher {
  private pending: AssistantDelta[] = [];
  private pendingCharacters = 0;
  private timer: NodeJS.Timeout | null = null;
  private writeChain = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly write: (event: HarnessEvent) => Promise<void>,
    private readonly maxDelayMs = 80,
    private readonly maxCharacters = 512,
  ) {}

  async accept(event: HarnessEvent) {
    this.throwFailure();
    if (event.type !== 'assistant.delta') {
      await this.flush();
      await this.enqueueWrite(event);
      return;
    }
    this.pending.push(event);
    this.pendingCharacters += event.text.length;
    if (this.pendingCharacters >= this.maxCharacters) {
      await this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch((error: unknown) => {
          this.failure = error;
        });
      }, this.maxDelayMs);
    }
  }

  async flush() {
    this.throwFailure();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const events = this.pending;
    this.pending = [];
    this.pendingCharacters = 0;
    if (events.length) {
      const first = events[0]!;
      const last = events.at(-1)!;
      await this.enqueueWrite({
        ...last,
        text: events.map((event) => event.text).join(''),
        orderStart: first.order,
      });
    } else {
      await this.writeChain;
    }
    this.throwFailure();
  }

  async close() {
    await this.flush();
  }

  private async enqueueWrite(event: HarnessEvent) {
    this.writeChain = this.writeChain.then(() => this.write(event));
    try {
      await this.writeChain;
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  private throwFailure() {
    if (this.failure) throw this.failure;
  }
}
