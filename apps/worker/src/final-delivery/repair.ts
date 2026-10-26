import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDshToolCall } from '../harness/dsh/tool-bridge.js';
import { createDeliveryMarkup } from './markup.js';
import {
  checkFinalDelivery,
  type DeliveryScope,
  type DeliverySnapshot,
} from './policy.js';

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const candidateSchema = z
  .object({
    nativeSessionId: z.string().min(1).max(200),
    turn: z.number().int().positive(),
    publicMessageId: z.string().min(1).max(240),
    durableSeq: z.number().int().nonnegative(),
    text: z.string().max(256_000),
    candidateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    provider: z.string().min(1).max(120),
    model: z.string().min(1).max(200),
  })
  .strict();

export type RepairCandidate = z.infer<typeof candidateSchema>;
export interface RepairInspection {
  decision: 'pass' | 'repair' | 'blocked';
  candidateDigest: string;
  factSetDigest: string;
  issues: readonly string[];
  references: readonly {
    objectId: string;
    versionId: string;
    checksum: string;
    displayName: string;
    downloadUrl: string;
  }[];
}

/** These methods are bound to an already authorized Worker/native incarnation.
 * They never mint the final completion proof and are not callable model tools. */
export function createDeliveryRepairInspection(input: {
  nativeSessionId: string;
  scope: DeliveryScope;
  read(): Promise<DeliverySnapshot>;
  assertAuthority(): Promise<void>;
}) {
  return async (raw: unknown): Promise<RepairInspection> => {
    const candidate = candidateSchema.parse(raw);
    if (
      candidate.nativeSessionId !== input.nativeSessionId ||
      sha256(candidate.text) !== candidate.candidateDigest ||
      Buffer.byteLength(candidate.text, 'utf8') > 256_000
    )
      throw Error('FINAL_DELIVERY_REPAIR_IDENTITY_MISMATCH');
    await input.assertAuthority();
    const snapshot = await input.read();
    const decision = checkFinalDelivery({
      candidate: candidate.text,
      expectedScope: input.scope,
      snapshot,
      markup: createDeliveryMarkup(),
      managedOrigins: [],
    });
    if (parseDshToolCall(candidate.text)) {
      await input.assertAuthority();
      return {
        decision: 'blocked',
        candidateDigest: decision.candidateDigest,
        factSetDigest: decision.factSetDigest,
        issues: ['business_tool_envelope'],
        references: [],
      };
    }
    // Return only exact authorized immutable versions already present in facts.
    // Recheck a synthesized link-only candidate to exclude versions with failed
    // Office checks. This is policy evaluation, not a synthesized final reply.
    const required = new Set(
      snapshot.requirements.flatMap((requirement) =>
        requirement.expected && requirement.requireLink
          ? [requirement.expected.versionId]
          : [],
      ),
    );
    const superseded = new Set(
      snapshot.requirements.flatMap((requirement) =>
        requirement.whenLinked && requirement.expected
          ? [requirement.expected.versionId]
          : [],
      ),
    );
    const linked = new Set(decision.linked.map((item) => item.versionId));
    const references = snapshot.artifacts
      .filter(
        (artifact) =>
          required.has(artifact.versionId) ||
          linked.has(artifact.versionId) ||
          !superseded.has(artifact.versionId),
      )
      .map((artifact) => ({
        objectId: artifact.objectId,
        versionId: artifact.versionId,
        checksum: artifact.checksum.startsWith('sha256:')
          ? artifact.checksum
          : `sha256:${artifact.checksum}`,
        displayName: artifact.fileName,
        downloadUrl: `/api/v1/files/${artifact.objectId}/download`,
      }));
    const repairFacts =
      references.length <= 32 &&
      checkFinalDelivery({
        candidate: references
          .map((ref) => `[file](${ref.downloadUrl})`)
          .join('\n'),
        expectedScope: input.scope,
        snapshot,
        markup: createDeliveryMarkup(),
        managedOrigins: [],
      }).status === 'valid';
    await input.assertAuthority();
    return {
      decision:
        decision.status === 'valid'
          ? 'pass'
          : decision.textRepairEligible && repairFacts
            ? 'repair'
            : 'blocked',
      candidateDigest: decision.candidateDigest,
      factSetDigest: decision.factSetDigest,
      issues: [...new Set(decision.issues.map((issue) => issue.code))],
      references: decision.status === 'valid' || !repairFacts ? [] : references,
    };
  };
}

export interface BoundDeliveryRepair {
  inspect(candidate: unknown): Promise<RepairInspection>;
  authorize(request: unknown): Promise<{
    allowed: true;
    runId: string;
    generation: number;
    attempt: number;
    workerLeaseDigest: string;
    originalDeadlineAt: number;
    provider: string;
    model: string;
    /** Native only checks these are at least 1 before proposing a repair; the
     * repair call's real output bound comes from native model admission. For
     * an observed metric they are its capacity, not a ledger balance. */
    remainingModelCalls: number;
    remainingOutputTokens: number;
  }>;
  closePreparation(request: unknown): Promise<{
    closed: true;
    callId: string;
    alreadyClosed: boolean;
  }>;
}

/** The caller supplies fixed server-selected identity and the existing runtime
 * authority/budget/undispatched-close operations. No authority field is accepted
 * from the native request or from generated prose. */
export function createBoundedDeliveryRepair(input: {
  nativeSessionId: string;
  scope: DeliveryScope;
  generation: number;
  attempt: number;
  leaseToken: string;
  deadlineAt: number;
  provider: string;
  model: string;
  assertAuthority(): Promise<void>;
  read(): Promise<DeliverySnapshot>;
  budgets(): Promise<
    readonly {
      metric: string;
      capacity: number;
      reserved: number;
      spent: number;
      /** `false` when the runtime only observes this metric (see getTree). */
      enforced?: boolean;
    }[]
  >;
  close(callId: string): ReturnType<BoundDeliveryRepair['closePreparation']>;
}): BoundDeliveryRepair {
  const inspect = createDeliveryRepairInspection(input);
  return {
    inspect,
    async authorize(raw) {
      const request = z
        .object({
          phase: z.enum(['propose', 'prepared', 'consume', 'dispatch']),
          candidate: candidateSchema,
        })
        .strict()
        .parse(raw);
      if (
        request.candidate.nativeSessionId !== input.nativeSessionId ||
        request.candidate.provider !== input.provider ||
        request.candidate.model !== input.model ||
        sha256(request.candidate.text) !== request.candidate.candidateDigest
      )
        throw Error('FINAL_DELIVERY_REPAIR_IDENTITY_MISMATCH');
      await input.assertAuthority();
      if (Date.now() >= input.deadlineAt)
        throw Error('FINAL_DELIVERY_REPAIR_DEADLINE');
      const budgets = await input.budgets();
      const remaining = (metric: string) => {
        const matches = budgets.filter((budget) => budget.metric === metric);
        if (
          matches.length !== 1 ||
          !Object.values(matches[0]!)
            .filter((value) => typeof value === 'number')
            .every((value) => Number.isSafeInteger(value) && value >= 0)
        )
          throw Error('FINAL_DELIVERY_REPAIR_BUDGET_UNAVAILABLE');
        const budget = matches[0]!;
        // An observed metric is telemetry, not a spending gate; model admission
        // does not stop on it either. Report its capacity so native may propose
        // the one repair; spend and unknown-usage reservations stay as they are.
        if (budget.enforced === false) return budget.capacity;
        return Math.max(0, budget.capacity - budget.reserved - budget.spent);
      };
      const remainingModelCalls = remaining('model_calls');
      const remainingOutputTokens = remaining('output_tokens');
      await input.assertAuthority();
      return {
        allowed: true,
        runId: input.scope.runId,
        generation: input.generation,
        attempt: input.attempt,
        workerLeaseDigest: sha256(input.leaseToken),
        originalDeadlineAt: input.deadlineAt,
        provider: input.provider,
        model: input.model,
        remainingModelCalls,
        remainingOutputTokens,
      };
    },
    async closePreparation(raw) {
      const request = z
        .object({
          nativeSessionId: z.string(),
          callId: z.uuid(),
        })
        .strict()
        .parse(raw);
      if (request.nativeSessionId !== input.nativeSessionId)
        throw Error('FINAL_DELIVERY_REPAIR_IDENTITY_MISMATCH');
      // The exact DB root/worker/lease/undispatched transaction rechecks authority.
      return input.close(request.callId);
    },
  };
}
