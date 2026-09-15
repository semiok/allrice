import { randomUUID } from 'node:crypto';
import {
  AssistantPriceSnapshotSchema,
  type AssistantPriceSnapshot,
} from '../../../../packages/contracts/src/assistant-pricing.ts';

/** Synthetic tariff ONLY. Not a published provider price or live billing config. */
export function syntheticAssistantPriceSnapshot(): AssistantPriceSnapshot {
  const now = Date.now();
  return AssistantPriceSnapshotSchema.parse({
    version: 1,
    catalogVersion: 'synthetic-not-for-production',
    selectedAt: new Date(now - 1000).toISOString(),
    price: {
      id: 'synthetic-gemini-upper-bound',
      target: {
        connectionId: randomUUID(),
        catalogId: randomUUID(),
        harness: 'dsh',
        provider: 'gemini',
        authMode: 'api_key',
        model: 'gemini-3.8-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        serviceTier: 'standard',
        modality: 'text',
      },
      billingMode: 'token_metered',
      currency: 'USD',
      effectiveAt: new Date(now - 3600000).toISOString(),
      expiresAt: new Date(now + 3600000).toISOString(),
      maxInputTokens: 2000000,
      maxOutputTokens: 200000,
      rates: {
        uncachedInputMicrounitsPerMillion: '1000000',
        cacheReadMicrounitsPerMillion: '5000000',
        cacheWriteMicrounitsPerMillion: '2000000',
        outputMicrounitsPerMillion: '4000000',
      },
      source: {
        reference: 'synthetic-only',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    },
  });
}
