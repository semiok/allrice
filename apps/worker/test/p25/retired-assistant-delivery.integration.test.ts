/** Same schema/storage upgrade, old real API -> unmodified retirement SQL ->
 * candidate admission/Worker/Host. No eligibility or adapter mocks.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRetirementUpgradeFixture } from '../../../../packages/database/src/assistant-retirement.fixture.ts';
import { failJob } from '../../../../packages/database/src/execution/queue.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import {
  assertDeliveryProof,
  completeDelivery,
  createDeliveryHarness,
  deliveryArtifactId,
  deliveryState,
  jsonValue,
  publishDelivery,
  readDeliveryBytes,
  sha256,
  type DeliveryCohort,
  type DeliveryHarness,
} from './retired-assistant-delivery.before.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
// Independent deletion baseline only. A combined rehearsal MUST provide its
// frozen predecessor explicitly and retain it with the candidate's test log.
const beforeRef =
  process.env.ALLRICE_RUN_RETIREMENT_BEFORE_SHA ??
  '9daa017c3ae370a0b63938c2228217ba570af8f2';
suite(
  'retired assistants: real ordinary delivery across one stopped upgrade',
  () => {
    let upgrade: Awaited<ReturnType<typeof createRetirementUpgradeFixture>>;
    let harness: DeliveryHarness | undefined;
    let cohorts: DeliveryCohort[];
    let replies: string[] = [];
    beforeAll(async () => {
      expect(beforeRef).toMatch(/^[a-f0-9]{40}$/);
      upgrade = await createRetirementUpgradeFixture({
        beforeRef,
        beforeDriver: fileURLToPath(
          new URL('./retired-assistant-delivery.before.ts', import.meta.url),
        ),
      });
      expect(upgrade.descriptor.beforeRef).toBe(beforeRef);
      cohorts = upgrade.descriptor.cohorts as unknown as DeliveryCohort[];
      expect(cohorts.map((cohort) => cohort.kind)).toEqual([
        'never-enabled',
        'previously-enabled',
      ]);
      const migration = await upgrade.applyRetirement();
      console.info(
        'retirement-delivery-upgrade',
        JSON.stringify({
          beforeRef,
          schema: upgrade.descriptor.schema,
          storageRoot: upgrade.descriptor.storageRoot,
          migrations: upgrade.descriptor.migrations,
          migration,
          cohorts: cohorts.map((cohort) => ({
            kind: cohort.kind,
            userId: cohort.context.actor.id,
            sessionId: cohort.sessionId,
            ordinaryRuns: cohort.ordinaryRuns.map((run) => ({
              runId: run.runId,
              jobId: run.jobId,
              messageIds: run.messageIds,
              artifactVersionIds: run.artifactVersionIds,
              checksums: run.checksums,
            })),
          })),
        }),
      );
    }, 300000);
    afterAll(async () => {
      try {
        await harness?.close();
      } finally {
        try {
          if (upgrade) {
            const cleanup = await upgrade.close();
            expect(cleanup).toMatchObject({
              schemaRemoved: true,
              storageRemoved: true,
              databaseClosed: true,
              adminClosed: true,
            });
            console.info(
              'retirement-delivery-cleanup',
              JSON.stringify(cleanup),
            );
          }
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }
      }
    }, 30000);
    const resources = () => ({
      db: upgrade.db,
      storage: upgrade.storage,
      storageRoot: upgrade.descriptor.storageRoot,
      nativeRoot: upgrade.descriptor.nativeRoot,
    });
    async function assertHistory(cohort: DeliveryCohort) {
      const { db } = upgrade;
      for (const old of cohort.ordinaryRuns) {
        expect(jsonValue(await deliveryState(db, old.runId))).toEqual(
          old.runBefore,
        );
        const messages =
          await db`select id,role,status,content from allrice_messages where id=any(${old.messageIds}::uuid[]) order by id`;
        expect(jsonValue(messages)).toEqual(old.messagesBefore);
        const [version] =
          await db`select * from allrice_deliverable_versions where id=${old.artifact.version.id}`;
        expect(jsonValue(version)).toEqual(old.versionBefore);
        const bytes = await readDeliveryBytes(resources(), old.artifact);
        expect(bytes.toString('base64')).toBe(old.bytesBase64);
        expect(sha256(bytes)).toBe(old.checksums[0]);
        const [binding] =
          await db`select * from allrice_native_session_bindings where context_id=${cohort.sessionId}`;
        expect(jsonValue(binding)).toEqual(old.bindingBefore);
        const [chat] =
          await db`select native_root_origin from allrice_chat_sessions where id=${cohort.sessionId}`;
        expect(jsonValue(chat!.native_root_origin)).toEqual(old.originBefore);
      }
    }
    it('preserves real successful histories, immutable bytes, revisions and native preferences for both members', async () => {
      const { db } = upgrade;
      const [scope] =
        await db`select current_schema() schema,current_setting('search_path') path`;
      expect(scope!.schema).toBe(upgrade.descriptor.schema);
      expect(scope!.path).toBe(`${upgrade.descriptor.schema},public`);
      for (const relation of [
        'allrice_assistant_roots',
        'allrice_assistant_instances',
        'allrice_assistant_messages',
        'allrice_assistant_results',
        'allrice_assistant_usage',
        'allrice_assistant_artifacts',
        'allrice_assistant_model_admissions',
        'allrice_assistant_price_snapshots',
        'allrice_assistant_cost_receipts',
        'allrice_development_deliveries',
        'allrice_development_reviews',
        'allrice_development_verifiers',
        'allrice_development_merge_sources',
        'allrice_development_merges',
        'allrice_development_proposals',
        'allrice_development_assignments',
        'allrice_development_heads',
      ]) {
        const [row] =
          await db`select to_regclass(format('%I.%I',current_schema(),${relation}::text)) is null absent`;
        expect(row!.absent).toBe(true);
      }
      for (const cohort of cohorts) {
        await assertHistory(cohort);
        const settings =
          await db`select revision,settings from allrice_member_work_automation where organization_id=${cohort.context.organizationId} and workspace_id=${cohort.workspaceId} and user_id=${cohort.context.actor.id}`;
        expect(jsonValue(settings)).toEqual(
          cohort.kind === 'never-enabled'
            ? []
            : [
                {
                  revision: cohort.workAutomationBefore!.revision,
                  settings: { cloud: false, computer: true },
                },
              ],
        );
        const preferences =
          await db`select * from allrice_user_preferences where user_id=${cohort.context.actor.id}`;
        expect(preferences).toHaveLength(1);
        expect(jsonValue(preferences)).toEqual(cohort.nativePreferencesBefore);
        expect(preferences[0]).toMatchObject({
          question_wait_mode: 'timed',
          question_wait_seconds: 47,
        });
        expect(Number(preferences[0]!.subagent_max_depth)).toBe(2);
        expect(Number(preferences[0]!.subagent_max_active)).toBe(5);
        const audits =
          await db`select id,action,metadata from allrice_audit_events where actor_id=${cohort.context.actor.id} and action='member.work_automation.update' order by metadata->>'revision'`;
        expect(jsonValue(audits)).toEqual(cohort.auditEventsBefore);
        expect(audits.map((row) => row.id)).toEqual(cohort.auditEventIds);
      }
      harness = await createDeliveryHarness(resources(), async () => {
        const text = replies.shift();
        if (text === undefined)
          throw Error('retirement_unexpected_model_request');
        return { text };
      });
      for (const cohort of cohorts) await harness.connectSubject(cohort);
    }, 30000);

    it.each(['never-enabled', 'previously-enabled'] as const)(
      '%s continues the same chat with checked proof, exact files and at most one text repair',
      async (kind) => {
        const cohort = cohorts.find((value) => value.kind === kind)!;
        const h = harness!;
        const task = await h.prepare(
          cohort,
          '继续之前的月报，整理本月数据并把文件下载链接给我。',
        );
        try {
          expect(task.snapshot.finalDeliveryPolicy).toEqual({
            version: 1,
            mode: 'checked_native_v1',
            artifactId: deliveryArtifactId,
          });
          expect(task.snapshot.officeFirstDeliveryPolicy).toBe(
            'xlsx_formula_cache_v1',
          );
          const bytes = Buffer.from(
            `升级后的普通月报 ${kind}\n收入 1500，支出 520，结余 980。\n`,
          );
          const artifact = await publishDelivery(h, cohort, task, bytes);
          const answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
          const repair = kind === 'previously-enabled';
          replies = repair
            ? [`[月报](/api/v1/files/${randomUUID()}/download)`, answer]
            : [answer];
          const requests = h.model.requests.length;
          const result = await task.run();
          const coverage = await assertDeliveryProof(
            h,
            cohort,
            task,
            result,
            artifact,
          );
          expect(coverage.proof.nativeSessionId).toBe(
            cohort.ordinaryRuns[0]!.nativeSessionId,
          );
          const starts =
            await h.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started' order by sequence`;
          expect(starts).toHaveLength(repair ? 2 : 1);
          expect(h.model.requests.length - requests).toBe(repair ? 2 : 1);
          expect(replies).toHaveLength(0);
          // A continued native conversation receives the real pre-upgrade answer.
          expect(
            JSON.stringify(h.model.requests[requests]!.messages),
          ).toContain(cohort.ordinaryRuns[0]!.artifact.object.id);
          if (repair) {
            const second = h.model.requests[requests + 1]!;
            // Native tool schemas stay in the conversation. The existing
            // public tools.guard/pre-execute seam rejects repair tool calls;
            // its attempted-call coverage lives in native-subagent/final-delivery.
            const repairContext = JSON.stringify(second.messages);
            expect(repairContext).toContain('allrice-platform-host');
            expect(repairContext).toContain('final-delivery-repair');
            expect(repairContext).toContain(artifact.object.id);
          }
          expect(await readDeliveryBytes(resources(), artifact)).toEqual(bytes);
          expect(artifact.object.checksum).toBe(sha256(bytes));
          await completeDelivery(task, result);
          expect(await deliveryState(h.db, task.runId)).toMatchObject({
            status: 'succeeded',
            state: 'succeeded',
            text: answer,
            successes: 1,
          });
          const [released] =
            await h.db`select active_run_id,active_turn_id,worker_id from allrice_conversation_runtimes where session_id=${cohort.sessionId}`;
          expect(released).toEqual({
            active_run_id: null,
            active_turn_id: null,
            worker_id: null,
          });
          await assertHistory(cohort);
          console.info(
            'retirement-delivery-complete',
            JSON.stringify({
              kind,
              runId: task.runId,
              jobId: task.workflowLease.jobId,
              proof: coverage.proof,
              versionId: artifact.version.id,
              checksum: artifact.object.checksum,
              nativeStarts: starts.map((row) => row.payload),
              modelRequests: h.model.requests.length - requests,
            }),
          );
        } finally {
          await task.cleanup();
        }
      },
      60000,
    );

    it.each(['never-enabled', 'previously-enabled'] as const)(
      '%s cannot complete ordinary text without its native candidate',
      async (kind) => {
        const cohort = cohorts.find((value) => value.kind === kind)!;
        const h = harness!;
        const task = await h.prepare(
          cohort,
          '解释月报中的收支计算，不需要新文件。',
        );
        replies = ['收入减去支出就是结余。'];
        const requests = h.model.requests.length;
        const finalDelivery = DshProtocolClient.prototype.finalDelivery;
        const boundary = vi
          .spyOn(DshProtocolClient.prototype, 'finalDelivery')
          .mockImplementation(async function (
            this: DshProtocolClient,
            action,
            params,
          ) {
            const result = await finalDelivery.call(this, action, params);
            // Only drop the response at the public JSON-RPC boundary. The real Host
            // still settles the native turn and the real Worker must fail closed.
            return action === 'candidate'
              ? (null as unknown as Record<string, unknown>)
              : result;
          });
        try {
          expect(task.snapshot.finalDeliveryPolicy.mode).toBe(
            'checked_native_v1',
          );
          await expect(task.run()).rejects.toMatchObject({
            code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
            retryable: false,
          });
          expect(await deliveryState(h.db, task.runId)).toMatchObject({
            successes: 0,
          });
          expect(h.model.requests.length - requests).toBe(1);
          await failJob({
            ...task.workflowLease,
            code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
            message: 'Missing candidate at public protocol boundary',
            retryable: false,
          });
          expect(await deliveryState(h.db, task.runId)).toMatchObject({
            status: 'failed',
            state: 'failed',
            successes: 0,
          });
          await assertHistory(cohort);
        } finally {
          boundary.mockRestore();
          await task.cleanup();
        }
      },
      60000,
    );
  },
);
