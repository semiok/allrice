import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { JSONValue, TransactionSql } from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  FrozenMcpTool,
  LocalMcpSnapshot,
  McpDiscoveredTool,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { employeeManifest } from './employees/employee-config.ts';
import { freezeEmployeeBaseSkills } from './employees/employee-base-skills.ts';
import { createEmployeeMcpBindingStore } from './mcp-employee-bindings.ts';
import { createLocalMcpStore } from './local-mcp-connections.ts';
import { createLocalMcpFixture } from './local-mcp.fixture.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { runtimePolicyDigest as digest } from './runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixtureTool = {
  name: 'records.list',
  description: 'List synthetic records',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: null,
} satisfies McpDiscoveredTool & JSONValue;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitForLockWait(
  sql: TransactionSql,
  blockerPid: number,
  waiterPid?: number,
) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const [row] = waiterPid
      ? await sql<{ blocked: boolean }[]>`
          select ${blockerPid}=any(pg_blocking_pids(${waiterPid})) as blocked`
      : await sql<{ blocked: boolean }[]>`
          select exists(select 1 from pg_locks where pid is not null
            and ${blockerPid}=any(pg_blocking_pids(pid))) as blocked`;
    if (row?.blocked) return;
    await pause(10);
  }
  throw Error('expected_two_connection_lock_wait');
}

suite(
  'freeze helpers with an actual caller-owned PostgreSQL transaction',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let published: Awaited<ReturnType<typeof freezeEmployeeBaseSkills>>;

    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      for (const name of [
        'ALLRICE_LOCAL_MCP_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(name, '1');
      const pool = vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      try {
        await synchronizePlatformContent(await loadPlatformContentCatalog());
        published = await freezeEmployeeBaseSkills([]);
      } finally {
        pool.mockRestore();
      }
    }, 120000);

    beforeEach(() => {
      vi.spyOn(client, 'getDatabase').mockImplementation(() => {
        throw Error('unexpected_global_database');
      });
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (f)
        expect(await f.close()).toMatchObject({
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        });
    });

    // Only synthetic scoped rows in createAssistantFixtureDatabase's owned
    // schema. No network discovery, credential decryption, Bridge or model call.
    async function cloudFixture() {
      const organizationId = randomUUID(),
        workspaceId = randomUUID(),
        actorId = randomUUID(),
        employeeId = randomUUID(),
        versionId = randomUUID(),
        connectionId = randomUUID(),
        definitionId = randomUUID(),
        toolRevisionId = randomUUID();
      const scope = { organizationId, workspaceId, actorId };
      const manifest = employeeManifest({
        key: 'tx-mcp',
        name: 'Transaction MCP',
        description: 'Synthetic transaction fixture',
        toolNames: ['cloud.mcp.call'],
        securityPolicy: {
          dataScopes: ['workspace'],
          connectorIdentityModes: ['service'],
          approvalPolicy: 'confirm_side_effects',
          deniedCapabilities: [],
        },
      });
      const credentialReference = `mcp:${connectionId}:r1`;
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_users(id,email,display_name,password_hash) values(${actorId},${`${actorId}@example.test`},'Transaction member','not-login')`;
        await tx`insert into allrice_organizations(id,slug,name) values(${organizationId},${`tx-${organizationId}`},'Transaction fixture')`;
        await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'tx','Transaction fixture')`;
        await tx`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${actorId},'member')`;
        await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${organizationId},${workspaceId},'tx-mcp','Transaction MCP')`;
        await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${versionId},${organizationId},${workspaceId},${employeeId},1,'Transaction MCP',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${digest(manifest)},${tx.json(manifest)},${tx.json(manifest.provider)})`;
        await tx`insert into allrice_employee_assignments(organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${organizationId},${workspaceId},${employeeId},${versionId},${actorId})`;
        await tx`insert into allrice_connector_definitions(id,organization_id,workspace_id,connector_key,name,description,capabilities,input_schema,risk,identity_modes,resource_scopes,created_by)
        values(${definitionId},${organizationId},${workspaceId},${`tx-mcp.${connectionId}`},'Transaction MCP','Synthetic',${tx.json(['network:outbound', 'secret:use'])},'{}','write','["service"]','["workspace"]',${actorId})`;
        await tx`insert into allrice_connector_bindings(id,organization_id,workspace_id,connector_id,identity_mode,user_id,credential_reference,resource_scope,created_by)
        values(${connectionId},${organizationId},${workspaceId},${definitionId},'service',null,${credentialReference},'{}',${actorId})`;
        await tx`insert into allrice_mcp_binding_config(binding_id,organization_id,workspace_id,endpoint,credential_envelope,discovery_state,managed_by)
        values(${connectionId},${organizationId},${workspaceId},'https://mcp.example.test/mcp','{}','ready',${actorId})`;
        await tx`insert into allrice_mcp_member_connections(organization_id,workspace_id,binding_id,user_id,connected,revision)
        values(${organizationId},${workspaceId},${connectionId},${actorId},true,3)`;
        await tx`insert into allrice_mcp_tool_revisions(id,organization_id,workspace_id,binding_id,tool_name,digest,definition)
        values(${toolRevisionId},${organizationId},${workspaceId},${connectionId},${fixtureTool.name},${digest(fixtureTool)},${tx.json(fixtureTool)})`;
        await tx`insert into allrice_mcp_tool_grants(organization_id,workspace_id,binding_id,tool_name,revision_id,risk)
        values(${organizationId},${workspaceId},${connectionId},${fixtureTool.name},${toolRevisionId},'read_only')`;
      });
      return {
        scope,
        employeeId,
        versionId,
        connectionId,
        credentialReference,
      };
    }

    it('keeps the default base-skill repeatable-read, read-only transaction', async () => {
      vi.mocked(client.getDatabase).mockReturnValue(f.db);
      const begin = vi.spyOn(f.db, 'begin');
      expect(await freezeEmployeeBaseSkills([])).toEqual(published);
      expect(begin).toHaveBeenCalledExactlyOnceWith(
        'isolation level repeatable read read only',
        expect.any(Function),
      );
    });

    it('reads uncommitted catalog metadata and source rows, then rolls both back', async () => {
      const removed = published.nativeSkills[0]!;
      const catalogChecksum = `sha256:${'3'.repeat(64)}`;
      const rollback = Error('expected_catalog_rollback');
      let frozen: typeof published | undefined;
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_runtime_metadata set value=jsonb_set(value,'{catalogChecksum}',${tx.json(catalogChecksum)}) where key='platform-content-catalog'`;
          await tx`update allrice_platform_dsh_skills set enabled=false where id=${removed.id}`;
          frozen = await freezeEmployeeBaseSkills([], tx);
          expect(frozen.catalog?.catalogChecksum).toBe(catalogChecksum);
          expect(frozen.nativeSkills.some((s) => s.id === removed.id)).toBe(
            false,
          );
          await tx`delete from allrice_runtime_metadata where key='platform-content-catalog'`;
          const original = [removed];
          const legacy = await freezeEmployeeBaseSkills(original, tx);
          expect(legacy.nativeSkills).toBe(original);
          expect(legacy.catalog).toBeUndefined();
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(client.getDatabase).not.toHaveBeenCalled();
      vi.mocked(client.getDatabase).mockReturnValue(f.db);
      expect(await freezeEmployeeBaseSkills([])).toEqual(published);
      expect(frozen?.catalog?.catalogChecksum).toBe(catalogChecksum);
    });

    it('freezes uncommitted cloud grants and credentials, enforces live membership, and rolls auto-binding back', async () => {
      const x = await cloudFixture();
      const rollback = Error('expected_cloud_rollback');
      const credentialReference = `mcp:${x.connectionId}:r2`;
      let frozen: FrozenMcpTool[] = [];
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_mcp_tool_grants set allowed=true,grant_revision=2 where binding_id=${x.connectionId}`;
          await tx`update allrice_mcp_binding_config set revision=2 where binding_id=${x.connectionId}`;
          await tx`update allrice_connector_bindings set credential_reference=${credentialReference} where id=${x.connectionId}`;
          await tx`update allrice_mcp_member_connections set revision=4 where binding_id=${x.connectionId}`;
          const store = createEmployeeMcpBindingStore();
          frozen = await store.freeze(x.scope, x.employeeId, x.versionId, tx);
          expect(frozen).toHaveLength(1);
          expect(frozen[0]).toMatchObject({
            connectionId: x.connectionId,
            connectionRevision: 2,
            credentialReference,
            memberRevision: 4,
            grantRevision: 2,
            employeeAuthorization: {
              employeeId: x.employeeId,
              employeeVersionId: x.versionId,
              revision: 1,
            },
          });
          await tx`update allrice_mcp_member_connections set connected=false where binding_id=${x.connectionId}`;
          expect(
            await store.freeze(x.scope, x.employeeId, x.versionId, tx),
          ).toEqual([]);
          await tx`update allrice_memberships set active=false where user_id=${x.scope.actorId}`;
          await expect(
            store.freeze(x.scope, x.employeeId, x.versionId, tx),
          ).rejects.toMatchObject({ code: 'MCP_DENIED' });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(client.getDatabase).not.toHaveBeenCalled();
      expect(
        await f.db`select id from allrice_employee_mcp_bindings where employee_id=${x.employeeId}`,
      ).toHaveLength(0);
      const [grant] =
        await f.db`select allowed,grant_revision from allrice_mcp_tool_grants where binding_id=${x.connectionId}`;
      expect(grant).toMatchObject({ allowed: false, grant_revision: 1 });

      // The existing default path still opens exactly its authorization
      // transaction, commits the implicit binding, and then reads frozen tools.
      await f.db`update allrice_mcp_tool_grants set allowed=true where binding_id=${x.connectionId}`;
      vi.mocked(client.getDatabase).mockReturnValue(f.db);
      const begin = vi.spyOn(f.db, 'begin');
      const committed = await createEmployeeMcpBindingStore().freeze(
        x.scope,
        x.employeeId,
        x.versionId,
      );
      expect(begin).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        connectionRevision: 1,
        credentialReference: x.credentialReference,
        memberRevision: 3,
        grantRevision: 1,
      });
      expect(frozen[0]?.credentialReference).toBe(credentialReference);
    });

    it.each(['employee', 'version'] as const)(
      'propagates NOWAIT 55P03 for a locked %s after assignment SHARE, rolling both transactions back',
      async (target) => {
        const x = await cloudFixture();
        const ready = deferred<number>();
        const writerRollback = Error('expected_conflicting_writer_rollback');
        let writerResult: Promise<unknown> = Promise.resolve(undefined);
        let freezeDuration = Infinity;
        try {
          await expect(
            f.db.begin(async (tx) => {
              await tx`set local lock_timeout='5s'`;
              await tx`select id from allrice_employee_assignments where employee_id=${x.employeeId} for share`;
              await tx`update allrice_mcp_tool_grants set allowed=true,grant_revision=7 where binding_id=${x.connectionId}`;
              const [admission] = await tx<{ pid: number }[]>`
                select pg_backend_pid() as pid`;

              writerResult = f.db
                .begin(async (writer) => {
                  await writer`set local lock_timeout='5s'`;
                  if (target === 'employee')
                    await writer`select id from allrice_employees where id=${x.employeeId} for update`;
                  else
                    await writer`select id from allrice_employee_versions where id=${x.versionId} for update`;
                  const [backend] = await writer<{ pid: number }[]>`
                    select pg_backend_pid() as pid`;
                  ready.resolve(backend!.pid);
                  // This waits on the admission's assignment SHARE, forming
                  // the real opposite lock order before freeze is attempted.
                  await writer`update allrice_employee_assignments set active=false where employee_id=${x.employeeId}`;
                  throw writerRollback;
                })
                .then(
                  () => ({ committed: true }),
                  (error: unknown) => {
                    ready.reject(error);
                    return { error };
                  },
                );
              const writerPid = await ready.promise;
              expect(writerPid).not.toBe(admission!.pid);
              await waitForLockWait(tx, admission!.pid, writerPid);

              const started = performance.now();
              try {
                await createEmployeeMcpBindingStore().freeze(
                  x.scope,
                  x.employeeId,
                  x.versionId,
                  tx,
                );
              } finally {
                freezeDuration = performance.now() - started;
              }
              throw Error('expected_employee_lock_conflict');
            }),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          expect(await writerResult).toEqual({ error: writerRollback });
        }
        expect(freezeDuration).toBeLessThan(1000);
        expect(client.getDatabase).not.toHaveBeenCalled();
        const [grant] = await f.db`
          select allowed,grant_revision from allrice_mcp_tool_grants
          where binding_id=${x.connectionId}`;
        expect(grant).toMatchObject({ allowed: false, grant_revision: 1 });
        const [assignment] = await f.db`
          select active from allrice_employee_assignments
          where employee_id=${x.employeeId}`;
        expect(assignment?.active).toBe(true);
        expect(
          await f.db`select id from allrice_employee_mcp_bindings where employee_id=${x.employeeId}`,
        ).toHaveLength(0);
        // Both conflicting transactions have ended, so the same lock order
        // can freeze successfully in a fresh transaction without a statement retry.
        await expect(
          f.db.begin(async (tx) => {
            await tx`select id from allrice_employee_assignments where employee_id=${x.employeeId} for share`;
            expect(
              await createEmployeeMcpBindingStore().freeze(
                x.scope,
                x.employeeId,
                x.versionId,
                tx,
              ),
            ).toEqual([]);
            throw writerRollback;
          }),
        ).rejects.toBe(writerRollback);
        expect(
          await f.db`select id from allrice_employee_mcp_bindings where employee_id=${x.employeeId}`,
        ).toHaveLength(0);
      },
    );

    it('keeps the default employee freeze waiting for an employee writer', async () => {
      const x = await cloudFixture();
      await f.db`update allrice_mcp_tool_grants set allowed=true where binding_id=${x.connectionId}`;
      let freezeResult: Promise<unknown> = Promise.resolve(undefined);
      let finished = false;
      try {
        await f.db.begin(async (writer) => {
          await writer`select id from allrice_employees where id=${x.employeeId} for update`;
          const [backend] = await writer<{ pid: number }[]>`
            select pg_backend_pid() as pid`;
          freezeResult = createEmployeeMcpBindingStore({ database: f.db })
            .freeze(x.scope, x.employeeId, x.versionId)
            .then(
              (tools) => {
                finished = true;
                return { tools };
              },
              (error: unknown) => {
                finished = true;
                return { error };
              },
            );
          await waitForLockWait(writer, backend!.pid);
          expect(finished).toBe(false);
        });
      } finally {
        expect(await freezeResult).toMatchObject({
          tools: [
            {
              connectionId: x.connectionId,
              credentialReference: x.credentialReference,
            },
          ],
        });
      }
      expect(client.getDatabase).not.toHaveBeenCalled();
    });

    it.each(['employee', 'version'] as const)(
      'propagates local NOWAIT 55P03 for a locked %s after assignment SHARE, rolling both transactions back',
      async (target) => {
        const x = await createLocalMcpFixture(f.db, { skill: false });
        const before = await x.store.freeze(x.scope, x.employee, x.version);
        expect(before.connections).toHaveLength(1);
        const beforeBindings = await f.db`
          select id,enabled,grant_revision from allrice_employee_mcp_bindings
          where employee_id=${x.employee} order by id`;
        const ready = deferred<number>();
        const writerRollback = Error('expected_local_writer_rollback');
        let writerResult: Promise<unknown> = Promise.resolve(undefined);
        let freezeDuration = Infinity;
        try {
          await expect(
            f.db.begin(async (tx) => {
              await tx`set local lock_timeout='5s'`;
              await tx`select id from allrice_employee_assignments where employee_id=${x.employee} for share`;
              await tx`update allrice_mcp_binding_config set revision=7 where binding_id=${x.connection.id}`;
              const [admission] = await tx<{ pid: number }[]>`
                select pg_backend_pid() as pid`;
              writerResult = f.db
                .begin(async (writer) => {
                  await writer`set local lock_timeout='5s'`;
                  if (target === 'employee')
                    await writer`select id from allrice_employees where id=${x.employee} for update`;
                  else
                    await writer`select id from allrice_employee_versions where id=${x.version} for update`;
                  const [backend] = await writer<{ pid: number }[]>`
                    select pg_backend_pid() as pid`;
                  ready.resolve(backend!.pid);
                  await writer`update allrice_employee_assignments set active=false where employee_id=${x.employee}`;
                  throw writerRollback;
                })
                .then(
                  () => ({ committed: true }),
                  (error: unknown) => {
                    ready.reject(error);
                    return { error };
                  },
                );
              const writerPid = await ready.promise;
              expect(writerPid).not.toBe(admission!.pid);
              await waitForLockWait(tx, admission!.pid, writerPid);
              const started = performance.now();
              try {
                await createLocalMcpStore().freeze(
                  x.scope,
                  x.employee,
                  x.version,
                  tx,
                );
              } finally {
                freezeDuration = performance.now() - started;
              }
              throw Error('expected_local_employee_lock_conflict');
            }),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          expect(await writerResult).toEqual({ error: writerRollback });
        }
        expect(freezeDuration).toBeLessThan(1000);
        expect(client.getDatabase).not.toHaveBeenCalled();
        const [configuration] = await f.db`
          select revision from allrice_mcp_binding_config
          where binding_id=${x.connection.id}`;
        expect(configuration?.revision).toBe(1);
        const [assignment] = await f.db`
          select active from allrice_employee_assignments
          where employee_id=${x.employee}`;
        expect(assignment?.active).toBe(true);
        expect(
          await f.db`select id,enabled,grant_revision from allrice_employee_mcp_bindings where employee_id=${x.employee} order by id`,
        ).toEqual(beforeBindings);
        await f.db.begin(async (tx) => {
          await tx`select id from allrice_employee_assignments where employee_id=${x.employee} for share`;
          expect(
            await createLocalMcpStore().freeze(
              x.scope,
              x.employee,
              x.version,
              tx,
            ),
          ).toEqual(before);
        });
      },
    );

    it('keeps the default local freeze waiting for an employee writer', async () => {
      const x = await createLocalMcpFixture(f.db, { skill: false });
      const before = await x.store.freeze(x.scope, x.employee, x.version);
      expect(before.connections).toHaveLength(1);
      let freezeResult: Promise<unknown> = Promise.resolve(undefined);
      let finished = false;
      try {
        await f.db.begin(async (writer) => {
          await writer`select id from allrice_employees where id=${x.employee} for update`;
          const [backend] = await writer<{ pid: number }[]>`
            select pg_backend_pid() as pid`;
          freezeResult = x.store.freeze(x.scope, x.employee, x.version).then(
            (snapshot) => {
              finished = true;
              return { snapshot };
            },
            (error: unknown) => {
              finished = true;
              return { error };
            },
          );
          await waitForLockWait(writer, backend!.pid);
          expect(finished).toBe(false);
        });
      } finally {
        expect(await freezeResult).toEqual({ snapshot: before });
      }
      expect(client.getDatabase).not.toHaveBeenCalled();
    });

    it('freezes local configuration, device and tool state through the same transaction and preserves rollback', async () => {
      const x = await createLocalMcpFixture(f.db, { skill: false });
      const revisionId = randomUUID();
      await f.db`insert into allrice_mcp_tool_revisions(id,organization_id,workspace_id,binding_id,tool_name,digest,definition)
      values(${revisionId},${x.org},${x.workspace},${x.connection.id},${fixtureTool.name},${digest(fixtureTool)},${f.db.json(fixtureTool)})`;
      await f.db`insert into allrice_mcp_tool_grants(organization_id,workspace_id,binding_id,tool_name,revision_id,risk)
      values(${x.org},${x.workspace},${x.connection.id},${fixtureTool.name},${revisionId},'read_only')`;
      const begin = vi.spyOn(f.db, 'begin');
      const before = await x.store.freeze(x.scope, x.employee, x.version);
      expect(before.connections).toHaveLength(1);
      expect(before.tools).toEqual([]);
      expect(begin).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
      begin.mockRestore();

      const rollback = Error('expected_local_rollback');
      const configuration = {
        ...x.configuration,
        credential: { id: randomUUID(), revision: 2 },
      };
      let frozen: LocalMcpSnapshot | undefined;
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_local_mcp_config set configuration=${tx.json(configuration)} where binding_id=${x.connection.id}`;
          await tx`update allrice_mcp_binding_config set revision=2 where binding_id=${x.connection.id}`;
          await tx`update allrice_mcp_tool_grants set allowed=true,grant_revision=2 where binding_id=${x.connection.id}`;
          await tx`update allrice_employee_mcp_bindings set grant_revision=2 where employee_id=${x.employee}`;
          const store = createLocalMcpStore();
          frozen = await store.freeze(x.scope, x.employee, x.version, tx);
          expect(frozen.connections).toHaveLength(1);
          expect(frozen.connections[0]).toMatchObject({
            connectionRevision: 2,
            configuration,
            employeeAuthorization: { revision: 2 },
          });
          expect(frozen.tools).toHaveLength(1);
          expect(frozen.tools[0]).toMatchObject({
            toolRevisionId: revisionId,
            grantRevision: 2,
            credentialReference: configuration.credential.id,
            employeeAuthorization: { revision: 2 },
          });
          await tx`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${x.grant}`;
          expect(
            await store.freeze(x.scope, x.employee, x.version, tx),
          ).toEqual({
            connections: [],
            tools: [],
          });
          await tx`update allrice_memberships set active=false where user_id=${x.user}`;
          await expect(
            store.freeze(x.scope, x.employee, x.version, tx),
          ).rejects.toMatchObject({ code: 'MCP_DENIED' });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(client.getDatabase).not.toHaveBeenCalled();
      expect(await x.store.freeze(x.scope, x.employee, x.version)).toEqual(
        before,
      );
      expect(frozen?.connections[0]?.configuration).toEqual(configuration);
    });
  },
);
