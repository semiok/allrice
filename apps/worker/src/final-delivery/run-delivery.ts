import {
  createDeliveryCommitGuard,
  readDeliverySnapshot,
  readRunDeliveryReplyOrigin,
  type FinalDeliveryReplyOrigin,
  type RunDeliveryAuthority,
} from '@allrice/database';
import type { FinalDeliveryCandidate, FinalDeliveryProof } from './guard.js';
import { checkFinalDelivery } from './policy.js';
import { createDeliveryMarkup } from './markup.js';
import { createDeliveryRepairInspection } from './repair.js';
import { normalizeAllRiceManagedFileLinks } from '../harness/dsh/tool-bridge.js';
import { bindCheckedFinalDeliveryCommitGuard } from './checked-delivery.js';
import { createHash } from 'node:crypto';
import { HandlerError } from '../errors.js';
const finalDeliveryTextDigest = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
function finalDeliveryUnavailable(): never {
  throw new HandlerError(
    'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    'Final delivery source could not be verified',
    false,
  );
}

/** Worker-owned composition. Queue eligibility is deliberately unchanged. */
export function createRunDeliveryPort(authority: RunDeliveryAuthority) {
  const captured = structuredClone(authority);
  let checked:
    { proof: FinalDeliveryProof; origin: FinalDeliveryReplyOrigin } | undefined;
  const readSnapshot = () => readDeliverySnapshot(captured);
  const readOrigin = () => readRunDeliveryReplyOrigin(captured);
  return {
    rootRunId: captured.rootRunId,
    readSnapshot,
    readOrigin,
    createCommitGuard: (
      proof: FinalDeliveryProof,
      origin: FinalDeliveryReplyOrigin,
    ) => createDeliveryCommitGuard({ authority: captured, proof, origin }),
    async inspect(candidate: unknown) {
      const facts = await readSnapshot();
      const origin = await readOrigin();
      if (!origin) finalDeliveryUnavailable();
      return createDeliveryRepairInspection({
        nativeSessionId: origin.nativeSessionId,
        scope: facts.scope,
        read: readSnapshot,
        assertAuthority: async () => {
          if (!(await readOrigin())) finalDeliveryUnavailable();
        },
      })(candidate);
    },
    async check(candidate: FinalDeliveryCandidate) {
      checked = undefined;
      const origin = await readOrigin();
      if (
        !origin ||
        candidate.rootRunId !== captured.rootRunId ||
        candidate.nativeSessionId !== origin.nativeSessionId ||
        candidate.attempt !== captured.worker.attempt ||
        candidate.generation !== captured.worker.generation ||
        !candidate.publicMessageId ||
        !candidate.nativeBindingId ||
        !Number.isSafeInteger(candidate.durableSeq) ||
        candidate.durableSeq! < 1 ||
        candidate.projectedText !==
          normalizeAllRiceManagedFileLinks(candidate.nativeText)
      )
        finalDeliveryUnavailable();
      const snapshot = await readSnapshot();
      const policy = {
        snapshot,
        expectedScope: snapshot.scope,
        markup: createDeliveryMarkup(),
        managedOrigins: [],
      };
      const native = checkFinalDelivery({
        ...policy,
        candidate: candidate.nativeText,
      });
      const decision = checkFinalDelivery({
        ...policy,
        candidate: candidate.projectedText,
      });
      const meaning = ({ status, linked, issues }: typeof decision) =>
        JSON.stringify({
          status,
          linked,
          issues: issues.map(({ code, reason, requirementId }) => ({
            code,
            reason,
            requirementId,
          })),
        });
      if (meaning(native) !== meaning(decision)) finalDeliveryUnavailable();
      if (decision.status === 'valid')
        checked = {
          origin,
          proof: {
            nativeSessionId: candidate.nativeSessionId,
            publicMessageId: candidate.publicMessageId!,
            durableSeq: candidate.durableSeq!,
            nativeBindingId: candidate.nativeBindingId!,
            nativeCandidateDigest: finalDeliveryTextDigest(
              candidate.nativeText,
            ),
            candidateDigest: decision.candidateDigest,
            factSetDigest: decision.factSetDigest,
            attempt: candidate.attempt,
            generation: candidate.generation,
          },
        };
      return decision;
    },
    finish(proof: FinalDeliveryProof) {
      if (
        !checked ||
        Object.keys(checked.proof).some(
          (key) =>
            checked!.proof[key as keyof FinalDeliveryProof] !==
            proof[key as keyof FinalDeliveryProof],
        )
      )
        finalDeliveryUnavailable();
      bindCheckedFinalDeliveryCommitGuard(
        proof,
        createDeliveryCommitGuard({
          authority: captured,
          proof,
          origin: checked.origin,
        }),
      );
      checked = undefined;
    },
  };
}
