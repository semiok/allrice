import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import {
  SessionModelSnapshotSchema,
  ExperienceModelSnapshotSchema,
  type ExperienceModelSnapshot,
  type SessionModelSnapshot,
} from './models.ts';
import {
  DshExecutionSnapshotSchema,
  type HarnessExecutionSnapshot,
} from './skills.ts';
import type { RouteDecision } from './routing.ts';

/** Server-frozen subscription identity, NOT a tariff or a claim of free use.
 * No currency, price, invoice amount or provider allowance is represented. */
const ChatSubscriptionSnapshotSchema = z
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
export const SubscriptionSnapshotSchema = z.discriminatedUnion('version', [
  ChatSubscriptionSnapshotSchema,
  ChatSubscriptionSnapshotSchema.extend({
    version: z.literal(2),
    sessionId: z.null(),
    occurrenceId: UuidSchema,
  }).strict(),
]);
export type SubscriptionSnapshot = z.infer<typeof SubscriptionSnapshotSchema>;

/** Fail closed for any claimed Codex route. Only an unambiguously non-Codex
 * selection returns undefined; model/browser text never supplies this input. */
export function resolveSubscriptionSnapshot(input: {
  sessionId?: string;
  occurrenceId?: string;
  modelSnapshot: SessionModelSnapshot | ExperienceModelSnapshot | undefined;
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
}): SubscriptionSnapshot | undefined {
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
  if (Boolean(input.sessionId) === Boolean(input.occurrenceId)) return deny();
  const parsed = input.occurrenceId
    ? ExperienceModelSnapshotSchema.safeParse(input.modelSnapshot)
    : SessionModelSnapshotSchema.safeParse(input.modelSnapshot);
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
    (frozen.schemaVersion === 2
      ? frozen.occurrenceId !== input.occurrenceId ||
        input.sessionId !== undefined
      : frozen.sessionId !== input.sessionId ||
        input.occurrenceId !== undefined) ||
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
  return SubscriptionSnapshotSchema.parse({
    version: frozen.schemaVersion === 2 ? 2 : 1,
    billingMode: 'subscription',
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    sessionId: frozen.sessionId,
    ...(frozen.schemaVersion === 2
      ? { occurrenceId: frozen.occurrenceId }
      : {}),
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
