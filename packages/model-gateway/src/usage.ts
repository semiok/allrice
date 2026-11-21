import type { RuntimeRunUsage } from '@allrice/contracts';
import type {
  ModelAttemptReceipt,
  ModelUsage,
  GatewayFetchClassification,
} from './contract.ts';

export const unknownUsage = (): ModelUsage => ({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cachedInputTokens: null,
  usageComplete: false,
  cacheUsageKnown: false,
});
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

function usageFromWire(value: unknown, responses: boolean): ModelUsage {
  const raw = record(value);
  const inputTokens = count(raw[responses ? 'input_tokens' : 'prompt_tokens']);
  const outputTokens = count(
    raw[responses ? 'output_tokens' : 'completion_tokens'],
  );
  const suppliedTotal = count(raw.total_tokens);
  const sum =
    inputTokens === null || outputTokens === null
      ? null
      : count(inputTokens + outputTokens);
  // An inconsistent supplied total invalidates the observation, never fix it by guessing.
  if (
    raw.total_tokens !== undefined &&
    (suppliedTotal === null || suppliedTotal !== sum)
  )
    return unknownUsage();
  const cache = count(
    record(raw[responses ? 'input_tokens_details' : 'prompt_tokens_details'])
      .cached_tokens,
  );
  const cacheValid =
    cache !== null && inputTokens !== null && cache <= inputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: sum,
    cachedInputTokens: cacheValid ? cache : null,
    usageComplete: sum !== null,
    cacheUsageKnown: cacheValid,
  };
}

/** Observation memory bound only: oversized frames still pass through byte for
 * byte and keep unknown usage. No tee, full-response buffer or hidden body drain. */
const MAX_METER_FRAME_CHARS = 65_536;
export class WireUsageObserver {
  private decoder = new TextDecoder();
  private line = '';
  private data = '';
  private event = '';
  private oversized = false;
  private frameOversized = false;
  private chatFinish = false;
  private done = false;
  terminal: ModelAttemptReceipt['terminal'] = null;
  usage: ModelUsage = unknownUsage();
  constructor(private protocol: GatewayFetchClassification['protocol']) {}
  push(bytes: Uint8Array): void {
    // Iterate fragments rather than buffering the body; limits apply only to metadata capture.
    for (const part of this.decoder
      .decode(bytes, { stream: true })
      .split(/(\n)/)) {
      if (part !== '\n') {
        if (
          !this.oversized &&
          this.line.length + part.length <= MAX_METER_FRAME_CHARS
        )
          this.line += part;
        else {
          this.line = '';
          this.oversized = true;
        }
        continue;
      }
      this.consumeLine(this.line.replace(/\r$/, ''), this.oversized);
      this.line = '';
      this.oversized = false;
    }
  }
  private consumeLine(line: string, oversized: boolean): void {
    if (oversized) {
      this.frameOversized = true;
      return;
    }
    if (line !== '') {
      if (line.startsWith('event:')) this.event = line.slice(6).trim();
      if (line.startsWith('data:')) {
        const next = line.slice(5).trimStart();
        if (this.data.length + next.length <= MAX_METER_FRAME_CHARS)
          this.data += (this.data ? '\n' : '') + next;
        else {
          this.data = '';
          this.frameOversized = true;
        }
      }
      return;
    }
    try {
      if (this.protocol === 'opaque') return;
      if (this.frameOversized) {
        // Responses' explicit event name still records terminal framing; native
        // provider success is separately required before a successful finish.
        if (this.protocol === 'openai-responses')
          this.observeTerminal(this.event);
        return;
      }
      if (this.data === '[DONE]') {
        this.done = true;
        if (this.chatFinish) this.terminal = 'completed';
        return;
      }
      if (!this.data) return;
      const value = record(JSON.parse(this.data));
      if (this.protocol === 'openai-responses') {
        this.observeTerminal(String(value.type));
        const response = record(value.response);
        if (response.usage !== undefined)
          this.usage = usageFromWire(response.usage, true);
      } else {
        if (
          Array.isArray(value.choices) &&
          value.choices.some((c) => record(c).finish_reason != null)
        ) {
          this.chatFinish = true;
          if (this.done) this.terminal = 'completed';
        }
        if (value.error !== undefined) this.terminal = 'failed';
        if (value.usage !== undefined)
          this.usage = usageFromWire(value.usage, false);
      }
    } catch {
      /* Invalid/unsupported wire facts remain unknown. */
    } finally {
      this.event = '';
      this.data = '';
      this.frameOversized = false;
    }
  }
  private observeTerminal(type: string): void {
    if (type === 'response.completed') this.terminal = 'completed';
    else if (type === 'response.failed') this.terminal = 'failed';
    else if (type === 'response.incomplete') this.terminal = 'incomplete';
  }
}

export function summarizeAttempts(
  attempts: readonly ModelAttemptReceipt[],
): RuntimeRunUsage {
  const models = attempts.filter(
    (a) => a.kind === 'model' && a.dispatchObserved !== false,
  );
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') => {
    if (!models.length || models.some((a) => a.usage[key] === null))
      return null;
    return count(models.reduce((n, a) => n + a.usage[key]!, 0));
  };
  const cache = models.reduce(
    (n, a) => n + (a.usage.cachedInputTokens ?? 0),
    0,
  );
  const cacheUsageKnown =
    models.length > 0 && models.every((a) => a.usage.cacheUsageKnown);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    totalTokens: sum('totalTokens'),
    cachedInputTokens: cacheUsageKnown || cache > 0 ? count(cache) : null,
    cacheUsageKnown,
    usageComplete:
      models.length > 0 &&
      models.every(
        (a) =>
          a.outcome !== 'unknown' &&
          a.terminal !== null &&
          a.usage.usageComplete,
      ),
    attemptCount: models.length,
    receiptCount: models.filter((a) => a.outcome !== 'unknown').length,
  };
}
