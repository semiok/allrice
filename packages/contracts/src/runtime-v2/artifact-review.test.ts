import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChangesetDocumentSchema,
  ReviewDraftInputSchema,
  ReviewFeedbackSchema,
  WorkbenchArtifactSchema,
  WorkbenchCursorSchema,
} from './artifact-review.ts';

const checksum = `sha256:${'a'.repeat(64)}`,
  id = randomUUID(),
  objectId = randomUUID(),
  ownerId = randomUUID(),
  organizationId = randomUUID(),
  workspaceId = randomUUID();
const now = new Date().toISOString();
const artifact = {
  contractVersion: 1,
  id,
  kind: 'document',
  version: {
    id,
    objectId,
    organizationId,
    workspaceId,
    ownerId,
    seriesId: randomUUID(),
    version: 1,
    parentVersionId: null,
    parentObjectId: null,
    sessionId: randomUUID(),
    platformTestRunId: null,
    fileName: 'test.txt',
    format: 'text',
    changeSummary: null,
    createdAt: now,
  },
  object: {
    id: objectId,
    organizationId,
    workspaceId,
    ownerId,
    key: `organizations/${organizationId}/workspaces/${workspaceId}/owners/${ownerId}/exports/${objectId}`,
    mediaType: 'text/plain',
    checksum,
    sizeBytes: 10,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  },
  provenance: {
    kind: 'model_proposal',
    runId: randomUUID(),
    operationId: null,
    stepId: null,
  },
  execution: null,
  latestVersionId: id,
  stale: false,
};
describe('workbench version contracts', () => {
  it('does not introduce an unrelated version or source identity', () => {
    expect(WorkbenchArtifactSchema.safeParse(artifact).success).toBe(true);
    for (const patch of [
      { id: randomUUID() },
      { object: { ...artifact.object, ownerId: randomUUID() } },
      { stale: true },
      { provenance: { ...artifact.provenance, runId: null } },
      { provenance: { ...artifact.provenance, kind: 'legacy_deliverable' } },
    ])
      expect(
        WorkbenchArtifactSchema.safeParse({ ...artifact, ...patch }).success,
      ).toBe(false);
  });
  it('rejects ambiguous Changeset paths, empty files and embedded action approvals', () => {
    const grantId = randomUUID();
    const changeset = {
      contractVersion: 1,
      comparisonScope: 'changeset',
      execution: {
        targetId: randomUUID(),
        targetKind: 'rice_bridge',
        deviceId: randomUUID(),
        grantId,
        grantVersion: 1,
        scopeDigest: checksum,
        workCopy: { id: grantId, kind: 'in_place' },
      },
      files: [
        { path: 'a.txt', before: null, after: { text: 'hello', checksum } },
      ],
    };
    expect(ChangesetDocumentSchema.safeParse(changeset).success).toBe(true);
    for (const files of [
      [{ ...changeset.files[0], path: '../a' }],
      [changeset.files[0], changeset.files[0]],
      [changeset.files[0], { ...changeset.files[0], path: 'a.txt/child' }],
      [{ path: 'a', before: null, after: null }],
    ])
      expect(
        ChangesetDocumentSchema.safeParse({ ...changeset, files }).success,
      ).toBe(false);
    expect(
      ChangesetDocumentSchema.safeParse({ ...changeset, approved: true })
        .success,
    ).toBe(false);
  });
  it('bounds comments and separates draft, submission and response', () => {
    const comment = {
      id: randomUUID(),
      anchor: { kind: 'whole' },
      text: 'comment',
    };
    const draft = {
      feedbackId: randomUUID(),
      artifactId: id,
      checksum,
      expectedRevision: 0,
      comments: [comment],
    };
    expect(ReviewDraftInputSchema.safeParse(draft).success).toBe(true);
    for (const patch of [
      { approved: true },
      { comments: [comment, comment] },
      { comments: [] },
      { comments: [{ ...comment, text: ' ' }] },
    ])
      expect(
        ReviewDraftInputSchema.safeParse({ ...draft, ...patch }).success,
      ).toBe(false);
    const feedback = {
      id: draft.feedbackId,
      artifactId: id,
      actorId: ownerId,
      revision: 1,
      checksum,
      comments: [comment],
      state: 'draft',
      stale: false,
      resultArtifactId: null,
      resolution: null,
      createdAt: now,
      submittedAt: null,
      updatedAt: now,
    };
    expect(ReviewFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(
      ReviewFeedbackSchema.safeParse({ ...feedback, state: 'submitted' })
        .success,
    ).toBe(false);
    expect(
      ReviewFeedbackSchema.safeParse({
        ...feedback,
        state: 'addressed',
        submittedAt: now,
      }).success,
    ).toBe(false);
    expect(
      ReviewFeedbackSchema.safeParse({
        ...feedback,
        state: 'addressed',
        submittedAt: now,
        resultArtifactId: randomUUID(),
        resolution: 'Response for user review',
      }).success,
    ).toBe(true);
  });
  it('uses strict bounded pagination identities', () => {
    expect(
      WorkbenchCursorSchema.safeParse({ createdAt: now, id }).success,
    ).toBe(true);
    for (const cursor of [
      { createdAt: 'invalid', id },
      { createdAt: now, id: 'invalid' },
      { createdAt: now, id, ownerId },
    ])
      expect(WorkbenchCursorSchema.safeParse(cursor).success).toBe(false);
  });
});
