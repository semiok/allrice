/** Real PostgreSQL admission tests with synthetic identities in a fresh schema.
 * No model, connector, deployed Worker, tenant enablement or GA proof is claimed. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmployeeExecutionSnapshotSchema,
  type EmployeeExecutionSnapshot,
  type RuntimePolicyControls,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import {
  createAssistantRuntime,
  type AssistantAuthorityInput,
} from './assistant-runtime.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

const phases: AssistantAuthorityInput['phase'][] = [
  'configure',
  'delegate',
  'message',
  'model',
  'tool',
  'recover',
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

    async function authorityFixture(
      options: {
        controls?: RuntimePolicyControls | null;
        toolNames?: string[];
        snapshot?: (value: EmployeeExecutionSnapshot) => unknown;
        deniedModel?: boolean;
        configure?: boolean;
      } = {},
    ) {
      const { db } = fixture;
      const base = await assistantFixture(db);
      const { organizationId: org, workspaceId: workspace } = base.task.scope;
      const user = base.context.actor.id;
      const rootRunId = base.task.rootRunId;
      const employee = randomUUID(),
        version = randomUUID(),
        assignment = randomUUID();
      const session = randomUUID(),
        policy = randomUUID(),
        um = randomUUID(),
        am = randomUUID();
      const now = new Date().toISOString();
      const [membership] = await db<{ id: string }[]>`
      select id from allrice_memberships where organization_id=${org} and workspace_id=${workspace} and user_id=${user}`;
      const manifest = employeeManifest({
        key: 'p25-authority',
        name: 'P25 authority',
        description: 'Synthetic authority fixture',
        toolNames: options.toolNames ?? selectedTools,
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-codex',
          model: 'synthetic-never-called',
          reasoningEffort: 'low',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
        securityPolicy: {
          dataScopes: ['workspace'],
          connectorIdentityModes: ['user'],
          approvalPolicy: 'confirm_side_effects',
          deniedCapabilities: options.deniedModel
            ? ['model:invoke']
            : ['secret:use'],
        },
      });
      if (manifest.schemaVersion !== 2)
        throw Error('Fixture requires v2 manifest');
      const checksum = employeeManifestChecksum(manifest);
      const executionSpec = {
        kind: 'synthetic-p25-authority',
        employeeVersionId: version,
      };
      const task: RuntimeTaskRef = {
        ...base.task,
        chatSessionId: session,
        frozenConfiguration: {
          employeeVersionId: version,
          digest: runtimePolicyDigest(executionSpec),
        },
      };
      const frozenPolicy = {
        memberships: [
          {
            id: membership!.id,
            userId: user,
            organizationId: org,
            workspaceId: workspace,
            role: 'admin',
            active: true,
          },
        ],
        grants: [
          {
            resourceType: 'job',
            action: 'job:execute',
            workspaceId: workspace,
          },
        ],
      };
      const snapshot = EmployeeExecutionSnapshotSchema.parse({
        schemaVersion: 2,
        employee: {
          id: employee,
          key: manifest.key,
          versionId: version,
          revision: 1,
          definitionChecksum: checksum,
          definition: manifest,
        },
        assignment: {
          id: assignment,
          userId: user,
          assignedBy: null,
          assignedAt: now,
        },
        runtimePolicy: manifest.runtimePolicy,
        capabilitySnapshot: {
          declaredCapabilities: manifest.capabilities,
          grantedCapabilities: manifest.capabilities.filter(
            (c) => !manifest.securityPolicy.deniedCapabilities.includes(c),
          ),
          bindings: manifest.capabilityBindings,
          skillBindings: [],
          agentSkills: [],
          workflows: [],
          knowledge: [],
          resolvedForActorId: user,
        },
        tenantContext: {
          organizationId: org,
          workspaceId: workspace,
          actorId: user,
          policySnapshotId: policy,
        },
        userProfile: { schemaVersion: 1, displayName: null, preferences: {} },
        createdAt: now,
      });
      await db.begin(async (tx) => {
        // Replace only the synthetic permissive fixture's root admission, before
        // any child/message/usage exists. Production configure runs below.
        await tx`delete from allrice_assistant_instances where root_run_id=${rootRunId}`;
        await tx`delete from allrice_assistant_roots where root_run_id=${rootRunId}`;
        await tx`update allrice_runtime_roots set task=${tx.json(task)} where root_run_id=${rootRunId}`;
        await tx`update allrice_runtime_run_links set task=${tx.json(task)} where run_id=${rootRunId}`;
        await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
        values(${policy},${org},${user},1,${tx.json(frozenPolicy)},clock_timestamp()+interval '1 hour')`;
        await tx`update allrice_runs set policy_snapshot_id=${policy},execution_spec=${tx.json(executionSpec)},input=${tx.json({ assistantConfiguration: base.config })} where id=${rootRunId}`;
        await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
        values(${employee},${org},${workspace},'p25-authority','P25 authority')`;
        await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${version},${org},${workspace},${employee},1,'P25 authority',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${checksum},${tx.json(manifest)},${tx.json(manifest.provider)})`;
        await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${assignment},${org},${workspace},${employee},${version},${user})`;
        await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${session},${org},${workspace},${user},'P25 authority',${assignment},${version})`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),
          (${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
        await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
        values(${org},${workspace},${session},${user},${base.worker.generation},${checksum},'running',${rootRunId},${base.worker.workerId})`;
        await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
        values(${rootRunId},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${tx.json(manifest.provider)},'{}','[]',${tx.json(JSON.parse(JSON.stringify(options.snapshot ? options.snapshot(snapshot) : snapshot)))})`;
        const controls =
          options.controls === undefined ? defaultControls() : options.controls;
        if (controls)
          await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
        values(${org},${workspace},${controls.version},${tx.json(controls)})`;
      });
      const runtime = createAssistantRuntime({
        database: db,
        authorize: assertAssistantAuthority,
      });
      const configure = () =>
        runtime.configureRoot({
          task,
          configuration: base.config,
          nativeSessionId: base.nativeSessionId,
          worker: base.worker,
          allowedTools: selectedTools,
        });
      if (options.configure !== false) await configure();
      const authorize = (
        phase: AssistantAuthorityInput['phase'] = 'configure',
        tools = selectedTools,
        requestedTask = task,
      ) =>
        db.begin((transaction) =>
          assertAssistantAuthority({
            transaction,
            task: requestedTask,
            tools,
            phase,
          }),
        );
      const setControls = (controls: RuntimePolicyControls) => db`
      update allrice_runtime_policy_controls set version=${controls.version},controls=${db.json(controls)}
      where organization_id=${org} and workspace_id=${workspace}`;
      return {
        ...base,
        task,
        db,
        org,
        workspace,
        user,
        employee,
        version,
        assignment,
        session,
        policy,
        membership: membership!.id,
        manifest,
        snapshot,
        runtime,
        configure,
        authorize,
        setControls,
        rootRunId,
      };
    }

    it.each(phases)(
      'admits valid frozen/current authority for %s',
      async (phase) => {
        const f = await authorityFixture();
        await expect(f.authorize(phase)).resolves.toBeUndefined();
      },
    );

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
