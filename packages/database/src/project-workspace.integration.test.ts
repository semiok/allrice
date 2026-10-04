/** Real isolated PostgreSQL and storage. No model, Bridge or cloud is mocked
 * as successful; this slice saves source only. */
import { unzipSync } from 'fflate';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ProjectVersionRefSchema } from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { parseProjectSnapshotBytes } from './project-source.ts';
import {
  readArtifactBytes,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET166 PR3a private project checkpoints', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const name of [
      'ASSISTANTS',
      'WORKBENCH',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
    ])
      vi.stubEnv(`ALLRICE_${name}_ENABLED`, '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup(deferRuntimeRoot = false) {
    const f = await createAssistantLocalCommandFixture(
      database.db,
      'allow',
      false,
      { skipChild: true, projectWorkspace: true, deferRuntimeRoot },
    );
    if (deferRuntimeRoot)
      await f.db`update allrice_runs set input=jsonb_set(input,'{assistantConfiguration,allowAssistants}','false'::jsonb) where id=${f.rootRunId}`;
    const rootsBefore =
      await f.db`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    const storage = assistantFixtureStorage(f.db);
    const [job] = await f.db<
      { attempt: number }[]
    >`select attempt from allrice_jobs where id=${f.worker.jobId}`;
    const input = {
      context: f.context,
      sessionId: f.task.chatSessionId!,
      worker: { attempt: job!.attempt, leaseToken: f.worker.leaseToken },
    };
    const call = (arguments_: unknown, callId = randomUUID()) =>
      executeProjectWorkspace(
        { ...input, callId, arguments: arguments_ },
        storage,
        f.db,
      );
    const open = (await call({
      action: 'open',
      files: [
        { path: 'main.ts', text: 'bad();\n' },
        { path: 'pnpm-lock.yaml', text: 'lockfileVersion: 9.0\n' },
      ],
    })) as { project: unknown; objectId: string };
    return {
      ...f,
      storage,
      input,
      call,
      rootsBefore: rootsBefore.length,
      opened: { ...open, project: ProjectVersionRefSchema.parse(open.project) },
    };
  }
  it('creates the existing ledger root for the first single-employee source call without assistants', async () => {
    const f = await setup(true);
    expect(f.rootsBefore).toBe(0);
    const roots =
      await f.db`select task from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    expect(roots).toHaveLength(1);
    expect(roots[0]?.task.chatSessionId).toBe(f.task.chatSessionId);
    const links =
      await f.db`select run_id from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
    expect(links).toHaveLength(1);
    const budgets =
      await f.db`select capacity from allrice_runtime_budgets where root_run_id=${f.rootRunId} and metric='tool_calls'`;
    expect(Number(budgets[0]?.capacity)).toBe(32);
    expect(
      await f.call({
        action: 'read',
        project: f.opened.project,
        path: 'main.ts',
      }),
    ).toMatchObject({ text: 'bad();\n' });
  });
  it('atomically versions complete source, replays once and reads the exact prior version', async () => {
    const f = await setup();
    const callId = randomUUID();
    const command = {
      action: 'apply',
      expectedHead: f.opened.project,
      proposal: {
        files: [{ path: 'main.ts', before: 'bad();\n', after: 'good();\n' }],
      },
    };
    const first = await f.call(command, callId),
      replayed = await f.call(command, callId);
    expect(replayed).toEqual(first);
    const saved = first as { project: unknown; objectId: string };
    const ref = ProjectVersionRefSchema.parse(saved.project);
    expect(
      await f.call({ action: 'read', project: ref, path: 'main.ts' }),
    ).toMatchObject({ text: 'good();\n' });
    expect(
      await f.call({
        action: 'read',
        project: f.opened.project,
        path: 'main.ts',
      }),
    ).toMatchObject({ text: 'bad();\n' });
    expect(
      await f.call({ action: 'search', project: ref, query: 'Version' }),
    ).toMatchObject({
      matches: [
        { path: 'pnpm-lock.yaml', line: 1, text: 'lockfileVersion: 9.0' },
      ],
    });
    const source = await getToolBrokerFile(f.context, saved.objectId, f.db);
    const document = parseProjectSnapshotBytes(
      await readArtifactBytes(f.storage, source.object),
    );
    expect(document.files).toHaveLength(2);
    expect(
      document.files.find((file) => file.path === 'pnpm-lock.yaml'),
    ).toBeDefined();
    const [head] = await f.db<
      { revision: number }[]
    >`select revision from allrice_project_workspace_heads where root_run_id=${f.rootRunId}`;
    expect(head?.revision).toBe(1);
    const count =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(count).toHaveLength(2);
    const listed = await listWorkbenchArtifacts(
      {
        actor: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
      },
      f.task.chatSessionId!,
      undefined,
      f.db,
    );
    expect(listed.artifacts).toHaveLength(0);
  });
  it('delivers exact ZIP, diff and factual report through ordinary private results, replays once and rejects foreign source', async () => {
    const f = await setup(),
      other = await setup();
    const edited = (await f.call({
      action: 'apply',
      expectedHead: f.opened.project,
      proposal: {
        files: [{ path: 'main.ts', before: 'bad();\n', after: 'good();\n' }],
      },
    })) as { project: unknown };
    const project = ProjectVersionRefSchema.parse(edited.project),
      callId = randomUUID();
    const args = { action: 'deliver', project, baseline: f.opened.project };
    const delivery = (await f.call(args, callId)) as {
      artifacts: { objectId: string; fileName: string }[];
      report: { executions: unknown[] };
    };
    expect(await f.call(args, callId)).toEqual(delivery);
    expect(delivery.artifacts.map((a) => a.fileName)).toEqual([
      'project-source.zip',
      'project-test-report.json',
      'project-changes.diff',
    ]);
    const files = new Map<string, Buffer>();
    for (const a of delivery.artifacts) {
      const { object } = await getToolBrokerFile(f.context, a.objectId, f.db);
      files.set(a.fileName, await readArtifactBytes(f.storage, object));
      await expect(
        getToolBrokerFile(other.context, a.objectId, f.db),
      ).rejects.toThrow();
    }
    const source = unzipSync(files.get('project-source.zip')!);
    expect(Object.keys(source).sort()).toEqual(['main.ts', 'pnpm-lock.yaml']);
    expect(Buffer.from(source['main.ts']!).toString()).toBe('good();\n');
    expect(Buffer.from(source['pnpm-lock.yaml']!).toString()).toBe(
      'lockfileVersion: 9.0\n',
    );
    expect(files.get('project-changes.diff')!.toString()).toContain(
      '-bad();\n+good();',
    );
    expect(
      JSON.parse(files.get('project-test-report.json')!.toString()).executions,
    ).toEqual([]);
    const listed = await listWorkbenchArtifacts(
      {
        actor: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
      },
      f.task.chatSessionId!,
      undefined,
      f.db,
    );
    expect(listed.artifacts).toHaveLength(3);
    expect(listed.artifacts.map((a) => a.provenance.kind)).toEqual([
      'tool_result',
      'tool_result',
      'tool_result',
    ]);
    await expect(other.call({ action: 'deliver', project })).rejects.toThrow();
  });
  it('allows exactly three saved edits per Run; replay/read/delivery remain usable after exhaustion', async () => {
    const f = await setup();
    let project = f.opened.project,
      before = 'bad();\n',
      lastArgs: unknown,
      lastCall = randomUUID();
    for (let index = 1; index <= 3; index++) {
      const after = `fixed${index}();\n`;
      lastCall = randomUUID();
      lastArgs = {
        action: 'apply',
        expectedHead: project,
        proposal: { files: [{ path: 'main.ts', before, after }] },
      };
      project = ProjectVersionRefSchema.parse(
        ((await f.call(lastArgs, lastCall)) as { project: unknown }).project,
      );
      before = after;
    }
    expect(
      ((await f.call(lastArgs, lastCall)) as { project: unknown }).project,
    ).toEqual(project);
    await expect(
      f.call({
        action: 'apply',
        expectedHead: project,
        proposal: {
          files: [{ path: 'main.ts', before, after: 'fourth();\n' }],
        },
      }),
    ).rejects.toThrow('workflow_budget_exhausted');
    expect(
      await f.call({ action: 'read', project, path: 'main.ts' }),
    ).toMatchObject({ text: before });
    expect(await f.call({ action: 'deliver', project })).toHaveProperty(
      'artifacts',
    );
  });
  it('rejects concurrent stale edits without publishing a losing version', async () => {
    const f = await setup();
    const edit = (after: string) =>
      f.call({
        action: 'apply',
        expectedHead: f.opened.project,
        proposal: { files: [{ path: 'main.ts', before: 'bad();\n', after }] },
      });
    const results = await Promise.allSettled([
      edit('first();\n'),
      edit('second();\n'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(2);
  });
  it('imports an authorized upload by exact bytes and makes repeated opens idempotent', async () => {
    const f = await setup();
    const callId = randomUUID();
    const command = {
      action: 'open',
      files: [
        {
          path: 'saved-source.json',
          objectId: f.opened.objectId,
          checksum: f.opened.project.snapshot.checksum,
        },
      ],
    };
    const first = await f.call(command, callId);
    expect(await f.call(command, callId)).toEqual(first);
    const project = ProjectVersionRefSchema.parse(
      (first as { project: unknown }).project,
    );
    expect(
      await f.call({ action: 'read', project, path: 'saved-source.json' }),
    ).toMatchObject({
      checksum: f.opened.project.snapshot.checksum,
    });
    await expect(
      f.call({
        action: 'open',
        files: [
          {
            ...command.files[0],
            checksum: `sha256:${'0'.repeat(64)}`,
          },
        ],
      }),
    ).rejects.toThrow('source_changed');
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(2);
  });
  it('requires the ordinary employee read grant and rejects expired policies', async () => {
    const f = await setup();
    expect(f.context.policySnapshot.memberships[0]?.role).toBe('member');
    for (const policySnapshot of [
      {
        ...f.context.policySnapshot,
        grants: f.context.policySnapshot.grants.filter(
          (g) => g.resourceType !== 'storage_object',
        ),
      },
      {
        ...f.context.policySnapshot,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]) {
      await expect(
        executeProjectWorkspace(
          {
            ...f.input,
            context: { ...f.context, policySnapshot },
            callId: randomUUID(),
            arguments: { action: 'list', project: f.opened.project },
          },
          f.storage,
          f.db,
        ),
      ).rejects.toThrow('forbidden');
    }
  });
  it('rejects expired uploads rather than retaining them as a new source snapshot', async () => {
    const f = await setup();
    await f.db`update allrice_storage_objects set retention_until=clock_timestamp()+interval '0.1 second' where id=${f.opened.objectId}`;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(
      f.call({
        action: 'open',
        files: [
          {
            path: 'source.json',
            objectId: f.opened.objectId,
            checksum: f.opened.project.snapshot.checksum,
          },
        ],
      }),
    ).rejects.toThrow('source_unavailable');
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(1);
  });
  it('rolls back a source import whose input expires after reading and before commit', async () => {
    const f = await setup();
    await f.db`update allrice_storage_objects set retention_until=clock_timestamp()+interval '1 second' where id=${f.opened.objectId}`;
    const delayed = {
      get: f.storage.get.bind(f.storage),
      delete: f.storage.delete.bind(f.storage),
      exists: f.storage.exists.bind(f.storage),
      put: async (...args: Parameters<typeof f.storage.put>) => {
        await f.storage.put(...args);
        await new Promise((resolve) => setTimeout(resolve, 1100));
      },
    };
    await expect(
      executeProjectWorkspace(
        {
          ...f.input,
          callId: randomUUID(),
          arguments: {
            action: 'open',
            files: [
              {
                path: 'source.json',
                objectId: f.opened.objectId,
                checksum: f.opened.project.snapshot.checksum,
              },
            ],
          },
        },
        delayed,
        f.db,
      ),
    ).rejects.toThrow('source_unavailable');
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(1);
    const heads =
      await f.db`select project_id from allrice_project_workspace_heads where root_run_id=${f.rootRunId}`;
    expect(heads).toHaveLength(1);
  });
  it('enforces real owner, tenant, current membership and exact worker lease', async () => {
    const f = await setup(),
      other = await setup();
    await expect(
      other.call({ action: 'open', source: f.opened.project.snapshot }),
    ).rejects.toThrow('snapshot_not_found');
    await expect(
      executeProjectWorkspace(
        {
          ...f.input,
          worker: { ...f.input.worker, leaseToken: randomUUID() },
          callId: randomUUID(),
          arguments: { action: 'list', project: f.opened.project },
        },
        f.storage,
        f.db,
      ),
    ).rejects.toThrow('run_unavailable');
    await f.db`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(
      f.call({ action: 'read', project: f.opened.project, path: 'main.ts' }),
    ).rejects.toThrow('identity_denied');
  });
  it('denies an active Run after its AI employee assignment is revoked', async () => {
    const f = await setup();
    await f.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
    await expect(
      f.call({ action: 'read', project: f.opened.project, path: 'main.ts' }),
    ).rejects.toThrow('run_unavailable');
    await expect(
      f.call({
        action: 'apply',
        expectedHead: f.opened.project,
        proposal: {
          files: [{ path: 'main.ts', before: 'bad();\n', after: 'good();\n' }],
        },
      }),
    ).rejects.toThrow('run_unavailable');
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(1);
  });
  it('rolls back source and head together when private blob publication fails', async () => {
    const f = await setup();
    const failing = {
      ...f.storage,
      put: async () => {
        throw Error('synthetic_disk_full');
      },
      get: f.storage.get.bind(f.storage),
      delete: f.storage.delete.bind(f.storage),
      exists: f.storage.exists.bind(f.storage),
    };
    await expect(
      executeProjectWorkspace(
        {
          ...f.input,
          callId: randomUUID(),
          arguments: {
            action: 'apply',
            expectedHead: f.opened.project,
            proposal: {
              files: [
                { path: 'main.ts', before: 'bad();\n', after: 'good();\n' },
              ],
            },
          },
        },
        failing,
        f.db,
      ),
    ).rejects.toThrow('synthetic_disk_full');
    expect(
      await f.call({
        action: 'read',
        project: f.opened.project,
        path: 'main.ts',
      }),
    ).toMatchObject({ text: 'bad();\n' });
    const versions =
      await f.db`select id from allrice_deliverable_versions where session_id=${f.task.chatSessionId!}`;
    expect(versions).toHaveLength(1);
  });
});
