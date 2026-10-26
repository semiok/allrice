import { updateWorkAutomation } from './work-automation.ts';
/** Real PostgreSQL admission tests with synthetic identities in a fresh schema.
 * No model, connector, deployed Worker, tenant enablement or GA proof is claimed. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionModelSnapshotSchema,
  withEmployeeMemorySourceTool,
  type EmployeeExecutionSnapshot,
  type RuntimePolicyControls,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import type { AssistantAuthorityInput } from './assistant-runtime.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';

const phases: AssistantAuthorityInput['phase'][] = [
  'configure',
  'delegate',
  'message',
  'model',
  'tool',
  'recover',
  'evidence',
];
const selectedTools = ['assistant.delegate', 'assistant.report', 'web.fetch'];
const defaultControls = (): RuntimePolicyControls => ({
  version: 1,
  enabled: true,
  mode: 'execute',
  rules: [{ action: 'assistant.delegate', effect: 'allow' }],
});
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'P25 production assistant authority — isolated real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const originalFlag = process.env.ALLRICE_ASSISTANTS_ENABLED;
    beforeAll(async () => {
      process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
      fixture = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      if (originalFlag === undefined)
        delete process.env.ALLRICE_ASSISTANTS_ENABLED;
      else process.env.ALLRICE_ASSISTANTS_ENABLED = originalFlag;
      await fixture?.close();
    });

    const authorityFixture = (
      options: Parameters<typeof createAssistantAuthorityFixture>[1] = {},
    ) => createAssistantAuthorityFixture(fixture.db, options);

    const sourceTool = 'workspace.experience.read';
    const sourceFixture = (missing?: 'frozen' | 'read' | 'search') =>
      authorityFixture({
        configure: false,
        toolNames: [
          ...selectedTools,
          missing === 'search'
            ? 'workspace.document.read'
            : 'workspace.memory.search',
        ],
        allowedTools: [...selectedTools, sourceTool],
        snapshot: (value) => ({
          ...value,
          capabilitySnapshot: {
            ...value.capabilitySnapshot,
            grantedCapabilities:
              value.capabilitySnapshot.grantedCapabilities.filter(
                (capability) =>
                  missing !== 'read' || capability !== 'storage:read',
              ),
            bindings: {
              ...value.capabilitySnapshot.bindings,
              toolNames:
                missing === 'frozen'
                  ? value.capabilitySnapshot.bindings.toolNames
                  : [
                      ...new Set([
                        ...withEmployeeMemorySourceTool(
                          value.capabilitySnapshot.bindings.toolNames,
                          value.capabilitySnapshot.grantedCapabilities,
                        ),
                        sourceTool,
                      ]),
                    ],
            },
          },
        }),
      });

    it('admits the source companion frozen by a new memory-read Run', async () => {
      const f = await sourceFixture();
      await expect(f.configure()).resolves.toBeDefined();
      await expect(f.authorize('tool', [sourceTool])).resolves.toBeUndefined();
    });

    it.each(['frozen', 'read', 'search'] as const)(
      'rejects a source companion missing its %s authority',
      async (missing) => {
        const f = await sourceFixture(missing);
        await expect(f.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
      },
    );

    it('keeps an older memory-read Run usable without adding the source tool', async () => {
      const f = await authorityFixture({
        toolNames: [...selectedTools, 'workspace.memory.search'],
        allowedTools: [...selectedTools, 'workspace.memory.search'],
      });
      await expect(
        f.authorize('tool', ['workspace.memory.search']),
      ).resolves.toBeUndefined();
      await expect(f.authorize('tool', [sourceTool])).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    const profileTool = 'workspace.employee.profile.update';
    const profileFixture = (
      options: {
        declared?: boolean;
        tool?: string;
        missing?:
          | 'instance'
          | 'binding'
          | 'write'
          | 'owner'
          | 'workspace'
          | 'assignment';
        general?: boolean;
      } = {},
    ) =>
      authorityFixture({
        configure: false,
        toolNames: [
          ...selectedTools,
          ...(options.declared ? [options.tool ?? profileTool] : []),
        ],
        allowedTools: [...selectedTools, options.tool ?? profileTool],
        snapshot: (value) => ({
          ...value,
          ...(options.missing === 'instance'
            ? {}
            : {
                instance: {
                  id: randomUUID(),
                  assignmentId:
                    options.missing === 'assignment'
                      ? randomUUID()
                      : value.assignment.id,
                  organizationId: value.tenantContext.organizationId,
                  workspaceId:
                    options.missing === 'workspace'
                      ? randomUUID()
                      : value.tenantContext.workspaceId,
                  ownerId:
                    options.missing === 'owner'
                      ? randomUUID()
                      : value.assignment.userId,
                  kind: options.general ? 'general' : 'custom',
                  revision: 1,
                  profile: { name: '小白' },
                  creationSource: {
                    kind: 'tenant_version',
                    employeeVersionId: value.employee.versionId,
                  },
                  source: {
                    kind: 'tenant_version',
                    employeeVersionId: value.employee.versionId,
                  },
                },
              }),
          capabilitySnapshot: {
            ...value.capabilitySnapshot,
            grantedCapabilities:
              value.capabilitySnapshot.grantedCapabilities.filter(
                (c) => options.missing !== 'write' || c !== 'storage:write',
              ),
            bindings: {
              ...value.capabilitySnapshot.bindings,
              toolNames: [
                ...selectedTools,
                ...(options.missing === 'binding'
                  ? []
                  : [options.tool ?? profileTool]),
              ],
            },
          },
        }),
      });

    it.each([
      ['custom', false],
      ['custom', true],
      ['general', false],
      ['general', true],
    ] as const)(
      'keeps %s personal profile edits root-only even if declared=%s',
      async (kind, declared) => {
        const f = await profileFixture({
          declared,
          general: kind === 'general',
        });
        await expect(f.configure()).resolves.toBeDefined();
        await expect(
          f.authorize('tool', [profileTool]),
        ).resolves.toBeUndefined();
        await expect(
          f.runtime.provision({
            ...f.base,
            parentRunId: f.rootRunId,
            delegationId: randomUUID(),
            label: 'Cannot edit the owner profile',
            text: 'Synthetic forbidden delegation',
            tools: ['assistant.report', profileTool],
          }),
        ).rejects.toThrow('assistant_authority_denied');
        const child = (
          await f.runtime.provision({
            ...f.base,
            parentRunId: f.rootRunId,
            delegationId: randomUUID(),
            label: 'Read only child',
            text: 'Synthetic read',
            tools: ['web.fetch'],
          })
        ).instance;
        await expect(
          f.authorize('tool', [profileTool], {
            ...f.task,
            runId: child.runId,
            parentRunId: f.rootRunId,
          }),
        ).rejects.toThrow('assistant_authority_denied');
      },
    );

    it.each([
      'instance',
      'binding',
      'write',
      'owner',
      'workspace',
      'assignment',
    ] as const)(
      'rejects personal profile admission without %s authority',
      async (missing) => {
        const f = await profileFixture({ missing });
        await expect(f.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
      },
    );

    it.each([
      'workspace.employee.method.inspect',
      'workspace.employee.method.save_candidate',
      'workspace.employee.method.restore_candidate',
      'workspace.employee.method.test',
      'workspace.employee.method.test_status',
      'workspace.employee.method.prepare_activation',
      'workspace.employee.method.activate',
    ])(
      'keeps intrinsic method tool %s on the exact root and denies delegation',
      async (tool) => {
        const f = await profileFixture({ tool });
        await expect(f.configure()).resolves.toBeDefined();
        await expect(f.authorize('tool', [tool])).resolves.toBeUndefined();
        await expect(
          f.runtime.provision({
            ...f.base,
            parentRunId: f.rootRunId,
            delegationId: randomUUID(),
            label: 'No private method access',
            text: 'Synthetic',
            tools: ['assistant.report', tool],
          }),
        ).rejects.toThrow('assistant_authority_denied');
        const denied = await profileFixture({
          tool,
          general: true,
          declared: true,
        });
        await expect(denied.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
        const missing = await profileFixture({ tool, missing: 'binding' });
        await expect(missing.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
        const readOnly = await profileFixture({ tool, missing: 'write' });
        if (tool.endsWith('.inspect') || tool.endsWith('.test_status'))
          await expect(readOnly.configure()).resolves.toBeDefined();
        else
          await expect(readOnly.configure()).rejects.toThrow(
            'assistant_authority_denied',
          );
      },
    );

    const imageFixture = (
      options: {
        enabled?: boolean;
        exportAllowed?: boolean;
        writeAllowed?: boolean;
        provider?: string;
      } = {},
    ) => {
      const declared = [
        ...selectedTools,
        ...(options.exportAllowed === false ? [] : ['workspace.export.create']),
      ];
      return authorityFixture({
        configure: false,
        toolNames: declared,
        allowedTools: [...declared, 'image.generate', 'image.edit'],
        snapshot: (value, { sessionId }) => ({
          ...value,
          capabilitySnapshot: {
            ...value.capabilitySnapshot,
            grantedCapabilities:
              value.capabilitySnapshot.grantedCapabilities.filter(
                (c) => options.writeAllowed !== false || c !== 'storage:write',
              ),
          },
          modelSnapshot: SessionModelSnapshotSchema.parse({
            schemaVersion: 1,
            sessionId,
            employeeId: value.employee.id,
            policyRevision: 1,
            connectionId: randomUUID(),
            modelCatalogEntryId: randomUUID(),
            harness: 'dsh',
            provider: options.provider ?? 'openai-codex',
            authMode: 'chatgpt_subscription',
            model: 'gpt-5.6-luna',
            reasoningEffort: 'low',
            credentialReference: 'deployment:synthetic-never-resolved',
            baseUrl: null,
            fallbackPolicy: 'disabled',
            fallbackTargets: [],
            frozenAt: value.createdAt,
            platformSettings: {
              revision: 1,
              updatedAt: value.createdAt,
              configuration: {
                connectionId: randomUUID(),
                workModel: 'gpt-5.6-luna',
                reasoningEffort: 'low',
                timeoutMs: 300000,
                imageModel: 'auto',
                imagesEnabled: options.enabled !== false,
              },
            },
          }),
        }),
      });
    };

    it('admits platform image tools with assistants using frozen image/export authority, without republishing the employee', async () => {
      const f = await imageFixture();
      await expect(f.configure()).resolves.toBeDefined();
      for (const phase of phases)
        await expect(f.authorize(phase)).resolves.toBeUndefined();
      await expect(f.authorize('tool', ['image.delete'])).rejects.toThrow(
        'assistant_authority_denied',
      );
      await f.setControls({
        ...defaultControls(),
        rules: [
          ...defaultControls().rules,
          { action: 'image.generate', effect: 'deny' },
        ],
      });
      await expect(f.authorize('tool', ['image.generate'])).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    it.each([
      { enabled: false },
      { exportAllowed: false },
      { writeAllowed: false },
      { provider: 'other' },
    ])(
      'rejects image tools when frozen authority is insufficient: %j',
      async (options) => {
        const f = await imageFixture(options);
        await expect(f.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
      },
    );

    it('a member can turn off new assistant work and restore it without changing employee grants', async () => {
      const f = await authorityFixture();
      await expect(f.authorize('configure')).resolves.toBeUndefined();
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 1, capability: 'assistants', enabled: false },
        fixture.db,
      );
      await expect(f.authorize('configure')).rejects.toThrow(
        'assistant_authority_denied',
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 2, capability: 'assistants', enabled: true },
        fixture.db,
      );
      await expect(f.authorize('configure')).resolves.toBeUndefined();
    });

    it('accepts the published runtime-package checksum after JSONB, but rejects tampered packages and manifest authority', async () => {
      const published = await createEmployeeAdministrationFixture(fixture.db);
      const definition = {
        ...published.definition,
        capabilities: {
          ...published.definition.capabilities,
          nativeSkillIds: [],
          toolNames: selectedTools,
        },
      };
      const runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition,
        skills: [],
      });
      const runtimePolicy = {
        ...definition.modelPolicy,
        harness: 'dsh' as const,
      };
      const f = await authorityFixture({ runtimePackage, runtimePolicy });
      for (const phase of phases)
        await expect(f.authorize(phase)).resolves.toBeUndefined();
      const changed = structuredClone(runtimePackage);
      changed.files.agentsMd += '\nInjected instructions';
      const bad = await authorityFixture({
        runtimePackage: changed,
        runtimePolicy,
        configure: false,
      });
      await expect(bad.configure()).rejects.toThrow(
        'assistant_authority_denied',
      );
      const changedModel = await authorityFixture({
        runtimePackage,
        runtimePolicy: { ...runtimePolicy, model: 'unpublished-model' },
        configure: false,
      });
      await expect(changedModel.configure()).rejects.toThrow(
        'assistant_authority_denied',
      );
      const changedTools = await authorityFixture({
        runtimePackage,
        runtimePolicy,
        toolNames: [...selectedTools, 'local.fs.write'],
        configure: false,
      });
      await expect(changedTools.configure()).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    it.each(phases)(
      'admits valid frozen/current authority for %s',
      async (phase) => {
        const f = await authorityFixture();
        await expect(f.authorize(phase)).resolves.toBeUndefined();
      },
    );

    it('registers the implemented ask-bound command as a proposal, never a direct tool grant', async () => {
      const allowedTools = [...selectedTools, 'local.process.execute'];
      const f = await authorityFixture({
        allowedTools,
        controls: {
          ...defaultControls(),
          rules: [
            ...defaultControls().rules,
            { action: 'local.process.execute', effect: 'ask' },
          ],
        },
      });
      await expect(
        f.authorize('delegate', ['local.process.execute']),
      ).resolves.toBeUndefined();
      await expect(
        f.authorize('proposal', ['local.process.execute']),
      ).resolves.toBeUndefined();
      await expect(
        f.authorize('tool', ['local.process.execute']),
      ).rejects.toThrow('assistant_authority_denied');
      await expect(f.authorize('proposal', ['web.fetch'])).rejects.toThrow(
        'assistant_authority_denied',
      );
      await expect(f.authorize('proposal', [])).rejects.toThrow(
        'assistant_authority_denied',
      );
      await expect(f.authorize('model', [])).resolves.toBeUndefined();
      await expect(f.authorize('message', [])).resolves.toBeUndefined();
    });

    it('does not waive other tool approvals or an explicit command deny', async () => {
      const f = await authorityFixture();
      await f.setControls({
        ...defaultControls(),
        rules: [
          ...defaultControls().rules,
          { action: 'web.fetch', effect: 'ask' },
        ],
      });
      for (const phase of ['configure', 'delegate', 'tool'] as const)
        await expect(f.authorize(phase, ['web.fetch'])).rejects.toThrow(
          'assistant_authority_denied',
        );
      const command = await authorityFixture({
        allowedTools: [...selectedTools, 'local.process.execute'],
      });
      await command.setControls({
        ...defaultControls(),
        rules: [
          ...defaultControls().rules,
          { action: 'local.process.execute', effect: 'deny' },
        ],
      });
      await expect(
        command.authorize('proposal', ['local.process.execute']),
      ).rejects.toThrow('assistant_authority_denied');
    });

    it('uses the real configure/provision hook and confines child tools to its frozen parent intersection', async () => {
      const f = await authorityFixture();
      const child = (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Child',
          text: 'Synthetic read',
          tools: ['web.fetch'],
        })
      ).instance;
      const childTask = {
        ...f.task,
        runId: child.runId,
        parentRunId: f.rootRunId,
      };
      await expect(
        f.authorize('model', ['web.fetch'], childTask),
      ).resolves.toBeUndefined();
      await expect(
        f.authorize('recover', selectedTools, childTask),
      ).rejects.toThrow('assistant_authority_denied');
      await expect(
        f.authorize('delegate', ['web.fetch'], childTask),
      ).rejects.toThrow('assistant_authority_denied');
      await expect(
        f.authorize('configure', ['web.fetch'], childTask),
      ).rejects.toThrow('assistant_authority_denied');
      await expect(
        f.authorize('tool', ['storage.read'], childTask),
      ).rejects.toThrow('assistant_authority_denied');
    });

    it.each([
      ['missing', null],
      ['disabled', { ...defaultControls(), enabled: false }],
      ['plan-only', { ...defaultControls(), mode: 'plan_only' as const }],
      [
        'implicit storage grant',
        {
          ...defaultControls(),
          rules: [{ action: 'storage:read', effect: 'allow' as const }],
        },
      ],
      [
        'explicit deny',
        {
          ...defaultControls(),
          rules: [
            ...defaultControls().rules,
            { action: 'assistant.delegate', effect: 'deny' as const },
          ],
        },
      ],
      [
        'approval required',
        {
          ...defaultControls(),
          rules: [
            ...defaultControls().rules,
            { action: 'assistant.delegate', effect: 'ask' as const },
          ],
        },
      ],
      [
        'selected tool denied',
        {
          ...defaultControls(),
          rules: [
            ...defaultControls().rules,
            { action: 'web.fetch', effect: 'deny' as const },
          ],
        },
      ],
    ] as const)(
      'fails closed on %s controls and rolls back first admission',
      async (_name, controls) => {
        const f = await authorityFixture({
          configure: false,
          controls: controls as RuntimePolicyControls | null,
        });
        await expect(f.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
        expect(
          await f.db`select 1 from allrice_assistant_roots where root_run_id=${f.rootRunId}`,
        ).toHaveLength(0);
      },
    );

    it('does not infer employee delegation binding from read/model capabilities or a policy allow', async () => {
      const f = await authorityFixture({
        configure: false,
        toolNames: ['web.fetch'],
      });
      await expect(f.configure()).rejects.toThrow('assistant_authority_denied');
    });
    it('rejects employee security model denial despite delegation policy and tools', async () => {
      const f = await authorityFixture({ configure: false, deniedModel: true });
      await expect(f.configure()).rejects.toThrow('assistant_authority_denied');
    });
    it('re-reads the feature flag without caching authorization', async () => {
      const f = await authorityFixture();
      process.env.ALLRICE_ASSISTANTS_ENABLED = '0';
      try {
        for (const phase of phases)
          await expect(f.authorize(phase)).rejects.toThrow(
            'assistant_authority_denied',
          );
      } finally {
        process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
      }
    });

    const snapshotMutations: [
      string,
      (s: EmployeeExecutionSnapshot) => unknown,
    ][] = [
      [
        'actor',
        (s) => ({
          ...s,
          tenantContext: { ...s.tenantContext, actorId: randomUUID() },
        }),
      ],
      [
        'organization',
        (s) => ({
          ...s,
          tenantContext: { ...s.tenantContext, organizationId: randomUUID() },
        }),
      ],
      [
        'workspace',
        (s) => ({
          ...s,
          tenantContext: { ...s.tenantContext, workspaceId: randomUUID() },
        }),
      ],
      [
        'policy',
        (s) => ({
          ...s,
          tenantContext: { ...s.tenantContext, policySnapshotId: randomUUID() },
        }),
      ],
      [
        'employee version',
        (s) => ({ ...s, employee: { ...s.employee, versionId: randomUUID() } }),
      ],
      [
        'employee identity',
        (s) => ({ ...s, employee: { ...s.employee, id: randomUUID() } }),
      ],
      [
        'assignment',
        (s) => ({ ...s, assignment: { ...s.assignment, id: randomUUID() } }),
      ],
      ['revision', (s) => ({ ...s, employee: { ...s.employee, revision: 2 } })],
      [
        'definition checksum',
        (s) => ({
          ...s,
          employee: {
            ...s.employee,
            definitionChecksum: `sha256:${'f'.repeat(64)}`,
          },
        }),
      ],
      [
        'resolved actor',
        (s) => ({
          ...s,
          capabilitySnapshot: {
            ...s.capabilitySnapshot,
            resolvedForActorId: randomUUID(),
          },
        }),
      ],
      [
        'missing frozen binding',
        (s) => ({
          ...s,
          capabilitySnapshot: {
            ...s.capabilitySnapshot,
            bindings: {
              ...s.capabilitySnapshot.bindings,
              toolNames: ['web.fetch'],
            },
          },
        }),
      ],
      [
        'undeclared capability',
        (s) => ({
          ...s,
          capabilitySnapshot: {
            ...s.capabilitySnapshot,
            grantedCapabilities: [
              ...s.capabilitySnapshot.grantedCapabilities,
              'secret:use',
            ],
          },
        }),
      ],
      ['malformed', () => ({ schemaVersion: 99 })],
    ];
    it.each(snapshotMutations)(
      'rejects stale/forged frozen %s',
      async (_name, snapshot) => {
        const f = await authorityFixture({ configure: false, snapshot });
        await expect(f.configure()).rejects.toThrow(
          'assistant_authority_denied',
        );
      },
    );

    it('rejects task substitutions, unknown and duplicate tools', async () => {
      const f = await authorityFixture();
      const badTasks: RuntimeTaskRef[] = [
        { ...f.task, rootRunId: randomUUID() },
        { ...f.task, runId: randomUUID(), parentRunId: f.rootRunId },
        { ...f.task, chatSessionId: randomUUID() },
        { ...f.task, scope: { ...f.task.scope, organizationId: randomUUID() } },
        { ...f.task, scope: { ...f.task.scope, workspaceId: randomUUID() } },
        { ...f.task, scope: { ...f.task.scope, projectId: randomUUID() } },
        {
          ...f.task,
          frozenConfiguration: {
            ...f.task.frozenConfiguration,
            employeeVersionId: randomUUID(),
          },
        },
        {
          ...f.task,
          frozenConfiguration: {
            ...f.task.frozenConfiguration,
            digest: `sha256:${'f'.repeat(64)}`,
          },
        },
      ];
      for (const task of badTasks)
        await expect(f.authorize('model', selectedTools, task)).rejects.toThrow(
          'assistant_authority_denied',
        );
      await expect(
        f.authorize('tool', ['web.fetch', 'web.fetch']),
      ).rejects.toThrow('assistant_authority_denied');
      await expect(f.authorize('tool', ['unknown.tool'])).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    type AuthorityFixture = Awaited<ReturnType<typeof authorityFixture>>;
    const revocations: [string, (f: AuthorityFixture) => Promise<unknown>][] = [
      [
        'membership',
        (f) =>
          f.db`update allrice_memberships set active=false where id=${f.membership}`,
      ],
      [
        'viewer role',
        (f) =>
          f.db`update allrice_memberships set role='viewer' where id=${f.membership}`,
      ],
      [
        'user',
        (f) =>
          f.db`update allrice_users set status='disabled' where id=${f.user}`,
      ],
      [
        'organization',
        (f) =>
          f.db`update allrice_organizations set archived_at=clock_timestamp() where id=${f.org}`,
      ],
      [
        'workspace',
        (f) =>
          f.db`update allrice_workspaces set archived_at=clock_timestamp() where id=${f.workspace}`,
      ],
      [
        'employee',
        (f) =>
          f.db`update allrice_employees set status='archived' where id=${f.employee}`,
      ],
      [
        'assignment',
        (f) =>
          f.db`update allrice_employee_assignments set active=false where id=${f.assignment}`,
      ],
      [
        'session',
        (f) =>
          f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`,
      ],
      [
        'runtime generation',
        (f) =>
          f.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`,
      ],
      [
        'active run',
        (f) =>
          f.db`update allrice_conversation_runtimes set active_run_id=null,active_turn_id=null,worker_id=null,state='idle' where session_id=${f.session}`,
      ],
      [
        'StopRun job cancel',
        (f) =>
          f.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.worker.jobId}`,
      ],
      [
        'job lease',
        (f) =>
          f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`,
      ],
      [
        'job timeout',
        (f) =>
          f.db`update allrice_jobs set created_at=clock_timestamp()-interval '2 hours',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`,
      ],
      [
        'root deadline',
        (f) =>
          f.db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 second' where root_run_id=${f.rootRunId}`,
      ],
      [
        'root tombstone',
        (f) =>
          f.db`update allrice_runtime_roots set cancel_request_id=${randomUUID()},cancel_reason='user_request',cancel_requested_at=clock_timestamp() where root_run_id=${f.rootRunId}`,
      ],
      [
        'assistant revocation',
        (f) =>
          f.db`update allrice_assistant_roots set revoked_at=clock_timestamp() where root_run_id=${f.rootRunId}`,
      ],
      [
        'policy expiration',
        (f) =>
          f.db`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=${f.policy}`,
      ],
      [
        'live delegation deny',
        (f) =>
          f.setControls({
            ...defaultControls(),
            version: 2,
            rules: [{ action: 'assistant.delegate', effect: 'deny' }],
          }),
      ],
      [
        'live tool approval requirement',
        (f) =>
          f.setControls({
            ...defaultControls(),
            version: 2,
            rules: [
              ...defaultControls().rules,
              { action: 'web.fetch', effect: 'ask' },
            ],
          }),
      ],
    ];
    it.each(revocations)(
      'rechecks %s at every phase after an earlier successful admission',
      async (_name, revoke) => {
        const f = await authorityFixture();
        await revoke(f);
        for (const phase of phases)
          await expect(f.authorize(phase)).rejects.toThrow(
            'assistant_authority_denied',
          );
      },
    );

    it.each([
      ['missing', {}],
      [
        'disabled',
        {
          assistantConfiguration: {
            version: 1,
            mode: 'daily',
            allowAssistants: false,
            maxConcurrent: 4,
            maxDepth: 3,
            maxChildren: 4,
          },
        },
      ],
      [
        'widened',
        {
          assistantConfiguration: {
            version: 1,
            mode: 'daily',
            allowAssistants: true,
            maxConcurrent: 4,
            maxDepth: 3,
            maxChildren: 16,
          },
        },
      ],
      [
        'unsupported mode',
        {
          assistantConfiguration: {
            version: 1,
            mode: 'teamwork',
            allowAssistants: true,
            maxConcurrent: 4,
            maxDepth: 3,
            maxChildren: 4,
          },
        },
      ],
    ])(
      'rejects %s current daily configuration instead of adopting mutable input',
      async (_name, input) => {
        const f = await authorityFixture();
        await f.db`update allrice_runs set input=${f.db.json(input)} where id=${f.rootRunId}`;
        await expect(f.authorize('recover')).rejects.toThrow(
          'assistant_authority_denied',
        );
      },
    );
    it('denies a changed root execution spec even when the submitted task is unchanged', async () => {
      const f = await authorityFixture();
      await f.db`update allrice_runs set execution_spec='{}' where id=${f.rootRunId}`;
      await expect(f.authorize('model')).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    it('keeps a frozen running version valid after ordinary publication to the same active assignment', async () => {
      const f = await authorityFixture();
      const publishedVersion = randomUUID();
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      select ${publishedVersion},organization_id,workspace_id,employee_id,2,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot from allrice_employee_versions where id=${f.version}`;
      await f.db`update allrice_employee_assignments set employee_version_id=${publishedVersion} where id=${f.assignment}`;
      await expect(f.authorize('recover')).resolves.toBeUndefined();
    });
  },
);
