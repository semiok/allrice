/** Actual production publication + PG ownership + immutable bytes. Synthetic
 * report content only; never starts Worker, native host, credentials or model. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '../../../packages/contracts/src/index.ts';
import { LocalStorageAdapter } from '../../../packages/storage/src/index.ts';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../packages/database/src/assistant-authority.fixture.ts';
import { publishAssistantOutput } from '../../../packages/database/src/assistant-output.ts';
import { verifyCodexAssistantArtifact } from './p27-codex-assistants-verification.ts';
import { codexAssistantsDiagnostics } from './p27-codex-assistants-preflight.ts';
import { type P27CodexJsonObservation } from './p27-codex-json.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'Codex report JSON through actual immutable artifact publication',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let directory: string | undefined;
    let storage: LocalStorageAdapter;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.ALLRICE_TEST_DATABASE_URL).toBe(
        'postgres://a123@127.0.0.1:5432/allrice_b2',
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
      directory = await mkdtemp(join(tmpdir(), 'allrice-p27-codex-json-'));
      vi.stubEnv('ALLRICE_STORAGE_ROOT', directory);
      storage = new LocalStorageAdapter(directory);
    }, 30000);
    afterAll(async () => {
      try {
        if (fixture)
          expect(await fixture.close()).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 20000);

    async function publish(content: string) {
      const f = await createAssistantAuthorityFixture(fixture.db);
      const { instance: child } = await f.runtime.provision({
        ...f.base,
        rootRunId: f.rootRunId,
        parentRunId: f.rootRunId,
        delegationId: randomUUID(),
        label: 'Synthetic report only',
        text: 'No model is invoked',
        tools: ['assistant.report'],
      });
      const [policy] =
        await fixture.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
        startedAt: new Date().toISOString(),
      });
      const deliveryId = randomUUID();
      const output = await publishAssistantOutput(
        {
          context,
          assistant: { runId: child.runId, worker: f.worker },
          deliveryId,
          output: { name: 'report', content },
        },
        { database: fixture.db, storage },
      );
      const identity = {
        db: fixture.db,
        context: f.context,
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
      };
      const task = { runId: f.rootRunId, sessionId: f.session };
      const item = {
        runId: child.runId,
        deliveryId,
        evidence: [{ id: output.artifactId, digest: output.digest }],
      };
      return { identity, task, item };
    }

    it.each([
      ['A', '{"case":"A","totalCents":875,"rows":2}', false],
      [
        'B',
        '```json\n{"case":"B","invoiceCents":1900,"paidCents":1300,"outstandingCents":600}\n```',
        true,
      ],
    ] as const)(
      'reads the real wrapper and %s report without inventing content',
      async (kind, content, fenced) => {
        const f = await publish(content);
        const observations: P27CodexJsonObservation[] = [];
        const result = await verifyCodexAssistantArtifact(
          f.identity,
          f.task,
          f.item,
          (entry) => observations.push(entry),
        );
        expect(result).toMatchObject({
          id: f.item.evidence[0]!.id,
          digest: f.item.evidence[0]!.digest,
          case: kind,
        });
        expect(observations).toMatchObject([
          {
            stage: 'artifact_envelope',
            artifactId: f.item.evidence[0]!.id,
            childRunId: f.item.runId,
            deliveryId: f.item.deliveryId,
            digest: f.item.evidence[0]!.digest,
            isFence: false,
            isJson: true,
            accepted: true,
          },
          {
            stage: 'child_report',
            isFence: fenced,
            isJson: true,
            accepted: true,
          },
        ]);
        expect(JSON.stringify(result)).not.toContain('totalCents');
        const [rows] =
          await fixture.db`select count(*)::int as count from allrice_workbench_artifacts where run_id=${f.item.runId}`;
        expect(rows?.count).toBe(1);
      },
    );

    it.each([
      'The secret-thought-marker answer is {"case":"A","totalCents":875,"rows":2}',
      '```json\n{"case":"A","totalCents":875,"rows":2}\n```\n```json\n{}\n```',
    ])(
      'preserves a real invalid report but rejects its exact child parse stage',
      async (content) => {
        const f = await publish(content);
        const observations: P27CodexJsonObservation[] = [];
        let failure: unknown;
        try {
          await verifyCodexAssistantArtifact(
            f.identity,
            f.task,
            f.item,
            (entry) => observations.push(entry),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({
          code: 'P27_CODEX_JSON_CHILD_REPORT_INVALID',
        });
        expect(observations).toMatchObject([
          { stage: 'artifact_envelope', isJson: true, accepted: true },
          { stage: 'child_report', accepted: false },
        ]);
        const safe = JSON.stringify(codexAssistantsDiagnostics(failure));
        expect(safe).toContain('child_report');
        expect(safe).not.toContain('secret-thought-marker');
        expect(safe).not.toContain('totalCents');
      },
    );

    it('does not weaken delivery identity or arithmetic when JSON parsing succeeds', async () => {
      const f = await publish(
        '```json\n{"case":"A","totalCents":0,"rows":2}\n```',
      );
      await expect(
        verifyCodexAssistantArtifact(f.identity, f.task, f.item),
      ).rejects.toMatchObject({ code: 'child_arithmetic' });
      await expect(
        verifyCodexAssistantArtifact(f.identity, f.task, {
          ...f.item,
          deliveryId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'artifacts_unverified' });
    });
  },
);
