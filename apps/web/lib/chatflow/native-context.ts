import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { History } from '../../app/chatflow/chatflow-types';

/** The same DSH contextPressure projection used by its native UI. */
export function projectNativeContext(
  stored: History['nativeContextStatus'],
  events: ChatFlowEventEnvelope[],
): History['nativeContextStatus'] {
  let result = stored;
  for (const event of [...events].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence,
  )) {
    if (event.sourceEvent?.type !== 'session/projection') continue;
    if (result?.observedAt && event.occurredAt < result.observedAt) continue;
    const p = event.sourceEvent.payload;
    const used = p.projectedTokens ?? p.pressureTokens;
    const window = p.contextWindow;
    if (
      typeof used !== 'number' ||
      !Number.isInteger(used) ||
      used < 0 ||
      typeof window !== 'number' ||
      !Number.isInteger(window) ||
      window <= 0
    )
      continue;
    result = {
      source: 'dsh',
      usedTokens: used,
      contextWindowTokens: window,
      percentage: Math.min(100, Math.max(0, Math.round((used / window) * 100))),
      asOfSeq: typeof p.asOfSeq === 'number' ? p.asOfSeq : null,
      observedAt: event.occurredAt,
    };
  }
  return result;
}
