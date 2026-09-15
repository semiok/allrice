import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import {
  SessionModelSnapshotSchema,
  type SessionModelSnapshot,
} from './models.ts';
import {
  DshExecutionSnapshotSchema,
  type HarnessExecutionSnapshot,
} from './skills.ts';
import type { RouteDecision } from './routing.ts';

/** Server-frozen subscription identity, NOT a tariff or a claim of free use.
 * No currency, price, invoice amount or provider allowance is represented. */
export const AssistantSubscriptionSnapshotSchema = z
  .object({
    version: z.literal(1),
    billingMode: z.literal('subscription'),
    harness: z.literal('dsh'),
    provider: z.literal('openai-codex'),
    authMode: z.literal('chatgpt_subscription'),
    sessionId: UuidSchema,
    employeeId: UuidSchema,
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    policyRevision: z.number().int().positive(),
    model: z.string().trim().min(1).max(200),
    credentialReference: z.string().trim().min(1).max(255),
    baseUrl: z.null(),
    frozenAt: TimestampSchema,
  })
  .strict();
export type AssistantSubscriptionSnapshot = z.infer<
  typeof AssistantSubscriptionSnapshotSchema
>;

/** Fail closed for any claimed Codex route. Only an unambiguously non-Codex
 * selection returns undefined; model/browser text never supplies this input. */
export function resolveAssistantSubscriptionSnapshot(input: {
  sessionId: string;
  modelSnapshot: SessionModelSnapshot | undefined;
  decision: Pick<
    RouteDecision,
    | 'employeeId'
    | 'modelConnectionId'
    | 'modelCatalogEntryId'
    | 'modelPolicyRevision'
    | 'harness'
    | 'provider'
    | 'model'
  >;
  providerSnapshot: HarnessExecutionSnapshot;
}): AssistantSubscriptionSnapshot | undefined {
  const runtime = input.providerSnapshot;
  if (
    input.decision.provider !== 'openai-codex' &&
    runtime.provider !== 'codex' &&
    !(runtime.provider === 'dsh' && runtime.route === 'openai-codex')
  )
    return undefined;
  const deny = (): never => {
    throw Error('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  };
  const parsed = SessionModelSnapshotSchema.safeParse(input.modelSnapshot);
  const native = DshExecutionSnapshotSchema.safeParse(runtime);
  if (!parsed.success || !native.success) return deny();
  const frozen = parsed.data;
  const route = input.decision;
  const targets = [frozen, ...frozen.resolvedFallbacks].filter(
    (target) =>
      target.connectionId === route.modelConnectionId &&
      target.modelCatalogEntryId === route.modelCatalogEntryId &&
      target.harness === route.harness &&
      target.provider === route.provider &&
      target.model === route.model,
  );
  if (
    targets.length !== 1 ||
    frozen.sessionId !== input.sessionId ||
    frozen.employeeId !== route.employeeId ||
    frozen.policyRevision !== route.modelPolicyRevision
  )
    return deny();
  const target = targets[0]!;
  if (
    (target !== frozen && frozen.fallbackPolicy !== 'explicit') ||
    target.harness !== 'dsh' ||
    target.provider !== 'openai-codex' ||
    target.authMode !== 'chatgpt_subscription' ||
    target.baseUrl !== null ||
    !target.credentialReference ||
    native.data.route !== 'openai-codex' ||
    native.data.authMode !== 'platform_subscription' ||
    native.data.baseUrl !== null ||
    native.data.model !== target.model ||
    native.data.reasoningEffort !== target.reasoningEffort ||
    native.data.credentialReference !== target.credentialReference
  )
    return deny();
  return AssistantSubscriptionSnapshotSchema.parse({
    version: 1,
    billingMode: 'subscription',
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    sessionId: frozen.sessionId,
    employeeId: frozen.employeeId,
    connectionId: target.connectionId,
    modelCatalogEntryId: target.modelCatalogEntryId,
    policyRevision: frozen.policyRevision,
    model: target.model,
    credentialReference: target.credentialReference,
    baseUrl: null,
    frozenAt: frozen.frozenAt,
  });
}
