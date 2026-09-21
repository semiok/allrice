/** Ledger-derived usage across a Run's route attempts. Cache is a subset of
 * input, not an extra addition to total. Null means unavailable, never zero.
 * A positive cached subtotal remains visible even when cacheUsageKnown=false;
 * that flag governs completeness, not whether observed cache should be hidden. */
export interface RuntimeRunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  usageComplete: boolean;
  cacheUsageKnown: boolean;
  attemptCount: number;
  receiptCount: number;
}
