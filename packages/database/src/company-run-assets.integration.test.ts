import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type {
  CompanyAsset,
  CompanyAssetContent,
  CompanyRunSnapshot,
  ExecutionContext,
  RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { mutateCompanyAsset, listCompanyAssets } from './company-assets.ts';
import {
  captureCompanyRunAssets,
  getCompanyRunMaterial,
  markCompanyMaterialRead,
  markCompanyRunLoaded,
  prepareCompanyRunMaterials,
} from './company-run-assets.ts';
import { getStoredFile } from './data.ts';
import {
  inspectCompanyDeliverable,
  readArtifactBytes,
} from './artifact-review.ts';
import {
  listWorkspaceFiles,
  linkWorkspaceFileToSession,
} from './workspace/service.ts';
import {
  createToolBrokerExportObject,
  getToolBrokerFile,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'company references in formal Runs (isolated PostgreSQL, real private bytes)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let a: Awaited<ReturnType<typeof tenantValidationFixture>>;
    let owner: RequestContext, reader: RequestContext, admin: RequestContext;
    let template: CompanyAsset, rule: CompanyAsset;
    let readerSession: string, readerAssignment: string, readerVersion: string;
    let v1: CompanyRunSnapshot, execution: ExecutionContext, materialId: string;
    const content = (
      kind: 'rule' | 'template',
      extra: Partial<CompanyAssetContent> = {},
    ): CompanyAssetContent => ({
      kind,
      title: 'Company reference',
      body: 'Use current data.',
      category: '运营',
      appliesToEmployeeIds: [],
      taskKeywords: [],
      slots: [],
      ...extra,
    });
    const mutate = (
      ctx: RequestContext,
      value: unknown,
      administration = false,
    ) =>
      mutateCompanyAsset(
        ctx,
        a.context.organizationId,
        value,
        assistantFixtureStorage(f.db),
        administration,
        f.db,
      );
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      a = await tenantValidationFixture(f.db);
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Platform',
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: 'company-run-admin@example.test',
          displayName: 'Admin',
          role: 'member',
        },
        f.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.context.workspaceId,
      };
      const [org] =
        await f.db`select slug,name from allrice_organizations where id=${owner.organizationId}`;
      const second = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: org!.slug,
          organizationName: org!.name,
          workspaceSlug: 'reader',
          workspaceName: 'Reader',
          email: 'company-run-reader@example.test',
          displayName: 'Reader',
          role: 'member',
        },
        f.db,
      );
      reader = {
        ...(await authenticateSession(
          (await createSession(second.user.id)).token,
        ))!,
        workspaceId: second.workspaceId,
      };
      const readerEmployee = randomUUID();
      readerVersion = randomUUID();
      readerAssignment = randomUUID();
      readerSession = randomUUID();
      await f.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${readerEmployee},${reader.organizationId},${reader.workspaceId},'reader-fixture','Reader fixture')`;
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      select ${readerVersion},${reader.organizationId},${reader.workspaceId},${readerEmployee},1,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot from allrice_employee_versions where id=${a.versionId}`;
      await f.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${readerAssignment},${reader.organizationId},${reader.workspaceId},${readerEmployee},${readerVersion},${reader.actor.id})`;
      await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${readerSession},${reader.organizationId},${reader.workspaceId},${reader.actor.id},'Reader company task',${readerAssignment},${readerVersion})`;
      template = await mutate(owner, {
        operation: 'save',
        assetId: randomUUID(),
        expectedRevision: 0,
        content: content('template', {
          sourceVersionId: a.artifact.artifactId,
          slots: [
            {
              key: 'period',
              label: '本期数据',
              required: true,
              multiline: true,
            },
          ],
        }),
      });
      template = await mutate(owner, {
        operation: 'publish',
        assetId: template.id,
        expectedRevision: template.revision,
      });
      rule = await mutate(
        admin,
        {
          operation: 'save',
          assetId: randomUUID(),
          expectedRevision: 0,
          content: content('rule', { body: 'End the report with CURRENT-V1.' }),
        },
        true,
      );
      rule = await mutate(
        admin,
        {
          operation: 'publish',
          assetId: rule.id,
          expectedRevision: rule.revision,
        },
        true,
      );
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });
    const selection = () => ({
      assetId: template.id,
      revisionId: template.latest.id,
      digest: template.latest.digest,
      parameters: { period: '2026-10: 120 units' },
    });
    const capture = (
      ctx = owner,
      text = 'make report',
      chosen: unknown[] = [selection()],
    ) =>
      f.db.begin((tx) =>
        captureCompanyRunAssets(
          tx,
          ctx,
          a.task.frozenConfiguration.employeeVersionId ?? a.versionId,
          text,
          chosen,
        ),
      );
    async function freeze(
      snapshot: CompanyRunSnapshot,
      ctx = owner,
    ): Promise<ExecutionContext> {
      const run = randomUUID(),
        question = randomUUID(),
        answer = randomUUID(),
        session =
          ctx.actor.id === owner.actor.id
            ? a.task.chatSessionId!
            : readerSession;
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${question},${ctx.organizationId},${ctx.workspaceId},${session},${ctx.actor.id},'user','{"text":"Synthetic selected template"}'),
      (${answer},${ctx.organizationId},${ctx.workspaceId},${session},${ctx.actor.id},'assistant','{"text":""}')`;
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${run},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},'running','{}','{}')`;
      await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot)
      select ${run},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${ctx.actor.id === owner.actor.id ? a.context.workspaceId && (await f.db`select id from allrice_employee_assignments where user_id=${owner.actor.id} limit 1`)[0]!.id : readerAssignment},${ctx.actor.id === owner.actor.id ? a.versionId : readerVersion},${session},${question},${answer},provider_snapshot,${f.db.json({ companyAssets: snapshot })}
      from allrice_employee_runs where run_id=${a.task.runId}`;
      return {
        executionId: randomUUID(),
        runId: run,
        jobId: a.worker.jobId,
        worker: { id: a.worker.workerId, type: 'worker' },
        delegatedBy: { type: 'user', id: ctx.actor.id },
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId: ctx.organizationId,
          subjectId: ctx.actor.id,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          memberships: ctx.memberships,
          grants: [
            {
              resourceType: 'storage_object',
              action: 'resource:read',
              workspaceId: ctx.workspaceId,
            },
          ],
        },
      };
    }
    it('freezes exact rules and selected parameters; a later publication changes only the next snapshot', async () => {
      v1 = await capture();
      execution = await freeze(v1);
      expect(v1.templates[0]!.parameters.period).toContain('120');
      expect(v1.rules[0]!.revision.content.body).toContain('CURRENT-V1');
      rule = await mutate(
        admin,
        {
          operation: 'save',
          assetId: rule.id,
          expectedRevision: rule.revision,
          content: {
            ...rule.latest.content,
            body: 'End the report with CURRENT-V2.',
          },
        },
        true,
      );
      rule = await mutate(
        admin,
        {
          operation: 'publish',
          assetId: rule.id,
          expectedRevision: rule.revision,
        },
        true,
      );
      expect((await capture()).rules[0]!.revision.content.body).toContain(
        'CURRENT-V2',
      );
      const [old] =
        await f.db`select prompt_snapshot from allrice_employee_runs where run_id=${execution.runId}`;
      expect(old!.prompt_snapshot.companyAssets).toEqual(v1);
      rule = await mutate(
        admin,
        {
          operation: 'pause',
          assetId: rule.id,
          expectedRevision: rule.revision,
        },
        true,
      );
      expect((await capture()).rules).toEqual([]);
      expect(old!.prompt_snapshot.companyAssets.rules).toHaveLength(1);
      await expect(
        capture(owner, 'report', [{ ...selection(), parameters: {} }]),
      ).rejects.toThrow('parameters_invalid');
      await expect(
        capture(owner, 'report', [
          { ...selection(), digest: `sha256:${'0'.repeat(64)}` },
        ]),
      ).rejects.toThrow('asset_unavailable');
    });
    it('creates one immutable input per reader/revision and binds it separately to each Run', async () => {
      const one = await prepareCompanyRunMaterials(
        execution,
        v1,
        assistantFixtureStorage(f.db),
        f.db,
      );
      materialId = one[0]!.object.id;
      const next = await freeze(v1);
      const two = await prepareCompanyRunMaterials(
        next,
        v1,
        assistantFixtureStorage(f.db),
        f.db,
      );
      expect(two[0]!.object.id).toBe(materialId);
      const otherSnapshot = await capture(reader),
        other = await freeze(otherSnapshot, reader);
      const three = await prepareCompanyRunMaterials(
        other,
        otherSnapshot,
        assistantFixtureStorage(f.db),
        f.db,
      );
      expect(three[0]!.object.id).not.toBe(materialId);
      expect(three[0]!.object).toMatchObject({
        ownerId: reader.actor.id,
        workspaceId: reader.workspaceId,
        immutable: true,
      });
      const bytes = await readArtifactBytes(
        assistantFixtureStorage(f.db),
        one[0]!.object,
      );
      expect(
        await readArtifactBytes(
          assistantFixtureStorage(f.db),
          three[0]!.object,
        ),
      ).toEqual(bytes);
      expect(
        await f.db`select id from allrice_deliverable_versions where object_id=${materialId}`,
      ).toHaveLength(0);
      const unselected = await freeze(
        await capture(owner, 'ordinary task', []),
      );
      await expect(getToolBrokerFile(unselected, materialId)).rejects.toThrow(
        'authorization_denied',
      );
    });
    it('excludes material and company snapshot IDs from generic downloads, lists and attachment linking', async () => {
      for (const id of [materialId, template.latest.file!.objectId]) {
        await expect(getStoredFile(owner, id, f.db)).rejects.toThrow(
          'not_found',
        );
        await expect(
          linkWorkspaceFileToSession({
            context: owner,
            workspaceId: owner.workspaceId!,
            sessionId: a.task.chatSessionId!,
            objectId: id,
          }),
        ).rejects.toThrow('authorization_denied');
        expect(
          (await listWorkspaceFiles(owner, owner.workspaceId!)).map(
            (o) => o.id,
          ),
        ).not.toContain(id);
      }
      expect((await getToolBrokerFile(execution, materialId)).object.id).toBe(
        materialId,
      );
      await expect(
        getCompanyRunMaterial(
          {
            organizationId: owner.organizationId,
            workspaceId: reader.workspaceId!,
            ownerId: reader.actor.id,
            runId: execution.runId,
          },
          materialId,
          f.db,
        ),
      ).rejects.toThrow('authorization_denied');
    });
    it('preserves frozen resource-read grants and expiry for selected company inputs', async () => {
      await expect(
        getToolBrokerFile(
          {
            ...execution,
            policySnapshot: { ...execution.policySnapshot, grants: [] },
          },
          materialId,
        ),
      ).rejects.toThrow('authorization_denied');
      await expect(
        getToolBrokerFile(
          {
            ...execution,
            policySnapshot: {
              ...execution.policySnapshot,
              expiresAt: '2000-01-01T00:00:00Z',
            },
          },
          materialId,
        ),
      ).rejects.toThrow('authorization_denied');
    });
    it('keeps selected, loaded, native-read and source-derived facts distinct and idempotent', async () => {
      const usages = async () =>
        (
          await listCompanyAssets(owner, owner.organizationId, {}, f.db)
        ).assets.find((x) => x.id === template.id)!.usage!;
      expect(await usages()).toMatchObject({
        loadedRuns: 0,
        readRuns: 0,
        derivedRuns: 0,
      });
      await markCompanyRunLoaded(execution);
      await markCompanyRunLoaded(execution);
      expect(await usages()).toMatchObject({ loadedRuns: 1, readRuns: 0 });
      await markCompanyMaterialRead(execution, materialId);
      await markCompanyMaterialRead(execution, materialId);
      expect(await usages()).toMatchObject({
        loadedRuns: 1,
        readRuns: 1,
        derivedRuns: 0,
      });
      const source = (await getToolBrokerFile(execution, materialId)).object;
      const bytes = await readArtifactBytes(
        assistantFixtureStorage(f.db),
        source,
      );
      const object = {
        ...createToolBrokerExportObject({
          context: execution,
          checksum: source.checksum,
          mediaType: source.mediaType,
          sizeBytes: source.sizeBytes,
        }),
        immutable: true,
      };
      await assistantFixtureStorage(f.db).put(
        object,
        new Blob([new Uint8Array(bytes)]).stream(),
      );
      const result = await registerToolBrokerExport(
        {
          context: execution,
          sessionId: a.task.chatSessionId!,
          sourceFile: { objectId: source.id, checksum: source.checksum },
          parentObjectId: source.id,
          fileName: 'new-reader-report.txt',
          format: 'text',
          object,
        },
        f.db,
      );
      expect(result.version).toBe(1);
      const [derived] =
        await f.db`select v.owner_id,v.parent_version_id,d.asset_id from allrice_deliverable_versions v join allrice_company_asset_derivations d on d.deliverable_version_id=v.id where v.object_id=${object.id}`;
      expect(derived).toMatchObject({
        owner_id: owner.actor.id,
        parent_version_id: null,
        asset_id: template.id,
      });
      expect(await usages()).toMatchObject({ derivedRuns: 1 });
      const [published] =
        await f.db`select id from allrice_deliverable_versions where object_id=${object.id}`;
      expect(
        (
          await inspectCompanyDeliverable(
            admin,
            owner.organizationId,
            published!.id,
            f.db,
          )
        ).companyEvidence.companyTemplate,
      ).toMatchObject({
        assetId: template.id,
        revisionId: v1.templates[0]!.revision.id,
        digest: v1.templates[0]!.revision.digest,
        title: v1.templates[0]!.revision.content.title,
        revision: v1.templates[0]!.revision.number,
        sourceChecksum: source.checksum,
      });
    });
    it('retains committed private bytes when the commit acknowledgement is lost', async () => {
      template = await mutate(owner, {
        operation: 'save',
        assetId: template.id,
        expectedRevision: template.revision,
        content: {
          ...template.latest.content,
          body: 'Next fixed revision for acknowledgement test.',
        },
      });
      template = await mutate(owner, {
        operation: 'publish',
        assetId: template.id,
        expectedRevision: template.revision,
      });
      const snapshot = await capture(),
        ctx = await freeze(snapshot);
      const ambiguous = new Proxy(f.db, {
        get(target, key) {
          if (key === 'begin')
            return async (
              callback: (tx: postgres.TransactionSql) => Promise<unknown[]>,
            ) => {
              await target.begin(callback);
              throw Error('commit_acknowledgement_lost');
            };
          return Reflect.get(target, key);
        },
      });
      await expect(
        prepareCompanyRunMaterials(
          ctx,
          snapshot,
          assistantFixtureStorage(f.db),
          ambiguous,
        ),
      ).rejects.toThrow('commit_acknowledgement_lost');
      const retained = (
        await getToolBrokerFile(
          ctx,
          (
            await f.db`select material_object_id from allrice_company_run_assets where run_id=${ctx.runId} and kind='template'`
          )[0]!.material_object_id,
        )
      ).object;
      expect(
        (await readArtifactBytes(assistantFixtureStorage(f.db), retained))
          .byteLength,
      ).toBe(retained.sizeBytes);
      expect(
        (
          await prepareCompanyRunMaterials(
            ctx,
            snapshot,
            assistantFixtureStorage(f.db),
            f.db,
          )
        )[0]!.object.id,
      ).toBe(retained.id);
    });
    it('denies new reads and new derivation after withdrawal or member removal, even for cached inputs', async () => {
      template = await mutate(owner, {
        operation: 'withdraw',
        assetId: template.id,
        expectedRevision: template.revision,
      });
      await expect(getToolBrokerFile(execution, materialId)).rejects.toThrow(
        'asset_unavailable',
      );
      await expect(
        prepareCompanyRunMaterials(
          execution,
          v1,
          assistantFixtureStorage(f.db),
          f.db,
        ),
      ).rejects.toThrow('asset_unavailable');
      template = await mutate(owner, {
        operation: 'publish',
        assetId: template.id,
        expectedRevision: template.revision,
      });
      await f.db`update allrice_memberships set active=false where user_id=${owner.actor.id} and organization_id=${owner.organizationId}`;
      await expect(getToolBrokerFile(execution, materialId)).rejects.toThrow(
        'authorization_denied',
      );
      await f.db`update allrice_memberships set active=true where user_id=${owner.actor.id} and organization_id=${owner.organizationId}`;
      expect((await getToolBrokerFile(execution, materialId)).object.id).toBe(
        materialId,
      );
    });
  },
);
