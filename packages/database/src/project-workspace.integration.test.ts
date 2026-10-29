/** Real isolated PostgreSQL and storage. No model, Bridge or cloud is mocked
 * as successful; this slice saves source only. */
import { unzipSync } from 'fflate';
import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ProjectVersionRefSchema } from '@allrice/contracts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { createLocalCommandFixture } from './local-command.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { parseProjectSnapshotBytes } from './project-source.ts';
import {
  readArtifactBytes,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import {
  getToolBrokerFile,
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import {
  seedProjectOutputParent,
  raceProjectPublications,
} from './project-output-parent.fixture.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET166 PR3a private project checkpoints', () => {
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    for (const name of [
      'ASSISTANTS',
      'WORKBENCH',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
    ])
      vi.stubEnv(`ALLRICE_${name}_ENABLED`, '1');
    database = await createRuntimeFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup(deferRuntimeRoot = false) {
    const f = await createLocalCommandFixture(database.db, 'allow', false, {
      projectWorkspace: true,
      deferRuntimeRoot,
    });
    if (deferRuntimeRoot)
      await f.db`update allrice_runs set input=jsonb_set(input,'{assistantConfiguration,allowAssistants}','false'::jsonb) where id=${f.rootRunId}`;
    const rootsBefore =
      await f.db`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    const storage = runtimeFixtureStorage(f.db);
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

  it('revises the source ZIP series only, serializes same-call replay and rejects a substituted parent', async () => {
    const f = await setup();
    type Delivery = {
      artifacts: { fileName: string; objectId: string; versionId: string }[];
    };
    const first = (await f.call({
      action: 'deliver',
      project: f.opened.project,
    })) as Delivery;
    const old = first.artifacts.find(
      (a) => a.fileName === 'project-source.zip',
    )!;
    const oldFile = await getToolBrokerFile(f.context, old.objectId, f.db);
    const oldBytes = await readArtifactBytes(f.storage, oldFile.object);
    const edited = (await f.call({
      action: 'apply',
      expectedHead: f.opened.project,
      proposal: {
        files: [{ path: 'main.ts', before: 'bad();\n', after: 'good();\n' }],
      },
    })) as { project: unknown };
    const args = {
      action: 'deliver',
      project: ProjectVersionRefSchema.parse(edited.project),
      baseline: f.opened.project,
      parentObjectId: old.objectId,
    };
    const callId = randomUUID();
    const raced = await raceProjectPublications({
      db: f.db,
      storage: f.storage,
      organizationId: f.org,
      workspaceId: f.workspace,
      first: () => f.call(args, callId),
      second: () => f.call(args, callId),
    });
    expect(raced.blocked.holder).not.toBe(raced.blocked.waiter);
    if (
      raced.results[0]!.status !== 'fulfilled' ||
      raced.results[1]!.status !== 'fulfilled'
    )
      throw Error('Exact same-call replay rejected');
    const second = raced.results[0]!.value as Delivery,
      replay = raced.results[1]!.value as Delivery;
    expect(replay).toEqual(second);
    const next = second.artifacts.find(
      (a) => a.fileName === 'project-source.zip',
    )!;
    const rows =
      await f.db`select v.id,v.series_id,v.version,v.parent_version_id,v.format,a.kind
      from allrice_deliverable_versions v join allrice_workbench_artifacts a on a.version_id=v.id
      where v.object_id=any(${[old.objectId, next.objectId]}::uuid[]) order by v.version`;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      version: 2,
      series_id: rows[0]!.series_id,
      parent_version_id: rows[0]!.id,
      format: 'zip',
      kind: 'document',
    });
    const file = await getToolBrokerFile(f.context, next.objectId, f.db);
    expect(file.object).toMatchObject({
      mediaType: 'application/zip',
      immutable: true,
    });
    expect(
      Buffer.from(
        unzipSync(await readArtifactBytes(f.storage, file.object))['main.ts']!,
      ).toString(),
    ).toBe('good();\n');
    expect(await readArtifactBytes(f.storage, oldFile.object)).toEqual(
      oldBytes,
    );
    for (const artifact of second.artifacts.filter(
      (a) => a.fileName !== 'project-source.zip',
    )) {
      const [version] =
        await f.db`select version,parent_version_id from allrice_deliverable_versions
        where id=${artifact.versionId}`;
      expect(version).toMatchObject({ version: 1, parent_version_id: null });
    }
    await expect(f.call(args, randomUUID())).rejects.toThrow(
      'project_output_parent_stale',
    );
    const third = await f.call(
      { ...args, parentObjectId: next.objectId },
      randomUUID(),
    );
    expect(third).toBeTruthy();
    expect(await f.call(args, callId)).toEqual(second); // v1 parent and v2 receipt are now both historical.
    for (const objectId of [old.objectId, next.objectId]) {
      await f.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${objectId}`;
      await expect(f.call(args, callId)).rejects.toThrow();
      await f.db`update allrice_storage_objects set retention_until=null where id=${objectId}`;
    }
    await f.db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
    await expect(f.call(args, callId)).rejects.toThrow();
    await f.db`update allrice_memberships set active=true where organization_id=${f.org} and user_id=${f.user}`;
    const alternative = (await f.call({
      action: 'deliver',
      project: args.project,
    })) as Delivery;
    const alternativeZip = alternative.artifacts.find(
      (a) => a.fileName === 'project-source.zip',
    )!;
    await expect(
      f.call({ ...args, parentObjectId: alternativeZip.objectId }, callId),
    ).rejects.toThrow('idempotency_conflict');
    const [count] =
      await f.db`select count(*)::int as n from allrice_deliverable_versions
      where series_id=${rows[0]!.series_id}`;
    expect(count!.n).toBe(3);
  });

  it.each([
    'expired',
    'deleted',
    'non-deliverable',
    'wrong-format',
    'foreign',
    'other-owner-same-workspace',
    'other-session-same-owner',
  ] as const)(
    'rejects an unavailable ZIP parent (%s) without publishing output',
    async (kind) => {
      const f = await setup();
      const delivery = (await f.call({
        action: 'deliver',
        project: f.opened.project,
      })) as {
        artifacts: { objectId: string; versionId: string; fileName: string }[];
      };
      const zip = delivery.artifacts.find(
        (a) => a.fileName === 'project-source.zip',
      )!;
      let parentObjectId = zip.objectId;
      if (kind === 'expired')
        await f.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond'
          where id=${parentObjectId}`;
      if (kind === 'deleted')
        // A ready immutable export cannot be rewritten into a tombstone. Seed
        // a historical unavailable record without disabling that protection.
        parentObjectId = (
          await seedProjectOutputParent({
            db: f.db,
            storage: f.storage,
            context: f.context,
            sessionId: f.task.chatSessionId!,
            bytes: Buffer.from('deleted fixture zip'),
            deleted: true,
          })
        ).objectId;
      if (kind === 'non-deliverable')
        parentObjectId = (
          await seedProjectOutputParent({
            db: f.db,
            storage: f.storage,
            context: f.context,
            sessionId: f.task.chatSessionId!,
            bytes: Buffer.from('fixture zip'),
            kind: null,
          })
        ).objectId;
      if (kind === 'other-owner-same-workspace') {
        const other = await setup();
        await f.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${f.org},${f.workspace},${other.user},'member')`;
        // Deliberately keep Session/org/workspace identical; only the native object/version owner differs.
        parentObjectId = (
          await seedProjectOutputParent({
            db: f.db,
            storage: f.storage,
            context: f.context,
            sessionId: f.task.chatSessionId!,
            ownerId: other.user,
            bytes: Buffer.from('other owner zip'),
          })
        ).objectId;
      }
      if (kind === 'other-session-same-owner') {
        const sessionId = randomUUID();
        await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
          select ${sessionId},organization_id,workspace_id,owner_id,'Other owned fixture session',employee_assignment_id,employee_version_id
          from allrice_chat_sessions where id=${f.task.chatSessionId!}`;
        parentObjectId = (
          await seedProjectOutputParent({
            db: f.db,
            storage: f.storage,
            context: f.context,
            sessionId,
            bytes: Buffer.from('other session zip'),
          })
        ).objectId;
      }
      if (kind === 'wrong-format') parentObjectId = f.opened.objectId;
      if (kind === 'foreign') {
        const other = await setup();
        const delivered = (await other.call({
          action: 'deliver',
          project: other.opened.project,
        })) as {
          artifacts: { objectId: string; fileName: string }[];
        };
        parentObjectId = delivered.artifacts.find(
          (a) => a.fileName === 'project-source.zip',
        )!.objectId;
      }
      const before = await f.db`select id from allrice_deliverable_versions
        where session_id=${f.task.chatSessionId!} order by id`;
      await expect(
        f.call({
          action: 'deliver',
          project: f.opened.project,
          parentObjectId,
        }),
      ).rejects.toThrow();
      const after = await f.db`select id from allrice_deliverable_versions
        where session_id=${f.task.chatSessionId!} order by id`;
      expect(after).toEqual(before);
    },
  );
  it('serializes distinct new deliver calls on the latest ZIP and preserves the losing failure', async () => {
    const f = await setup();
    const old = (await f.call({
      action: 'deliver',
      project: f.opened.project,
    })) as { artifacts: { fileName: string; objectId: string }[] };
    const parent = old.artifacts.find(
      (a) => a.fileName === 'project-source.zip',
    )!.objectId;
    const args = {
      action: 'deliver',
      project: f.opened.project,
      parentObjectId: parent,
    };
    const raced = await raceProjectPublications({
      db: f.db,
      storage: f.storage,
      organizationId: f.org,
      workspaceId: f.workspace,
      first: () => f.call(args, randomUUID()),
      second: () => f.call(args, randomUUID()),
    });
    expect(raced.blocked.holder).not.toBe(raced.blocked.waiter);
    expect(raced.results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      1,
    );
    const failed = raced.results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && String(failed.reason)).toContain(
      'project_output_parent_stale',
    );
    const versions =
      await f.db`select v.version,v.parent_version_id from allrice_deliverable_versions v where series_id=(select series_id from allrice_deliverable_versions where object_id=${parent}) order by version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
  it('leaves generic export registration of a historical same-format parent unchanged', async () => {
    const f = await setup();
    const seeded = await seedProjectOutputParent({
      db: f.db,
      storage: f.storage,
      context: f.context,
      sessionId: f.task.chatSessionId!,
      bytes: Buffer.from('old zip'),
    });
    const revisions = [];
    for (const text of ['first generic revision', 'second generic revision']) {
      const bytes = Buffer.from(text),
        object = {
          ...createToolBrokerExportObject({
            context: f.context,
            mediaType: 'application/zip',
            sizeBytes: bytes.length,
            checksum: ('sha256:' +
              createHash('sha256')
                .update(bytes)
                .digest('hex')) as `sha256:${string}`,
          }),
          immutable: true,
        };
      await f.storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
      revisions.push(
        await registerToolBrokerExport(
          {
            context: f.context,
            sessionId: f.task.chatSessionId!,
            fileName: 'historical.zip',
            format: 'zip',
            parentObjectId: seeded.objectId,
            object,
          },
          f.db,
        ),
      );
    }
    expect(revisions.map((v) => v.version)).toEqual([2, 3]);
    expect(revisions.map((v) => v.parentVersionId)).toEqual([
      seeded.versionId,
      seeded.versionId,
    ]);
    await expect(
      f.call({
        action: 'deliver',
        project: f.opened.project,
        parentObjectId: seeded.objectId,
      }),
    ).rejects.toThrow('project_output_parent_stale');
  });
});
