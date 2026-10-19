import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { queuePlatformEmployeeTestRun } from './employees/platform-employees.ts';
import { createSession, authenticateSession } from './identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from './workspace/service.ts';
import { nativeRootDigest } from './conversation/native-root-origin.ts';
import {
  checkedFinalDeliveryArtifacts,
  selectCheckedFinalDeliveryArtifact,
} from './final-delivery-rollout.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const current = 'sha256:' + 'a'.repeat(64),
  retained = 'sha256:' + 'b'.repeat(64);

suite(
  'checked delivery rollout uses immutable exact package identity: real isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
      vi.stubEnv(
        'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
        JSON.stringify([current]),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      const e = await createEmployeeAdministrationFixture(fixture.db);
      const queued = await queuePlatformEmployeeTestRun(e.employeeId, {
        environment: 'company',
        workspaceId: e.workspaceId,
        ownerId: e.ownerId,
        prompt: 'Synthetic package fixture; never execute a model',
      });
      const [row] =
        await fixture.db`select frozen_runtime_profile from allrice_platform_employee_test_runs where id=${queued.testRun!.id}`;
      runtimePackage = PlatformEmployeeRuntimeProfileSchema.parse(
        row!.frozen_runtime_profile,
      ).runtimePackage!;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);
    async function subject(artifact = current) {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        runtimePackage,
        allowedTools: [
          'assistant.delegate',
          'assistant.report',
          'workspace.export.create',
        ],
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('isolated login required');
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
      const session = await createAssignedChatSession(context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Synthetic package rollout',
      });
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
      return { ...f, context, chat: session.id };
    }
    type Subject = Awaited<ReturnType<typeof subject>>;
    async function send(
      f: Subject,
      chat = f.chat,
      clientMessageId = randomUUID(),
      allowAssistants = true,
    ) {
      return sendChatMessage(f.context, f.workspace, chat, {
        text: 'Synthetic no-model delivery admission',
        clientMessageId,
        deliveryMode: 'follow_up',
        assistantPreference: { mode: 'daily', allowAssistants },
      });
    }
    async function snapshot(runId: string) {
      const [row] =
        await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${runId}`;
      return row!.execution_snapshot;
    }
    const input = (f: Subject) => ({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.chat,
    });
    async function pin(
      f: Subject,
      overrides: {
        artifact?: string;
        basis?: string;
        digest?: string;
        owner?: string;
      } = {},
    ) {
      const [birth] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.chat}`;
      const artifact =
        overrides.artifact ?? birth!.native_root_origin.artifactId;
      await fixture.db`insert into allrice_native_session_bindings
      (native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,storage_context_key,storage_namespace,
       artifact_id,artifact_manifest_digest,distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest)
      values(${'dsh-' + f.chat},${f.org},${f.workspace},${overrides.owner ?? f.user},'chat',${f.chat},${f.chat},'/isolated-retained/sessions',
        ${artifact},${artifact},${birth!.native_root_origin.distributionGeneration},'restricted',${f.rootRunId},${f.worker.jobId},1,
        ${overrides.basis ?? 'business_root_origin'},${overrides.basis === 'approved_compatibility_reader' ? null : (overrides.digest ?? nativeRootDigest(birth!.native_root_origin))})`;
    }
    it('freezes both checks only for the exact approved birth; idempotent retry cannot rewrite its queued snapshot', async () => {
      const f = await subject(),
        id = randomUUID();
      const sent = await send(f, f.chat, id),
        before = await snapshot(sent.run!.id);
      expect(before.finalDeliveryPolicy).toEqual({
        version: 1,
        mode: 'checked_native_v1',
        artifactId: current,
      });
      expect(before.officeFirstDeliveryPolicy).toBe('xlsx_formula_cache_v1');
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '[]');
      try {
        const replay = await send(f, f.chat, id);
        expect(replay.run!.id).toBe(sent.run!.id);
        expect(await snapshot(sent.run!.id)).toEqual(before);
      } finally {
        vi.stubEnv(
          'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
          JSON.stringify([current]),
        );
      }
    });
    it('same-generation retained birth stays legacy despite current primary; a matching historical pin does not imply current protocol', async () => {
      const f = await subject(retained);
      await pin(f);
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, input(f)),
        ),
      ).toBeUndefined();
      const sent = await send(f),
        value = await snapshot(sent.run!.id);
      expect(value).not.toHaveProperty('finalDeliveryPolicy');
      expect(value).not.toHaveProperty('officeFirstDeliveryPolicy');
      const [birth] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.chat}`;
      expect(birth!.native_root_origin.artifactId).toBe(retained);
    });
    it('an exact current pin may point at its historical first Run; current-Run final origin is verified separately', async () => {
      const f = await subject();
      await pin(f);
      const sent = await send(f);
      expect(sent.run!.id).not.toBe(f.rootRunId);
      expect(
        (await snapshot(sent.run!.id)).finalDeliveryPolicy.artifactId,
      ).toBe(current);
    });
    it('a pre-upgrade NULL birth and explicit assistant opt-out receive no new protocol marker', async () => {
      const f = await subject();
      for (const [chat, enabled] of [
        [f.session, true],
        [f.chat, false],
      ] as const) {
        const sent = await send(f, chat, randomUUID(), enabled),
          value = await snapshot(sent.run!.id);
        expect(value).not.toHaveProperty('finalDeliveryPolicy');
        expect(value).not.toHaveProperty('officeFirstDeliveryPolicy');
      }
    });
    it.each(['artifact', 'basis', 'digest', 'owner'] as const)(
      'rejects a conflicting %s pin before creating a new Run',
      async (kind) => {
        const f = await subject();
        const other = kind === 'owner' ? await subject() : undefined;
        await pin(
          f,
          kind === 'artifact'
            ? { artifact: retained }
            : kind === 'basis'
              ? { basis: 'approved_compatibility_reader' }
              : kind === 'digest'
                ? { digest: 'sha256:' + 'c'.repeat(64) }
                : { owner: other!.user },
        );
        await expect(send(f)).rejects.toThrow(
          'FINAL_DELIVERY_NATIVE_ORIGIN_CONFLICT',
        );
        expect(
          await fixture.db`select run_id from allrice_employee_runs where session_id=${f.chat}`,
        ).toHaveLength(0);
      },
    );
    it('missing approval stays off; malformed or duplicate deployment approval fails closed', () => {
      try {
        vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', undefined);
        expect(checkedFinalDeliveryArtifacts()).toEqual([]);
        for (const raw of [
          'not-json',
          '["0.2.1-rc.2"]',
          JSON.stringify([current, current]),
        ]) {
          vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', raw);
          expect(checkedFinalDeliveryArtifacts).toThrow();
        }
      } finally {
        vi.stubEnv(
          'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
          JSON.stringify([current]),
        );
      }
    });
  },
);
