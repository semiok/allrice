/** Presentation-safe projection; call attempts are not provider usage receipts. */
export interface TaskRuntimeTiming {
  activeMs: number;
  waitingMs: number;
  wallMs: number;
  timeoutMs: number;
  remainingMs: number | null;
  phase: 'queued' | 'active' | 'waiting' | 'terminal';
  sources: { scope: string; timeoutMs: number }[];
  calls: { modelRequests: number; toolCalls: number; pending: number } | null;
}
