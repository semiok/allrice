import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmployeeRuntimePackage } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';
import { createSession, authenticateSession } from './identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from './workspace/service.ts';
import { nativeRootDigest } from './conversation/native-root-origin.ts';
import { selectCheckedFinalDeliveryArtifact } from './final-delivery-rollout.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
// `earlier` is a previous release of the same DSH generation (MET-221).
const current = 'sha256:' + 'a'.repeat(64),
  earlier = 'sha256:' + 'b'.repeat(64);

suite(
  'checked delivery follows the generation, artifact IDs are provenance: real isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      const e = await createEmployeeAdministrationFixture(fixture.db);
      const skills = await fixture.db<
        Parameters<typeof buildEmployeeRuntimePackage>[0]['skills']
      >`select * from allrice_platform_dsh_skills where id=${e.skillId}`;
      // Freeze the exact tools this suite actually uses, rather than granting
      // extra tools outside the immutable source package as the old fixture did.
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...e.definition,
          capabilities: {
            ...e.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.export.create'],
          },
        },
        skills,
      });
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);
    async function subject(artifact = current) {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        runtimePackage,
        allowedTools: runtimePackage.runtimeManifest.toolNames,
        runtimePolicy: {
          harness: 'dsh',
          provider: runtimePackage.runtimeManifest.provider,
          model: runtimePackage.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic',
          baseUrl: null,
        },
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('isolated login required');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
      const session = await createAssignedChatSession(context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Synthetic package rollout',
      });
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
      return { ...f, context, chat: session.id };
    }
    type Subject = Awaited<ReturnType<typeof subject>>;
    async function send(
      f: Subject,
      chat = f.chat,
      clientMessageId = randomUUID(),
    ) {
      return sendChatMessage(f.context, f.workspace, chat, {
        text: 'Synthetic no-model delivery admission',
        clientMessageId,
        deliveryMode: 'follow_up',
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
    it('freezes both checks for a current birth; a retry under a later release cannot rewrite its queued snapshot', async () => {
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
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', earlier);
      try {
        const replay = await send(f, f.chat, id);
        expect(replay.run!.id).toBe(sent.run!.id);
        expect(await snapshot(sent.run!.id)).toEqual(before);
      } finally {
        vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
      }
    });
    it('a chat born under an earlier release of the generation keeps checked delivery; its origin artifact is provenance', async () => {
      const f = await subject(earlier);
      await pin(f);
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, input(f)),
        ),
      ).toBe(earlier);
      const sent = await send(f),
        value = await snapshot(sent.run!.id);
      expect(value.finalDeliveryPolicy).toEqual({
        version: 1,
        mode: 'checked_native_v1',
        artifactId: earlier,
      });
      expect(value.officeFirstDeliveryPolicy).toBe('xlsx_formula_cache_v1');
    });
    it('a chat created before a release and first executed after it (pin = later release, origin = earlier) still admits messages', async () => {
      const f = await subject(earlier);
      await pin(f, { artifact: current });
      for (let i = 0; i < 2; i++) {
        const sent = await send(f),
          value = await snapshot(sent.run!.id);
        expect(value.finalDeliveryPolicy).toMatchObject({
          mode: 'checked_native_v1',
          artifactId: earlier,
        });
      }
    });
    it('ignores the retired checked-delivery allowlist', async () => {
      const f = await subject();
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', 'not-json');
      try {
        const sent = await send(f);
        expect(
          (await snapshot(sent.run!.id)).finalDeliveryPolicy,
        ).toMatchObject({ mode: 'checked_native_v1', artifactId: current });
      } finally {
        vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', undefined);
      }
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
    it('a pre-upgrade NULL business origin receives no new protocol marker', async () => {
      const f = await subject();
      const value = await snapshot((await send(f, f.session)).run!.id);
      expect(value).not.toHaveProperty('finalDeliveryPolicy');
      expect(value).not.toHaveProperty('officeFirstDeliveryPolicy');
    });
    it.each(['basis', 'digest', 'owner'] as const)(
      'rejects a conflicting %s pin before creating a new Run',
      async (kind) => {
        const f = await subject();
        const other = kind === 'owner' ? await subject() : undefined;
        await pin(
          f,
          kind === 'basis'
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
  },
);
