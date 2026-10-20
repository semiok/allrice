/** Real PostgreSQL/StoragePort integration. Opt-in isolated fixture only; no
 * provider, Worker, Dev server, real tenant or native Host is invoked here. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RegisterWorkflowPackageInputSchema,
  WorkflowDefinitionSchema,
  type EmployeeContentMutation,
  type EmployeeContentReceipt,
  type RequestContext,
  type WorkflowPackage,
  type WorkflowPackageManifest,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from '../assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import { createStorageMetadata, markStorageReady } from '../data.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../employees/employee-config.ts';
import {
  changeEmployeeInstanceLifecycle,
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
} from '../employees/employee-instances.ts';
import {
  getEffectiveEmployeeContent,
  mutateEmployeeContent,
} from '../employees/employee-content.ts';
import { resolveEmployeeContentSource } from '../employees/employee-content-sources.ts';
import { manageEmployeeAssignments } from '../employees/employeehub.ts';
import { authorizeFixturePlatformAdministrator } from '../platform-authority.fixture.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  createWorkflow,
  manageEmployeeCapabilities,
  resolveEmployeeCapabilitiesForRun,
} from './capability-registry.ts';
import {
  assertWorkflowPackageExecution,
  listWorkflowPackages,
  readWorkflowPackageSourceForInstance,
  registerWorkflowPackage,
  resolveWorkflowPackageForInstance,
  setWorkflowPackageBinding,
} from './workflow-packages.ts';
import { workflowPackageBytesChecksum } from './workflow-package-model.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'MET194 Workflow packages (isolated PostgreSQL and real source bytes)',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      // Substitute only the connection destination. Every repository query,
      // trigger, constraint and transaction below runs on real PostgreSQL.
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120_000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30_000);

    async function principal(
      organizationSlug = `workflow-packages-${randomUUID()}`,
    ) {
      const value = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug,
          organizationName: 'Synthetic Workflow package company',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic package workspace',
          email: `${randomUUID()}@example.test`,
          displayName: 'Synthetic package owner',
          role: 'member',
        },
        fixture.db,
      );
      const session = await createSession(value.user.id);
      const context = await authenticateSession(session.token, {
        organizationId: value.organizationId,
        workspaceId: value.workspaceId,
      });
      if (!context) throw Error('workflow_package_fixture_login');
      return { ...value, context };
    }

    async function setup() {
      const slug = `workflow-packages-${randomUUID()}`;
      const owner = await principal(slug);
      const peer = await principal(slug);
      const employeeId = randomUUID();
      const versionId = randomUUID();
      const key = `workflow-package-${randomUUID()}`;
      const manifest = employeeManifest({
        key,
        name: 'Synthetic package employee',
        description: 'Isolated Workflow package authority fixture',
        toolNames: ['workspace.file.list'],
      });
      await fixture.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${employeeId},${owner.organizationId},${owner.workspaceId},${key},'Synthetic package employee')`;
      await fixture.db`insert into allrice_employee_versions
      (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${versionId},${owner.organizationId},${owner.workspaceId},${employeeId},1,
        ${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${fixture.db.json(manifest.capabilities)},
        ${employeeManifestChecksum(manifest)},${fixture.db.json(manifest)},${fixture.db.json(manifest.provider)})`;
      async function assign(userId: string) {
        const id = randomUUID();
        await fixture.db`insert into allrice_employee_assignments
        (id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${id},${owner.organizationId},${owner.workspaceId},${employeeId},${versionId},${userId})`;
        await ensureGeneralEmployeeInstance(fixture.db, id);
        return id;
      }
      const assignmentId = await assign(owner.user.id);
      const peerAssignmentId = await assign(peer.user.id);
      const custom = (
        context: RequestContext,
        assignment: string,
        name: string,
      ) =>
        createEmployeeInstance(context, {
          workspaceId: owner.workspaceId,
          assignmentId: assignment,
          requestId: randomUUID(),
          profile: { name },
        });
      const instance = await custom(
        owner.context,
        assignmentId,
        'Brand content fixture',
      );
      const sibling = await custom(
        owner.context,
        assignmentId,
        'Other personal instance',
      );
      const peerInstance = await custom(
        peer.context,
        peerAssignmentId,
        'Peer personal instance',
      );
      return {
        owner,
        peer,
        employeeId,
        versionId,
        assignmentId,
        peerAssignmentId,
        instance,
        sibling,
        peerInstance,
        setId: randomUUID(),
        contentRevision: 0,
        sceneId: randomUUID(),
        otherSceneId: randomUUID(),
      };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;

    async function installMethods(
      s: Setup,
      commonBody = '只依据给定品牌资料策划，不编造来源。',
    ) {
      const commonEdit = {
        contentId: randomUUID(),
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'procedure' as const,
        title: 'Synthetic common content method',
        body: commonBody,
      };
      const sceneEdit = {
        contentId: randomUUID(),
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'procedure' as const,
        title: 'Synthetic scene content method',
        body: '只处理当前场景已选定的品牌资料。',
      };
      const input: Extract<
        EmployeeContentMutation,
        { operation: 'save_draft' }
      > = {
        workspaceId: s.owner.workspaceId,
        setId: s.setId,
        ownership: {
          scope: 'personal',
          organizationId: s.owner.organizationId,
          ownerId: s.owner.user.id,
        },
        target: { kind: 'instance', instanceId: s.instance.id },
        requestId: randomUUID(),
        expectedRevision: s.contentRevision,
        changeSummary:
          'Publish synthetic exact methods through current content transactions',
        operation: 'save_draft',
        textEdits: [commonEdit, sceneEdit],
        manifest: {
          schemaVersion: 1,
          common: [
            { sourceKind: 'draft_text', contentId: commonEdit.contentId },
          ],
          scenes: [
            {
              id: s.sceneId,
              name: 'Synthetic topics',
              appliesWhen: 'Plan topics',
              references: [
                { sourceKind: 'draft_text', contentId: sceneEdit.contentId },
              ],
            },
            {
              id: s.otherSceneId,
              name: 'Synthetic alternate',
              appliesWhen: 'Other work',
              references: [
                { sourceKind: 'draft_text', contentId: sceneEdit.contentId },
              ],
            },
          ],
          declaredConflicts: [],
        },
      };
      function next(
        receipt: EmployeeContentReceipt,
        operation: 'validate' | 'activate',
      ): EmployeeContentMutation {
        return {
          workspaceId: input.workspaceId,
          setId: input.setId,
          ownership: input.ownership,
          target: input.target,
          requestId: randomUUID(),
          expectedRevision: receipt.revision,
          changeSummary: operation,
          operation,
          candidateRevisionId: receipt.candidate.id,
          candidateDigest: receipt.candidate.digest,
        };
      }
      const draft = await mutateEmployeeContent(s.owner.context, input);
      const checked = await mutateEmployeeContent(
        s.owner.context,
        next(draft, 'validate'),
      );
      expect(checked.validation?.valid).toBe(true);
      const active = await mutateEmployeeContent(
        s.owner.context,
        next(checked, 'activate'),
      );
      s.contentRevision = active.revision;
      const current = await getEffectiveEmployeeContent(
        s.owner.context,
        s.instance.id,
      );
      const common = current.sources.find(
        (source) => source.reference.contentId === commonEdit.contentId,
      )!;
      const scene = current.sources.find(
        (source) => source.reference.contentId === sceneEdit.contentId,
      )!;
      expect(common.available && scene.available).toBe(true);
      expect(typeof common.body).toBe('string');
      return {
        common: {
          method: { ...common.reference, sourceKind: 'procedure' as const },
          body: common.body!,
        },
        scene: {
          method: { ...scene.reference, sourceKind: 'procedure' as const },
          body: scene.body!,
        },
      };
    }
    type Method = Awaited<ReturnType<typeof installMethods>>['common'];

    async function storedSource(context: RequestContext, bytes: Uint8Array) {
      const stored = await createStorageMetadata(
        context,
        {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          category: 'exports',
          mediaType: 'application/json',
          sizeBytes: bytes.byteLength,
          checksum: workflowPackageBytesChecksum(bytes),
          visibility: 'private',
          retentionUntil: null,
          immutable: true,
        },
        fixture.db,
      );
      await assistantFixtureStorage(fixture.db).put(
        stored.object,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
      return (await markStorageReady(context, stored.object.id, fixture.db))
        .object;
    }

    async function packageInput(
      s: Setup,
      method: Method,
      options: {
        workflowId?: string;
        expectedRevision?: number;
        sceneId?: string | null;
        definitionLabel?: string;
        methodFileBody?: string;
        fileHashFault?: boolean;
      } = {},
    ) {
      const definition = WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          {
            key: 'read',
            name: 'Read fixed synthetic input',
            kind: 'knowledge',
            input: { query: options.definitionLabel ?? 'immutable-v1' },
          },
        ],
      });
      const files = [
        {
          path: 'workflow.json',
          bytes: Buffer.from(JSON.stringify(definition)),
        },
        {
          path: 'method.md',
          bytes: Buffer.from(options.methodFileBody ?? method.body),
        },
        {
          path: 'scripts/check.mjs',
          bytes: Buffer.from('export const validate = value => value;\n'),
        },
      ].map(({ path, bytes }) => ({
        path,
        checksum: workflowPackageBytesChecksum(bytes),
        contentBase64: bytes.toString('base64'),
      }));
      const persistedFiles = options.fileHashFault
        ? files.map((file) =>
            file.path === 'scripts/check.mjs'
              ? {
                  ...file,
                  contentBase64: Buffer.from(
                    'changed bytes after declared checksum',
                  ).toString('base64'),
                }
              : file,
          )
        : files;
      const source = await storedSource(
        s.owner.context,
        Buffer.from(
          JSON.stringify({ schemaVersion: 1, files: persistedFiles }),
        ),
      );
      const manifest: WorkflowPackageManifest = {
        schemaVersion: 1,
        templateKey: 'brand-content-operations.topics',
        method: method.method,
        definitionChecksum: runtimePolicyDigest(definition),
        source: { objectId: source.id, checksum: source.checksum },
        files: files.map(({ path, checksum }) => ({ path, checksum })),
        assets: [],
      };
      const request = RegisterWorkflowPackageInputSchema.parse({
        workspaceId: s.owner.workspaceId,
        instanceId: s.instance.id,
        sceneId: options.sceneId ?? null,
        requestId: randomUUID(),
        ...(options.workflowId ? { workflowId: options.workflowId } : {}),
        expectedRevision: options.expectedRevision ?? 0,
        slug: 'synthetic-brand-content',
        name: 'Synthetic brand content workflow',
        description: 'Real isolated SQL and package byte verification',
        definition,
        manifest,
      });
      return { request, source };
    }
    const selection = (s: Setup, value: WorkflowPackage) => ({
      workspaceId: s.owner.workspaceId,
      instanceId: s.instance.id,
      sceneId: value.sceneId,
      workflowRevisionId: value.workflow.id,
    });
    const register = (
      s: Setup,
      input: Awaited<ReturnType<typeof packageInput>>['request'],
    ) =>
      registerWorkflowPackage(s.owner.context, input, {
        storage: assistantFixtureStorage(fixture.db),
      });
    const enable = (s: Setup, value: WorkflowPackage, expectedRevision = 0) =>
      setWorkflowPackageBinding(s.owner.context, {
        ...selection(s, value),
        requestId: randomUUID(),
        expectedRevision,
        enabled: true,
      });

    async function storedFrozenRun(s: Setup, value: WorkflowPackage) {
      const runId = randomUUID();
      const invocation = {
        ...selection(s, value),
        frozenPackageDigest: value.checksum,
      };
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${runId},${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},'queued',${fixture.db.json({ workflowInvocation: invocation })},'{}')`;
      await fixture.db`insert into allrice_workflow_runs
      (organization_id,workspace_id,owner_id,run_id,employee_id,workflow_revision_id,status,definition_snapshot,input)
      values(${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},${runId},${s.employeeId},
        ${value.workflow.id},'queued',${fixture.db.json(JSON.parse(JSON.stringify(value.workflow.definition)))},'{}')`;
      return runId;
    }

    it('registers actual ready source bytes with exact published procedure pins and source readback', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const prepared = await packageInput(s, methods.common);
      const value = await register(s, prepared.request);
      expect(value.manifest.method).toEqual(methods.common.method);
      expect(value.manifest.source?.checksum).toBe(prepared.source.checksum);
      expect(value.instanceId).toBe(s.instance.id);
      const active = await enable(s, value);
      expect(active).toMatchObject({
        enabled: true,
        revision: 1,
        assignmentId: s.assignmentId,
      });
      const state = await assertWorkflowPackageExecution(
        s.owner.context,
        selection(s, value),
      );
      expect(state.syncStatus).toBe('in_sync');
      expect(state.package.checksum).toBe(value.checksum);
      const bytes = await readWorkflowPackageSourceForInstance(
        s.owner.context,
        selection(s, value),
        assistantFixtureStorage(fixture.db),
      );
      expect(
        Buffer.from(
          bytes!.files.find((file) => file.path === 'method.md')!.contentBase64,
          'base64',
        ).toString(),
      ).toBe(methods.common.body);
      const [stored] =
        await fixture.db`select r.definition,p.manifest,p.source_object_id from allrice_workflow_revisions r
      join allrice_workflow_packages p on p.workflow_revision_id=r.id where r.id=${value.workflow.id}`;
      expect(stored!.definition).toEqual(value.workflow.definition);
      expect(stored!.source_object_id).toBe(prepared.source.id);
      expect(
        (
          await listWorkflowPackages(s.owner.context, {
            workspaceId: s.owner.workspaceId,
            instanceId: s.instance.id,
          })
        ).map((item) => item.package.workflow.id),
      ).toContain(value.workflow.id);
    }, 30_000);

    it('serializes identical concurrent registration into one immutable version and rejects changed-input replay', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const [first, replay] = await Promise.all([
        register(s, request),
        register(s, request),
      ]);
      expect(replay).toEqual(first);
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_workflow_packages where owner_id=${s.owner.user.id}) as packages,
      (select count(*)::int from allrice_workflow_package_requests where owner_id=${s.owner.user.id} and request_id=${request.requestId}) as receipts`;
      expect(counts).toMatchObject({ packages: 1, receipts: 1 });
      await expect(
        register(s, {
          ...request,
          description: 'Different input under the same request',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const bindRequest = {
        ...selection(s, first),
        requestId: randomUUID(),
        expectedRevision: 0,
        enabled: true,
      };
      const bound = await setWorkflowPackageBinding(
        s.owner.context,
        bindRequest,
      );
      expect(
        await setWorkflowPackageBinding(s.owner.context, bindRequest),
      ).toEqual(bound);
      await expect(
        setWorkflowPackageBinding(s.owner.context, {
          ...bindRequest,
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    }, 30_000);

    it('keeps v1 immutable through a v2 upgrade, preserves its frozen Run and refuses historical selection for a new Run', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const p1 = await packageInput(s, methods.common);
      const v1 = await register(s, p1.request);
      const b1 = await enable(s, v1);
      const runId = await storedFrozenRun(s, v1);
      const p2 = await packageInput(s, methods.common, {
        workflowId: v1.workflow.workflowId,
        expectedRevision: 1,
        definitionLabel: 'immutable-v2',
      });
      const v2 = await register(s, p2.request);
      const b2 = await enable(s, v2, b1.revision);
      expect(b2.id).toBe(b1.id);
      expect(b2.revision).toBe(2);
      expect(v2.workflow.workflowId).toBe(v1.workflow.workflowId);
      expect(v2.workflow.revision).toBe(2);
      expect(v2.checksum).not.toBe(v1.checksum);
      await expect(
        assertWorkflowPackageExecution(s.owner.context, selection(s, v1)),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      const [run] =
        await fixture.db`select r.execution_spec,w.workflow_revision_id,w.definition_snapshot
      from allrice_runs r join allrice_workflow_runs w on w.run_id=r.id where r.id=${runId}`;
      const frozen = await assertWorkflowPackageExecution(
        s.owner.context,
        run!.execution_spec.workflowInvocation,
      );
      expect(frozen.package).toEqual(v1);
      expect(frozen.binding?.workflowRevisionId).toBe(v2.workflow.id);
      expect(run!.workflow_revision_id).toBe(v1.workflow.id);
      expect(run!.definition_snapshot).toEqual(v1.workflow.definition);
      expect(
        (
          await assertWorkflowPackageExecution(
            s.owner.context,
            selection(s, v2),
          )
        ).package.workflow.id,
      ).toBe(v2.workflow.id);
      expect(
        (
          await resolveWorkflowPackageForInstance(
            s.owner.context,
            selection(s, v1),
          )
        ).package,
      ).toEqual(v1);
      await fixture.db`update allrice_workflow_revisions set status='revoked' where id=${v2.workflow.id}`;
      await expect(
        assertWorkflowPackageExecution(
          s.owner.context,
          run!.execution_spec.workflowInvocation,
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        fixture.db`update allrice_workflow_packages set manifest=manifest||'{"tampered":true}'::jsonb where workflow_revision_id=${v1.workflow.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        fixture.db`update allrice_workflow_revisions set name='Tampered v1' where id=${v1.workflow.id}`,
      ).rejects.toThrow('immutable');
      await fixture.db`update allrice_workflow_revisions set status='revoked' where id=${v1.workflow.id}`;
      await expect(
        fixture.db`update allrice_workflow_revisions set name='Tampered after revocation' where id=${v1.workflow.id}`,
      ).rejects.toThrow('immutable');
      const stale = await packageInput(s, methods.common, {
        workflowId: v1.workflow.workflowId,
        expectedRevision: 1,
        definitionLabel: 'stale-CAS',
      });
      await expect(register(s, stale.request)).rejects.toMatchObject({
        code: 'conflict',
      });
    }, 30_000);

    it('enforces owner, sibling-instance, general-instance, workspace and company isolation without granting source metadata', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const value = await register(s, request);
      await enable(s, value);
      await expect(
        resolveWorkflowPackageForInstance(s.peer.context, selection(s, value)),
      ).rejects.toThrow();
      await expect(
        listWorkflowPackages(s.peer.context, {
          workspaceId: s.owner.workspaceId,
          instanceId: s.instance.id,
        }),
      ).rejects.toThrow();
      await expect(
        resolveWorkflowPackageForInstance(s.owner.context, {
          ...selection(s, value),
          instanceId: s.sibling.id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        registerWorkflowPackage(
          s.owner.context,
          { ...request, requestId: randomUUID(), instanceId: s.assignmentId },
          { storage: assistantFixtureStorage(fixture.db) },
        ),
      ).rejects.toThrow();
      await expect(
        resolveWorkflowPackageForInstance(s.owner.context, {
          ...selection(s, value),
          workspaceId: randomUUID(),
        }),
      ).rejects.toThrow();
      const foreign = await principal();
      await expect(
        resolveWorkflowPackageForInstance(foreign.context, {
          ...selection(s, value),
          workspaceId: foreign.workspaceId,
        }),
      ).rejects.toThrow();
      await expect(
        setWorkflowPackageBinding(s.owner.context, {
          ...selection(s, value),
          instanceId: s.sibling.id,
          requestId: randomUUID(),
          expectedRevision: 0,
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const peerSource = await storedSource(
        s.peer.context,
        Buffer.from('Foreign owner source'),
      );
      await expect(
        register(s, {
          ...request,
          requestId: randomUUID(),
          manifest: {
            ...request.manifest,
            source: { objectId: peerSource.id, checksum: peerSource.checksum },
          },
        }),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
    }, 30_000);

    it('does not make scene-only bindings runnable from common or another scene', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.scene, {
        sceneId: s.sceneId,
      });
      const value = await register(s, request);
      await enable(s, value);
      const directory = (sceneId: string | null) =>
        resolveEmployeeCapabilitiesForRun({
          organizationId: s.owner.organizationId,
          workspaceId: s.owner.workspaceId,
          actorId: s.owner.user.id,
          employeeId: s.employeeId,
          instanceId: s.instance.id,
          sceneId,
        });
      expect((await directory(null)).workflows).toHaveLength(0);
      expect((await directory(s.otherSceneId)).workflows).toHaveLength(0);
      expect(
        (await directory(s.sceneId)).workflows.map(
          (binding) => binding.revision.id,
        ),
      ).toEqual([value.workflow.id]);
      await expect(
        assertWorkflowPackageExecution(s.owner.context, {
          ...selection(s, value),
          sceneId: null,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        assertWorkflowPackageExecution(s.owner.context, {
          ...selection(s, value),
          sceneId: s.otherSceneId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const read = (sceneId: string | null) =>
        resolveEmployeeContentSource({
          context: s.owner.context,
          employeeId: s.employeeId,
          instanceId: s.instance.id,
          sceneId,
          ownership: {
            scope: 'personal',
            organizationId: s.owner.organizationId,
            ownerId: s.owner.user.id,
          },
          ref: {
            sourceKind: 'workflow',
            contentId: value.workflow.workflowId,
            revisionId: value.workflow.id,
            digest: value.workflow.checksum,
          },
          sql: fixture.db,
          lock: false,
          allowDraft: false,
        });
      expect((await read(s.sceneId)).dto.available).toBe(true);
      expect((await read(null)).dto.available).toBe(false);
      expect((await read(s.otherSceneId)).dto).not.toHaveProperty('body');
    }, 30_000);

    it('preserves legacy NULL employee bindings across private activation and preserves private bindings across legacy replacement', async () => {
      const s = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, s.owner.user.id);
      const legacy = await createWorkflow(s.owner.context, {
        workspaceId: s.owner.workspaceId,
        slug: `legacy-${randomUUID()}`,
        name: 'Legacy employee workflow',
        description: 'Original NULL scope semantics',
        definition: WorkflowDefinitionSchema.parse({
          schemaVersion: 1,
          steps: [{ key: 'read', name: 'Legacy read', kind: 'knowledge' }],
        }),
      });
      const manage = () =>
        manageEmployeeCapabilities(s.owner.context, {
          workspaceId: s.owner.workspaceId,
          employeeId: s.employeeId,
          agentSkills: [],
          knowledgeRevisionIds: [],
          workflowRevisionIds: [legacy.id],
        });
      await manage();
      const [oldBinding] =
        await fixture.db`select * from allrice_employee_workflow_bindings where workflow_revision_id=${legacy.id}`;
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const value = await register(s, request);
      const privateBinding = await enable(s, value);
      await manage();
      const [preserved] =
        await fixture.db`select * from allrice_employee_workflow_bindings where id=${oldBinding!.id}`;
      expect(preserved).toMatchObject({
        enabled: true,
        instance_id: null,
        owner_id: null,
        assignment_id: null,
        scene_id: null,
        workflow_id: null,
        package_checksum: null,
      });
      const [privateRow] =
        await fixture.db`select enabled,workflow_revision_id from allrice_employee_workflow_bindings where id=${privateBinding.id}`;
      expect(privateRow).toMatchObject({
        enabled: true,
        workflow_revision_id: value.workflow.id,
      });
      const legacyOnly = await resolveEmployeeCapabilitiesForRun({
        organizationId: s.owner.organizationId,
        workspaceId: s.owner.workspaceId,
        employeeId: s.employeeId,
        actorId: s.owner.user.id,
      });
      expect(
        legacyOnly.workflows.map((binding) => binding.revision.id),
      ).toEqual([legacy.id]);
      await expect(
        manageEmployeeCapabilities(s.owner.context, {
          workspaceId: s.owner.workspaceId,
          employeeId: s.employeeId,
          workflowRevisionIds: [value.workflow.id],
        }),
      ).rejects.toMatchObject({ code: 'invalid_binding' });
      await expect(fixture.db`insert into allrice_employee_workflow_bindings
      (organization_id,workspace_id,employee_id,workflow_revision_id,bound_by)
      values(${s.owner.organizationId},${s.owner.workspaceId},${s.employeeId},${value.workflow.id},${s.owner.user.id})`).rejects.toThrow(
        'employee-wide',
      );
    }, 30_000);

    it('rejects new and frozen admission immediately after the exact binding is disabled, including stale enable replay', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const value = await register(s, request);
      const enableRequest = {
        ...selection(s, value),
        requestId: randomUUID(),
        expectedRevision: 0,
        enabled: true,
      };
      const bound = await setWorkflowPackageBinding(
        s.owner.context,
        enableRequest,
      );
      const disabled = await setWorkflowPackageBinding(s.owner.context, {
        ...selection(s, value),
        requestId: randomUUID(),
        expectedRevision: bound.revision,
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);
      await expect(
        assertWorkflowPackageExecution(s.owner.context, selection(s, value)),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        assertWorkflowPackageExecution(s.owner.context, {
          ...selection(s, value),
          frozenPackageDigest: value.checksum,
        }),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        setWorkflowPackageBinding(s.owner.context, enableRequest),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        (
          await resolveWorkflowPackageForInstance(
            s.owner.context,
            selection(s, value),
          )
        ).binding?.enabled,
      ).toBe(false);
    }, 30_000);

    it('rechecks real assignment withdrawal and instance archival for a previously admitted frozen package', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const value = await register(s, request);
      await enable(s, value);
      const frozen = {
        ...selection(s, value),
        frozenPackageDigest: value.checksum,
      };
      expect(
        (await assertWorkflowPackageExecution(s.owner.context, frozen)).binding
          ?.enabled,
      ).toBe(true);
      await authorizeFixturePlatformAdministrator(fixture.db, s.owner.user.id);
      await manageEmployeeAssignments(s.owner.context, {
        workspaceId: s.owner.workspaceId,
        employeeId: s.employeeId,
        userIds: [s.peer.user.id],
      });
      await expect(
        assertWorkflowPackageExecution(s.owner.context, frozen),
      ).rejects.toThrow();
      await manageEmployeeAssignments(s.owner.context, {
        workspaceId: s.owner.workspaceId,
        employeeId: s.employeeId,
        userIds: [s.owner.user.id, s.peer.user.id],
      });
      expect(
        (await assertWorkflowPackageExecution(s.owner.context, frozen)).package
          .workflow.id,
      ).toBe(value.workflow.id);
      await changeEmployeeInstanceLifecycle(s.owner.context, s.instance.id, {
        workspaceId: s.owner.workspaceId,
        expectedRevision: s.instance.revision,
        requestId: randomUUID(),
        operation: 'archive',
      });
      await expect(
        assertWorkflowPackageExecution(s.owner.context, frozen),
      ).rejects.toThrow();
    }, 30_000);

    it('keeps the old executable while a new method awaits synchronization, without registering a stale method pin again', async () => {
      const s = await setup();
      const methods = await installMethods(s);
      const { request } = await packageInput(s, methods.common);
      const value = await register(s, request);
      await enable(s, value);
      await installMethods(s, '新版方法：核对来源后只提交固定业务字段。');
      const state = await assertWorkflowPackageExecution(s.owner.context, {
        ...selection(s, value),
        frozenPackageDigest: value.checksum,
      });
      expect(state.syncStatus).toBe('method_changed');
      expect(state.package.manifest.method).toEqual(methods.common.method);
      await expect(
        register(s, { ...request, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'source_changed' });
    }, 30_000);

    it.each([
      'method_bytes',
      'file_hash',
      'object_hash',
      'definition_hash',
      'method_pin',
    ] as const)(
      'rejects the real source %s counterexample without committing a package',
      async (fault) => {
        const s = await setup();
        const methods = await installMethods(s, '实际保存的方法正文\n');
        expect(methods.common.body).toBe('实际保存的方法正文');
        const prepared = await packageInput(s, methods.common, {
          ...(fault === 'method_bytes'
            ? { methodFileBody: `${methods.common.body}\n` }
            : {}),
          fileHashFault: fault === 'file_hash',
        });
        if (fault === 'object_hash') {
          // Deliberate corruption inside this isolated fixture's storage, while DB
          // and manifest retain their original exact object checksum.
          const bytes = Buffer.from('tampered physical package bytes');
          await assistantFixtureStorage(fixture.db).put(
            {
              ...prepared.source,
              checksum: workflowPackageBytesChecksum(bytes),
              sizeBytes: bytes.length,
            },
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          );
        }
        const request =
          fault === 'definition_hash'
            ? {
                ...prepared.request,
                manifest: {
                  ...prepared.request.manifest,
                  definitionChecksum: `sha256:${'f'.repeat(64)}`,
                },
              }
            : fault === 'method_pin'
              ? {
                  ...prepared.request,
                  manifest: {
                    ...prepared.request.manifest,
                    method: {
                      ...prepared.request.manifest.method,
                      digest: `sha256:${'f'.repeat(64)}`,
                    },
                  },
                }
              : prepared.request;
        await expect(register(s, request)).rejects.toMatchObject({
          code: 'source_changed',
        });
        const [row] =
          await fixture.db`select count(*)::int as count from allrice_workflow_packages where owner_id=${s.owner.user.id}`;
        expect(row!.count).toBe(0);
      },
      30_000,
    );
  },
);
