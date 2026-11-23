import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent';

/** One native observation, not a separately sampled history/catalog pair. */
export interface NativeHistorySessionCut {
  readonly meta: SessionHeader;
  readonly inheritedEventCount: number;
  readonly events: readonly SessionEvent[];
  readonly catalog: readonly SubagentCatalogEntry[];
}

/** Validated per-session vector. No cross-session atomicity is asserted. */
export interface NativeHistoryCut {
  readonly rootSessionId: string;
  readonly sessions: readonly NativeHistorySessionCut[];
}

export interface NativeHistoryCutRequest {
  readonly rootSessionId: string;
}
