import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { repositoryReviewFixture } from './platform-repository-review.fixture.ts';
import { freezeRepositoryReviewMaterial } from './platform-repository-review-material.ts';
import { repositoryFactsDigest } from './platform-repository-publication-ledger.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { repositoryReviewReadiness } from './platform-repository-review-readiness.ts';
import {
  RepositoryReviewCommandSchema,
  RepositoryReviewViewSchema,
} from './platform-repository-review-contracts.ts';
import { repairHarnessChecksumFor } from './platform-repair-profile.ts';
describe('repository review stable source/CI and attributed opinion', () => {
  it('keeps stable identity on unchanged refresh, but not on a changed CI attempt', () => {
    const f = repositoryReviewFixture(),
      freeze = () =>
        freezeRepositoryReviewMaterial(f.publication, [f.repair], f.inspection),
      a = freeze();
    f.publication.ci.observedAt = '2026-10-06T11:00:00Z';
    f.publication.ci.checks.reverse();
    f.publication.ci.receipts.reverse();
    f.publication.ci_evidence.reverse();
    f.inspection.receipt.factsDigest = repositoryFactsDigest(f.publication);
    const b = freeze();
    expect(b.subjectDigest).toBe(a.subjectDigest);
    expect(b.evidenceDigest).toBe(a.evidenceDigest);
    f.publication.ci.runAttempt = 2;
    for (const e of f.publication.ci_evidence) {
      e.receipt.runAttempt = 2;
      f.publication.ci.receipts.find(
        (r) => r.name === e.receipt.job,
      )!.receiptDigest = technicalDigest(e.receipt);
    }
    f.inspection.receipt.factsDigest = repositoryFactsDigest(f.publication);
    const c = freeze();
    expect(c.subjectDigest).not.toBe(a.subjectDigest);
    expect(c.candidateContentDigest).toBe(a.candidateContentDigest);
  });
  it('requires the latest complete original inspection; four green names alone do not qualify', () => {
    for (const mutate of [
      (f: ReturnType<typeof repositoryReviewFixture>) => {
        f.inspection.status = 'running';
      },
      (f: ReturnType<typeof repositoryReviewFixture>) => {
        f.publication.ci_evidence.pop();
      },
      (f: ReturnType<typeof repositoryReviewFixture>) => {
        f.publication.ci_evidence[1]!.artifactId =
          f.publication.ci_evidence[0]!.artifactId;
      },
      (f: ReturnType<typeof repositoryReviewFixture>) => {
        f.publication.ci.checkoutTree = 'a'.repeat(40);
      },
      (f: ReturnType<typeof repositoryReviewFixture>) => {
        f.publication.remote.baseSha = 'e'.repeat(40);
      },
    ]) {
      const f = repositoryReviewFixture();
      mutate(f);
      expect(() =>
        freezeRepositoryReviewMaterial(f.publication, [f.repair], f.inspection),
      ).toThrow();
    }
  });
  it('traces an accepted author predating compiled verification and cannot launder adopted bytes', () => {
    const f = repositoryReviewFixture();
    const parent = structuredClone(f.repair);
    parent.id = randomUUID();
    parent.run_id = randomUUID();
    parent.job_id = randomUUID();
    const {
      fingerprint: _old,
      verificationMode: _mode,
      ...originalFields
    } = parent.frozen;
    expect(_old).toMatch(/^sha256:/);
    expect(_mode).toBe('compiled_packages');
    const historicalFields = {
      ...originalFields,
      harnessChecksum: repairHarnessChecksumFor(false),
    };
    parent.frozen = {
      ...historicalFields,
      fingerprint: technicalDigest(historicalFields),
    } as typeof parent.frozen;
    const { fingerprint: _fingerprint, ...fields } = f.repair.frozen;
    expect(_fingerprint).toMatch(/^sha256:/);
    const next = {
      ...fields,
      reuseAcceptedTaskId: parent.id,
      reuseSeed: {
        sourceTaskId: parent.id,
        sourceCandidateChecksum: parent.candidate.checksum,
        sourceReportDigest: technicalDigest(parent.report),
        beforeChecksum: f.publication.source.beforeChecksum,
        afterChecksum: f.publication.source.afterChecksum,
        afterBase64: f.publication.source.afterBase64,
      },
    };
    f.repair.frozen = { ...next, fingerprint: technicalDigest(next) };
    const m = freezeRepositoryReviewMaterial(
      f.publication,
      [f.repair, parent],
      f.inspection,
    );
    expect(m.authorRunIds).toEqual([f.repair.run_id, parent.run_id].sort());
    expect(() =>
      freezeRepositoryReviewMaterial(f.publication, [f.repair], f.inspection),
    ).toThrow();
    parent.report.after.revision++;
    expect(() =>
      freezeRepositoryReviewMaterial(
        f.publication,
        [f.repair, parent],
        f.inspection,
      ),
    ).toThrow();
  });
  it('does not accept natural text, an author, missing delivery or a same-code rejection after CI rerun', () => {
    const f = repositoryReviewFixture(),
      material = freezeRepositoryReviewMaterial(
        f.publication,
        [f.repair],
        f.inspection,
      );
    const review = RepositoryReviewViewSchema.parse({
      id: randomUUID(),
      runId: randomUUID(),
      jobId: randomUUID(),
      sessionId: randomUUID(),
      subjectDigest: material.subjectDigest,
      candidateContentDigest: material.candidateContentDigest,
      status: 'succeeded',
      reviewerRunId: randomUUID(),
      employeeVersionId: randomUUID(),
      verdict: 'accept',
      summary: 'Synthetic opinion only',
      reviewArtifactId: randomUUID(),
      deliveryArtifactId: randomUUID(),
      errorCode: null,
      createdAt: new Date().toISOString(),
      remoteVerifiedAt: new Date().toISOString(),
    });
    expect(repositoryReviewReadiness(material, [review], false).state).toBe(
      'accepted',
    );
    expect(
      repositoryReviewReadiness(
        material,
        [{ ...review, deliveryArtifactId: null }],
        false,
      ).state,
    ).toBe('unknown');
    expect(
      repositoryReviewReadiness(
        material,
        [{ ...review, reviewerRunId: f.repair.run_id }],
        false,
      ).state,
    ).toBe('unknown');
    expect(repositoryReviewReadiness(material, [review], true).state).toBe(
      'revise',
    );
    expect(
      repositoryReviewReadiness(
        { ...material, subjectDigest: technicalDigest('different-attempt') },
        [review],
        false,
      ).state,
    ).toBe('stale');
  });
  it('preserves the native command envelope without accepting an execution grant, tool receipt or caller identity', () => {
    const candidate = {
        artifactId: randomUUID(),
        digest: technicalDigest('material'),
      },
      args = {
        action: 'review',
        candidate,
        evidence: {
          kind: 'repository_ci',
          subjectId: randomUUID(),
          evidenceDigest: technicalDigest('CI'),
        },
        verdict: 'accept',
        summary: 'Review the exact patch',
      };
    expect(RepositoryReviewCommandSchema.safeParse(args).success).toBe(true);
    for (const extra of [
      { operationId: randomUUID() },
      { runId: randomUUID() },
      { execution: {} },
      { repository: 'foreign/repo' },
    ])
      expect(
        RepositoryReviewCommandSchema.safeParse({ ...args, ...extra }).success,
      ).toBe(false);
    expect(
      RepositoryReviewCommandSchema.safeParse({
        action: 'assign',
        ownerRunId: randomUUID(),
        expectedHead: candidate,
        role: 'edit',
        paths: ['x'],
      }).success,
    ).toBe(false);
  });
});
