import { createHash } from 'node:crypto';
import { HandlerError } from '../errors.js';
import type { DeliveryDecision } from './policy.js';

export interface FinalDeliveryCandidate {
  readonly nativeText: string;
  readonly projectedText: string;
  readonly nativeSessionId: string;
  /** Observed runOnce ID, not proof of the message selected by join. */
  readonly observedReplyId?: string;
  /** Exact native journal identity from the held completion boundary. */
  readonly publicMessageId?: string;
  readonly durableSeq?: number;
  /** Private bind capability; never included in a receipt or public event. */
  readonly nativeBindingId?: string;
  readonly rootRunId?: string;
  readonly attempt: number;
  readonly generation: number;
}

/** Worker-local evidence passed only to the bound controller's finalization. */
export interface FinalDeliveryProof {
  readonly nativeSessionId: string;
  readonly publicMessageId: string;
  readonly durableSeq: number;
  readonly nativeBindingId: string;
  readonly nativeCandidateDigest: string;
  readonly candidateDigest: string;
  readonly factSetDigest: string;
  readonly attempt: number;
  readonly generation: number;
}

/** Worker closure only. Never an RPC/model-supplied function or receipt. */
export interface FinalDeliveryPort {
  check(candidate: FinalDeliveryCandidate): Promise<DeliveryDecision>;
}

export interface FinalDeliveryReceipt {
  phase: 'deterministic_validation';
  candidateDigest: string;
  nativeCandidateDigest: string;
  factSetDigest: string;
  nativeSessionId: string;
  observedReplyId?: string;
  publicMessageId?: string;
  durableSeq?: number;
  attempt: number;
  generation: number;
  status: DeliveryDecision['status'];
  issues: DeliveryDecision['issues'];
}

const digest = (text: string): string =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function unavailable(): HandlerError {
  return new HandlerError(
    'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    'Final delivery evidence could not be verified; no model retry was started',
    false,
  );
}

/**
 * Call after native join and before finish. This phase makes no correction/model call.
 * Do not replace native/public candidate history on failure.
 */
export async function assertFinalDelivery(input: {
  port: FinalDeliveryPort;
  candidate: FinalDeliveryCandidate;
  signal: AbortSignal;
  report(receipt: FinalDeliveryReceipt): Promise<void>;
}): Promise<FinalDeliveryReceipt> {
  input.signal.throwIfAborted();
  let decision: DeliveryDecision;
  try {
    decision = await input.port.check(input.candidate);
  } catch (error) {
    input.signal.throwIfAborted();
    // Keep an existing definitive stop/delivery failure; never turn a read
    // problem into permission to replay the business task.
    if (error instanceof HandlerError && !error.retryable) throw error;
    throw unavailable();
  }
  input.signal.throwIfAborted();
  // A stale decision cannot authorize a different candidate or fabricate completion.
  if (
    !decision ||
    decision.candidateDigest !== digest(input.candidate.projectedText) ||
    !SHA256.test(decision.factSetDigest) ||
    !['valid', 'invalid_response', 'evidence_unavailable'].includes(
      decision.status,
    ) ||
    !Array.isArray(decision.issues) ||
    decision.issues.length > 100 ||
    (decision.status === 'valid') !== (decision.issues.length === 0)
  )
    throw unavailable();

  const receipt: FinalDeliveryReceipt = Object.freeze({
    phase: 'deterministic_validation',
    candidateDigest: decision.candidateDigest,
    nativeCandidateDigest: digest(input.candidate.nativeText),
    factSetDigest: decision.factSetDigest,
    nativeSessionId: input.candidate.nativeSessionId,
    observedReplyId: input.candidate.observedReplyId,
    publicMessageId: input.candidate.publicMessageId,
    durableSeq: input.candidate.durableSeq,
    attempt: input.candidate.attempt,
    generation: input.candidate.generation,
    status: decision.status,
    issues: decision.issues,
  });
  try {
    await input.report(receipt);
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof HandlerError && !error.retryable) throw error;
    throw unavailable();
  }
  input.signal.throwIfAborted();
  if (decision.status === 'evidence_unavailable') throw unavailable();
  if (decision.status !== 'valid')
    throw new HandlerError(
      'FINAL_DELIVERY_RESPONSE_INVALID',
      'Final delivery response did not match verified delivery facts; no model retry was started',
      false,
    );
  return receipt;
}
