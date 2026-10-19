import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { JobRow } from './queue/row-mappers.ts';
import {
  serializeFinalDeliveryFacts,
  type FinalDeliveryFacts,
} from '@allrice/contracts';
import { z } from 'zod';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proofSchema = z
  .object({
    nativeSessionId: z.string().min(5).max(255),
    publicMessageId: z.string().min(1).max(255),
    durableSeq: z.number().int().positive(),
    nativeBindingId: z.string().min(1).max(255),
    nativeCandidateDigest: digest,
    candidateDigest: digest,
    factSetDigest: digest,
    attempt: z.number().int().positive(),
    generation: z.number().int().positive(),
  })
  .strict();

/** Private Worker/native completion receipt; not a model/JSON authorization. */
export type AssistantFinalDeliveryProof = Readonly<z.infer<typeof proofSchema>>;
export function finalDeliveryUnavailable(): never {
  throw Object.assign(new Error('final_delivery_evidence_unavailable'), {
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
}
export function captureFinalDeliveryProof(
  value: unknown,
): AssistantFinalDeliveryProof {
  const parsed = proofSchema.safeParse(value);
  if (!parsed.success) return finalDeliveryUnavailable();
  return Object.freeze(parsed.data);
}
export function finalDeliveryTextDigest(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}
export function finalDeliveryFactsDigest(facts: FinalDeliveryFacts): string {
  return finalDeliveryTextDigest(serializeFinalDeliveryFacts(facts));
}

/** Only the runtime registers its actual root-locked transaction. No public
 * reader option accepts an assertion that READ COMMITTED is safe. */
const barriers = new WeakMap<object, Set<string>>();
export function markFinalDeliveryRootLocked(
  tx: postgres.TransactionSql,
  rootRunId: string,
): void {
  let roots = barriers.get(tx);
  if (!roots) barriers.set(tx, (roots = new Set()));
  roots.add(rootRunId);
}
export function finalDeliveryRootIsLocked(
  tx: postgres.TransactionSql,
  rootRunId: string,
): boolean {
  return barriers.get(tx)?.has(rootRunId) === true;
}

export interface JobCompletionCheck {
  /** After transitionTerminal's LAST SQL; failure rolls back every write. */
  assertCommitted(): Promise<void>;
}
export interface JobCompletionGuard {
  readonly assertCurrent: (
    transaction: postgres.TransactionSql,
    leasedJob: JobRow,
    result: unknown,
  ) => Promise<JobCompletionCheck>;
}
const guards = new WeakSet<object>();
/** Internal runtime composition only. Never exported through HTTP/tool/RPC. */
export function registerJobCompletionGuard(
  assertCurrent: JobCompletionGuard['assertCurrent'],
): JobCompletionGuard {
  const guard = Object.freeze({ assertCurrent });
  guards.add(guard);
  return guard;
}
export function assertJobCompletionGuard(
  value: unknown,
): asserts value is JobCompletionGuard {
  if (!value || typeof value !== 'object' || !guards.has(value))
    finalDeliveryUnavailable();
}

/** Own data property only: repeated getters/proxies are not accepted as text. */
export function checkedResultAnswer(value: unknown): string {
  if (!value || typeof value !== 'object') return finalDeliveryUnavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'answer');
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'string' ||
    !descriptor.value.trim()
  )
    return finalDeliveryUnavailable();
  return descriptor.value;
}
