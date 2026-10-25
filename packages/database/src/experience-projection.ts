import type postgres from 'postgres';
import {
  ExperienceProjectionSchema,
  type ExperienceAdoptionProof,
  type ExperienceReadPin,
} from '@allrice/contracts';
import type { readPrivateExperience } from './experience-adoption.ts';
import { ExperienceError } from './experience.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';

type Current = Awaited<ReturnType<typeof readPrivateExperience>>;
type Tx = postgres.TransactionSql;

/** Existing finite rules are already short. Keep all conditions and numbers,
 * with no extra model call or claim that this representation saves tokens. */
export function buildExperienceProjection(
  pin: ExperienceReadPin,
  proof: ExperienceAdoptionProof,
  draft: { rule: string; applicability: string },
) {
  return ExperienceProjectionSchema.parse({
    schemaVersion: 1,
    algorithm: 'validated-rule-v1',
    pin,
    topic:
      proof.rule.kind === 'attendance_groups' ? 'attendance' : 'report_style',
    rule: draft.rule,
    applicability: draft.applicability,
    occurrenceId: proof.occurrenceId,
    draftIndex: proof.draftIndex,
    sourceIds: proof.sourceIds,
    sourceDigest: proof.sourceDigest,
    outputDigest: proof.outputDigest,
  });
}

export function projectionFor(current: Current) {
  return buildExperienceProjection(
    current.pin,
    current.proof,
    current.source.receipt.output.drafts[current.proof.draftIndex]!,
  );
}

/** Source/identity locks are acquired by readPrivateExperience first. This last
 * lock serializes the derived view with forgetting the adopted memory itself. */
export async function lockExperienceProjectionSource(
  tx: Tx,
  current: Current,
  rebuilding = false,
  /** `false` on read paths: same check as a plain snapshot read. */
  lock = true,
) {
  const { row, pin, proof } = current;
  const [locked] = await tx`select m.id from allrice_memories m
    join allrice_experience_reviews e on e.memory_id=m.id
    where m.id=${pin.id} and m.organization_id=${row.organization_id}
      and m.workspace_id=${row.workspace_id} and m.owner_id=${row.owner_id}
      and m.instance_id=${pin.instanceId} and m.revision=${pin.revision}
      and m.content=${row.content} and m.archived_at is null
      and m.visibility='private' and m.lifecycle_state='durable' and m.trust_level='derived'
      and e.status='approved' and e.origin_kind='derived' and e.adoption_proof=${tx.json(proof)}
    ${rebuilding ? tx`for no key update of m for share of e` : lock ? tx`for share of m,e` : tx``}`;
  if (!locked) throw new ExperienceError('source_changed');
}

/** Call only after current authorization, inside the same transaction. GETs do
 * not rebuild. Savepoint isolates cache failures from the valid original read. */
export async function ensureExperienceProjection(tx: Tx, current: Current) {
  // Run preparation later updates recall_count. Take the corresponding write
  // lock now: two readers upgrading SHARE after a cache lock would deadlock.
  // This same row lock serializes duplicate rebuilds, so no second lock is needed.
  await lockExperienceProjectionSource(tx, current, true);
  try {
    return await tx.savepoint(async (cache) => {
      const projection = projectionFor(current);
      const { row } = current;
      const [chunk] =
        await cache`select id,experience_projection from allrice_rag_chunks
        where memory_id=${current.pin.id} and organization_id=${row.organization_id}
          and workspace_id=${row.workspace_id} and owner_id=${row.owner_id} and visibility='private'
        order by (experience_projection is not null) desc,id limit 1`;
      if (chunk) {
        if (
          runtimePolicyDigest(chunk.experience_projection) ===
          runtimePolicyDigest(projection)
        )
          return 'unchanged' as const;
        await cache`update allrice_rag_chunks set experience_projection=${cache.json(projection)} where id=${chunk.id}`;
      } else {
        await cache`insert into allrice_rag_chunks(organization_id,workspace_id,memory_id,owner_id,content,embedding,visibility,experience_projection)
          values(${row.organization_id},${row.workspace_id},${current.pin.id},${row.owner_id},${row.content},
            ${`[${embedWorkspaceText(row.content).join(',')}]`}::vector,'private',${cache.json(projection)})`;
      }
      return 'rebuilt' as const;
    });
  } catch {
    // This cache cannot grant authority or block a valid, bounded original.
    return 'unavailable' as const;
  }
}

export async function readExperienceProjection(tx: Tx, current: Current) {
  const expected = projectionFor(current);
  const [chunk] = await tx`select experience_projection from allrice_rag_chunks
    where memory_id=${current.pin.id} and organization_id=${current.row.organization_id}
      and workspace_id=${current.row.workspace_id} and owner_id=${current.row.owner_id} and visibility='private'
    order by (experience_projection is not null) desc,id limit 1`;
  const parsed = ExperienceProjectionSchema.safeParse(
    chunk?.experience_projection,
  );
  const valid =
    parsed.success &&
    runtimePolicyDigest(parsed.data) === runtimePolicyDigest(expected);
  return {
    projection: valid ? parsed.data : expected,
    representation: valid ? ('projection' as const) : ('original' as const),
    indexState: valid
      ? ('current' as const)
      : chunk?.experience_projection
        ? ('outdated' as const)
        : ('missing' as const),
  };
}
