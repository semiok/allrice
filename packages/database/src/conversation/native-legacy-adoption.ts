/** Explicit maintenance-only first transition. Never called by a prompt, normal
 * admission, startup, or environment flag. No codec, Native Host or filesystem
 * persistence writes here: it consumes exact independently reviewed receipts. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { nativeRootDigest } from './native-identity-digest.ts';
import {
  CurrentEmployeeChatOriginSchema,
  assertCurrentEmployeeChatOrigin,
} from './current-execution-binding.ts';
import {
  ExecutorTransitionScopeSchema,
  ExecutorTransitionReceiptSchema,
} from './native-executor-transition-contract.ts';
import { readPinnedExecutorEvidence } from './native-executor-transition.ts';
import { readDshRuntimeCloseCoverage } from '../providers/dsh-runtime-close-observations.ts';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pin = z
  .object({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
const same = (a: unknown, b: unknown) =>
  nativeRootDigest(a) === nativeRootDigest(b);
function need(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error('EXECUTOR_ADOPTION_' + code);
}
const approvalSchema = z
  .object({
    kind: z.literal('reviewed-chat-legacy-adoption-v1'),
    requestId: z.uuid(),
    scope: ExecutorTransitionScopeSchema,
    expectedFactsDigest: digest,
    from: ExecutorTransitionReceiptSchema.shape.from,
    target: ExecutorTransitionReceiptSchema.shape.target,
    storageNamespace: z.string(),
    previousDigest: z.null(),
    reviewedBy: z.string().min(1),
    reviewedAtMs: z.number().int(),
    expiresAtMs: z.number().int(),
    adoption: ExecutorTransitionReceiptSchema.shape.adoption.unwrap(),
    artifactProof: pin,
    historyProof: pin,
    closeProof: pin,
    conversionProof: pin,
    byteFactsProof: pin,
  })
  .strict();
const byteFactsSchema = z
  .object({
    kind: z.literal('reviewed-legacy-chat-byte-facts-v1'),
    scope: ExecutorTransitionScopeSchema,
    sourceNamespace: z.string(),
    targetNamespace: z.string(),
    source: z
      .array(
        z
          .object({
            role: z.enum(['journal', 'native_attachment']),
            nativeSessionId: z.string(),
            pin,
          })
          .strict(),
      )
      .min(1),
    target: z
      .array(
        z
          .object({
            role: z.enum(['journal', 'native_attachment']),
            nativeSessionId: z.string(),
            pin,
          })
          .strict(),
      )
      .min(1),
    businessObjects: z.array(z.object({ objectId: z.uuid(), pin }).strict()),
  })
  .strict();
function verifyBytes(p: z.infer<typeof pin>) {
  need(
    isAbsolute(p.path) &&
      normalize(p.path) === p.path &&
      realpathSync(p.path) === p.path,
    'BYTE_PATH',
  );
  const before = lstatSync(p.path),
    bytes = readFileSync(p.path),
    after = lstatSync(p.path);
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      bytes.length === p.bytes &&
      createHash('sha256').update(bytes).digest('hex') === p.sha256,
    'BYTE_DRIFT',
  );
}
/** Native journals live below `sessions`; immutable attachment objects live in
 * the sibling SDK `attachments/v1/objects/<prefix>/<sha256>` tree. This exact
 * role-dependent path is not permission to read the whole parent directory. */
export function verifyLegacyAdoptionNativeByteFile(
  file: z.infer<typeof byteFactsSchema>['source'][number],
  storageNamespace: string,
  nativeSessionId: string,
) {
  need(
    isAbsolute(storageNamespace) &&
      normalize(storageNamespace) === storageNamespace &&
      storageNamespace.endsWith('/sessions') &&
      file.nativeSessionId === nativeSessionId &&
      (file.role === 'journal'
        ? file.pin.path.startsWith(storageNamespace + '/')
        : file.role === 'native_attachment' &&
          file.pin.path ===
            join(
              dirname(storageNamespace),
              'attachments',
              'v1',
              'objects',
              file.pin.sha256.slice(0, 2),
              file.pin.sha256,
            )),
    'FILE_SCOPE',
  );
  verifyBytes(file.pin);
}
/** This minimum supports exactly one closed standalone V3 root, not child
 * journals, legacy bindings, arbitrary earlier SDK generations or summaries. */
export async function applyReviewedLegacyChatAdoption(input: {
  db: Sql;
  enabled?: boolean;
  approvalFile: z.infer<typeof pin>;
}) {
  need(input.enabled === true, 'DISABLED');
  const review = approvalSchema.parse(
    readPinnedExecutorEvidence(input.approvalFile),
  );
  const read = (p: z.infer<typeof pin>) =>
    readPinnedExecutorEvidence(p) as Record<string, unknown>;
  const artifact = read(review.artifactProof),
    history = read(review.historyProof),
    close = read(review.closeProof),
    conversion = read(review.conversionProof);
  const byteFacts = byteFactsSchema.parse(read(review.byteFactsProof));
  const s = review.scope,
    a = review.adoption;
  const effective = CurrentEmployeeChatOriginSchema.parse(a.effectiveOrigin);
  need(
    same(effective.scope, {
      organizationId: s.organizationId,
      workspaceId: s.workspaceId,
      ownerId: s.ownerId,
    }) &&
      effective.contextId === s.contextId &&
      effective.artifactId === review.target.artifactId,
    'EFFECTIVE_SCOPE',
  );
  need(
    review.from.generation === 'dsh-0.1.5-rc.3-a4c74a9' &&
      review.target.generation === effective.distributionGeneration &&
      review.from.artifactId !== review.target.artifactId,
    'SOURCE_GENERATION',
  );
  need(
    a.sourceNamespace !== review.storageNamespace &&
      a.nativeSessionIds.length === 1 &&
      a.nativeSessionIds[0] === 'dsh-' + s.contextId,
    'MINIMUM_NATIVE_SCOPE',
  );
  need(
    artifact.kind === 'verified-native-artifact-v1' &&
      artifact.artifactId === review.target.artifactId &&
      artifact.manifestDigest === review.target.artifactId &&
      artifact.generation === review.target.generation &&
      artifact.profileId === 'restricted' &&
      artifact.verified === true &&
      digest.safeParse(artifact.measurementDigest).success,
    'TARGET_PROOF',
  );
  need(
    same(byteFacts.scope, s) &&
      byteFacts.sourceNamespace === a.sourceNamespace &&
      byteFacts.targetNamespace === review.storageNamespace &&
      nativeRootDigest(byteFacts) === a.sourceByteFactsDigest,
    'BYTE_FACTS_SCOPE',
  );
  const sourceJournals = byteFacts.source.filter((x) => x.role === 'journal'),
    targetJournals = byteFacts.target.filter((x) => x.role === 'journal');
  need(
    sourceJournals.length === 1 &&
      targetJournals.length === 1 &&
      sourceJournals[0]!.nativeSessionId === a.nativeSessionIds[0] &&
      targetJournals[0]!.nativeSessionId === a.nativeSessionIds[0],
    'JOURNAL_CLOSURE',
  );
  for (const [files, root] of [
    [byteFacts.source, a.sourceNamespace],
    [byteFacts.target, review.storageNamespace],
  ] as const) {
    need(
      isAbsolute(root) &&
        normalize(root) === root &&
        root.endsWith(
          `/${s.organizationId}/${s.workspaceId}/${s.ownerId}/${s.contextId}/sessions`,
        ),
      'NAMESPACE',
    );
    need(
      new Set(files.map((x) => x.pin.path)).size === files.length,
      'FILE_SCOPE',
    );
    for (const file of files)
      verifyLegacyAdoptionNativeByteFile(file, root, a.nativeSessionIds[0]!);
  }
  const sourceBlobs = byteFacts.source
    .filter((x) => x.role === 'native_attachment')
    .map((x) => ({ sha256: x.pin.sha256, bytes: x.pin.bytes }))
    .sort((x, y) => x.sha256.localeCompare(y.sha256));
  const targetBlobs = byteFacts.target
    .filter((x) => x.role === 'native_attachment')
    .map((x) => ({ sha256: x.pin.sha256, bytes: x.pin.bytes }))
    .sort((x, y) => x.sha256.localeCompare(y.sha256));
  need(same(sourceBlobs, targetBlobs), 'ATTACHMENT_BYTES');
  const src = sourceJournals[0]!.pin,
    dst = targetJournals[0]!.pin;
  need(
    conversion.kind === 'allrice-v3-input-pure-conversion-v1' &&
      conversion.sourceFormat === 3 &&
      conversion.targetFormat === 4 &&
      conversion.nativeSessionId === a.nativeSessionIds[0] &&
      same(conversion.source, { sha256: src.sha256, bytes: src.bytes }) &&
      same(conversion.target, { sha256: dst.sha256, bytes: dst.bytes }) &&
      conversion.currentDetachedValidationPassed === true &&
      nativeRootDigest(conversion) === a.conversionEvidenceDigest,
    'CONVERSION_PROOF',
  );
  const referenceSchema = z.array(
    z
      .object({
        sourceSeq: z.number().int().nonnegative(),
        path: z.string().endsWith('/attachmentId'),
        value: digest,
      })
      .strict(),
  );
  const references = referenceSchema.safeParse(conversion.references);
  need(references.success, 'REFERENCE_SCOPE');
  need(
    same(
      [...new Set(references.data.map((x) => x.value))].sort(),
      sourceBlobs.map((x) => 'sha256:' + x.sha256).sort(),
    ),
    'ATTACHMENT_REFERENCE_CLOSURE',
  );
  // Actual public persistence full-read must be independent of the pure converter.
  // No flags on the pure receipt can substitute for fresh read + close evidence.
  need(
    history.kind === 'full-native-chat-adoption-read-v1' &&
      same(history.scope, s) &&
      history.requestId === review.requestId &&
      history.expectedFactsDigest === review.expectedFactsDigest &&
      history.targetArtifactId === review.target.artifactId &&
      history.storageNamespace === review.storageNamespace &&
      same(history.nativeSessionIds, a.nativeSessionIds) &&
      history.conversionEvidenceDigest === a.conversionEvidenceDigest &&
      history.byteFactsDigest === a.sourceByteFactsDigest &&
      history.complete === true &&
      history.missing === 0 &&
      history.publicPersistenceWritePassed === true &&
      history.freshPublicFullReadPassed === true &&
      history.fullSessionRestorePassed === true &&
      history.privateFactsVerified === true &&
      history.privateEventDigest ===
        nativeRootDigest(conversion.privateEvents) &&
      Array.isArray(conversion.privateEvents) &&
      history.privateEventCount === conversion.privateEvents.length &&
      history.eventCount === conversion.eventCount &&
      history.publicHandleClosed === true &&
      history.backendDisposed === true &&
      history.originalUnchanged === true &&
      history.deliverablesUnchanged === true,
    'HISTORY_PROOF',
  );
  need(
    close.kind === 'reviewed-native-chat-offline-v1' &&
      same(close.scope, s) &&
      close.requestId === review.requestId &&
      close.expectedFactsDigest === review.expectedFactsDigest &&
      close.webStoppedNormally === true &&
      close.workerStoppedNormally === true &&
      close.allOwnedProcessesAbsent === true &&
      close.unconfirmedOwners === 0 &&
      close.deploymentLockVerified === true &&
      close.qaLockVerified === true &&
      close.targetReadHandleClosed === true &&
      close.targetPersistenceFlushed === true &&
      close.targetPersistenceDisposed === true,
    'CLOSE_PROOF',
  );
  const verifyAll = () => {
    for (const x of [
      ...byteFacts.source,
      ...byteFacts.target,
      ...byteFacts.businessObjects,
    ])
      verifyBytes(x.pin);
  };
  verifyAll();
  try {
    return await input.db.begin(async (tx) => {
      await tx`select set_config('lock_timeout','1000',true),set_config('statement_timeout','10000',true)`;
      await tx`select id from allrice_organizations where id=${s.organizationId} for share`;
      await tx`select id from allrice_workspaces where id=${s.workspaceId} and organization_id=${s.organizationId} for share`;
      await tx`select id from allrice_users where id=${s.ownerId} for share`;
      await tx`select id from allrice_memberships where organization_id=${s.organizationId} and user_id=${s.ownerId} and active and (workspace_id is null or workspace_id=${s.workspaceId}) for share`;
      const [chat] =
        await tx`select * from allrice_chat_sessions where id=${s.contextId} and organization_id=${s.organizationId} and workspace_id=${s.workspaceId} and owner_id=${s.ownerId} and archived_at is null for update`;
      need(chat && chat.native_root_origin === null, 'RAW_ORIGIN_OR_SCOPE');
      await tx`select a.id from allrice_employee_assignments a where a.id=${chat.employee_assignment_id} and a.active for share`;
      const prior =
        await tx`select request_id from allrice_native_chat_executor_transitions where context_id=${s.contextId} or request_id=${review.requestId}`;
      need(prior.length === 0, 'ALREADY_APPLIED_READBACK_ONLY');
      const [f] =
        await tx`select allrice_native_chat_adoption_facts(${s.contextId},null) facts,floor(extract(epoch from clock_timestamp())*1000)::float8 now`;
      need(
        f &&
          f.now >= review.reviewedAtMs &&
          f.now <= review.expiresAtMs &&
          review.expiresAtMs - review.reviewedAtMs <= 900000 &&
          nativeRootDigest(f.facts) === review.expectedFactsDigest,
        'FACTS_OR_APPROVAL_CHANGED',
      );
      need(
        f.facts.origin === null &&
          Array.isArray(f.facts.bindings) &&
          f.facts.bindings.length === 0 &&
          f.facts.previousDigest === null &&
          f.facts.sourceVersionId === a.sourceVersionId &&
          f.facts.legacySource.manifestDigest === a.sourceManifestDigest,
        'SOURCE_CHANGED',
      );
      const [v] =
        await tx`select v.id,v.manifest,v.config_checksum from allrice_employee_versions v join allrice_employee_assignments assignment on assignment.employee_id=v.employee_id where v.id=${a.sourceVersionId} and v.organization_id=${s.organizationId} and v.workspace_id=${s.workspaceId} and assignment.id=${chat.employee_assignment_id} for share of v`;
      need(v, 'SOURCE_MISSING');
      assertCurrentEmployeeChatOrigin(effective, {
        organizationId: s.organizationId,
        workspaceId: s.workspaceId,
        ownerId: s.ownerId,
        sessionId: s.contextId,
        source: {
          employeeVersionId: v.id,
          manifest: v.manifest,
          configChecksum: v.config_checksum,
        },
      });
      need(
        v.manifest?.runtimePackage == null ||
          v.manifest.runtimePackage.runtimeManifest.distributionGeneration ===
            review.from.generation,
        'SOURCE_NOT_LEGACY',
      );
      need(
        f.facts.runtime?.native_thread_id === a.nativeSessionIds[0] ||
          f.facts.runtime?.thread_id === a.nativeSessionIds[0],
        'LEGACY_THREAD_MISSING',
      );
      const objects = byteFacts.businessObjects
        .map((x) => ({
          id: x.objectId,
          checksum: 'sha256:' + x.pin.sha256,
          byteSize: x.pin.bytes,
        }))
        .sort((x, y) => x.id.localeCompare(y.id));
      need(
        new Set(objects.map((x) => x.id)).size === objects.length &&
          same(objects, f.facts.objects),
        'BUSINESS_OBJECTS_CHANGED',
      );
      // Existing C unknown/contradictory owners block. A pre-C legacy root may have
      // no rows; target public persistence close is independently reviewed above.
      const coverage = await readDshRuntimeCloseCoverage(tx, { context: s });
      need(
        !coverage.some(
          (x) =>
            x.publicClose !== 'confirmed' && x.physical !== 'never_spawned',
        ),
        'CLOSE_UNCONFIRMED',
      );
      const body = {
        schemaVersion: 2 as const,
        kind: 'chat-executor-transition' as const,
        requestId: review.requestId,
        sequence: 1,
        previousDigest: null,
        scope: s,
        originDigest: nativeRootDigest(effective),
        from: review.from,
        target: review.target,
        storageNamespace: review.storageNamespace,
        facts: f.facts,
        factsDigest: nativeRootDigest(f.facts),
        approvalDigest: nativeRootDigest(review),
        historyEvidenceDigest: nativeRootDigest(history),
        closeEvidenceDigest: nativeRootDigest(close),
        adoption: a,
        appliedAt: new Date(f.now).toISOString(),
      };
      const receipt = ExecutorTransitionReceiptSchema.parse({
        ...body,
        digest: nativeRootDigest(body),
      });
      verifyAll();
      await tx`insert into allrice_native_chat_executor_transitions(request_id,context_id,organization_id,workspace_id,owner_id,sequence,receipt,digest,approval) values(${receipt.requestId},${s.contextId},${s.organizationId},${s.workspaceId},${s.ownerId},1,${tx.json(receipt as never)},${receipt.digest},${tx.json(review as never)})`;
      verifyAll();
      return receipt;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^EXECUTOR_(ADOPTION|TRANSITION)_/.test(error.message)
    )
      throw error;
    throw Error('EXECUTOR_ADOPTION_COMMIT_UNKNOWN_READBACK_ONLY', {
      cause: error,
    });
  }
}
