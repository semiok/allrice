import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLocalMcpFixture,
  localMcpFixtureTool,
} from './local-mcp.fixture.ts';
import { createMcpStore } from './mcp-connections.ts';
import { runtimePolicyDigest as digest } from './runtime-policy.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  created = false;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p17_local_mcp_${randomUUID().replaceAll('-', '')}`;
const fallbackSchema = `${schema}_fallback`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixture = () => createLocalMcpFixture(db);
suite(
  'P17 actual isolated PG authority/Run/approval/lease; synthetic Bridge receipts, no process or model',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL ?? 'invalid:');
      if (!(
        (url.hostname === '127.0.0.1' &&
          url.port === '5432' &&
          url.pathname === '/allrice_b2' &&
          url.username === 'a123') ||
        (url.hostname === '127.0.0.1' &&
          url.port === '54329' &&
          url.pathname === '/allrice' &&
          url.username === 'allrice')
      ))
        throw Error('Dedicated B2 or CI test database required');
      url.search = '';
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const extensions = await admin<
        { extname: string }[]
      >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
      expect(extensions.map((r) => r.extname).sort()).toEqual([
        'pg_trgm',
        'vector',
      ]);
      await admin.unsafe(`create schema ${schema}`);
      created = true;
      await admin.unsafe(`create schema ${fallbackSchema}`);
      url.searchParams.set(
        'options',
        `-csearch_path=${schema},${fallbackSchema},public`,
      );
      db = postgres(url.toString(), { max: 8, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(name, directory), 'utf8'));
      // CI has a fully migrated public schema. Reproduce its same-name table
      // fallback without reading or changing any shared schema's business data.
      await admin.unsafe(
        `create table ${fallbackSchema}.allrice_bridge_folder_grants (like ${schema}.allrice_bridge_folder_grants including all)`,
      );
      for (const name of [
        'ALLRICE_LOCAL_MCP_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(name, '1');
      vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '0');
    }, 120000);
    afterAll(async () => {
      await db?.end({ timeout: 5 });
      if (created && /^p17_local_mcp_[a-f0-9]{32}$/.test(schema)) {
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.unsafe(`drop schema if exists ${fallbackSchema} cascade`);
      }
      await admin?.end({ timeout: 5 });
      vi.unstubAllEnvs();
    });
    it('persists only scoped local references and keeps cloud transport unable to see this binding', async () => {
      const f = await fixture();
      const [record] =
        await db`select transport,endpoint,credential_envelope from allrice_mcp_binding_config where binding_id=${f.connection.id}`;
      expect(record).toEqual({
        transport: 'local_stdio',
        endpoint: null,
        credential_envelope: null,
      });
      expect(f.connection.credentialStorage).toBe('device_only');
      expect(
        await createMcpStore({
          database: db,
          credentialKey: 'ab'.repeat(32),
        }).list(f.context, f.workspace),
      ).toEqual([]);
      expect(f.beforeBinding).toEqual({ connections: [], tools: [] });
      const frozen = await f.store.freeze(f.scope, f.employee, f.version);
      expect(frozen.connections).toHaveLength(1);
      expect(frozen.tools).toEqual([]);
    });
    it('requires exact approval before dispatch and START; device receipt discovery does not grant tools', async () => {
      const f = await fixture(),
        run = await f.newRun();
      expect(run.snapshot.capabilitySnapshot.grantedCapabilities).toContain(
        'storage:write',
      );
      const operation = await run.create();
      expect(operation.snapshot.status).toBe('waiting_user');
      expect(await f.claim()).toBeNull();
      await f.decide(operation);
      expect(await f.claim(false)).toBeNull();
      const dispatched = await f.start();
      expect(
        (await f.ledger().startOperation(dispatched.input)).mayExecute,
      ).toBe(false);
      await f.ledger().heartbeat({ ...dispatched.input, leaseMs: 30000 });
      const completed = await f.complete(dispatched);
      expect(completed.result.snapshot.status).toBe('succeeded');
      await f.store.acceptDiscovery(
        operation.snapshot.binding.attempt.operationId,
      );
      const [row] = await f.store.list(f.context, f.workspace);
      expect(row!.tools[0]).toMatchObject({
        name: localMcpFixtureTool.name,
        allowed: false,
        available: true,
      });
      expect(
        (await f.store.freeze(f.scope, f.employee, f.version)).tools,
      ).toEqual([]);
    });
    it('activates explicitly selected local MCP/write tools without an unrelated Skill, while retaining operation approval', async () => {
      const f = await createLocalMcpFixture(db, { skill: false });
      const run = await f.newRun();
      expect(run.snapshot.capabilitySnapshot.grantedCapabilities).toContain(
        'storage:write',
      );
      expect((await run.create()).snapshot.status).toBe('waiting_user');
    });
    it('granted discovery is adopted by the next real frozen Run, never inserted into the original Run', async () => {
      const f = await fixture(),
        discovered = await f.grantTool(),
        next = await f.newRun();
      expect(discovered.run.snapshot.schemaVersion).toBe(2);
      if (
        discovered.run.snapshot.schemaVersion !== 2 ||
        next.snapshot.schemaVersion !== 2
      )
        throw Error('v2 expected');
      expect(discovered.run.snapshot.localMcp!.tools).toEqual([]);
      expect(next.snapshot.localMcp!.tools).toHaveLength(1);
      const operation = await next.create('local.mcp.call');
      expect(operation.snapshot.status).toBe('waiting_user');
      expect(await f.claim()).toBeNull();
      await f.decide(operation);
      expect(await f.start()).toBeTruthy();
      const [old] =
        await db`select execution_snapshot from allrice_employee_runs where run_id=${discovered.run.run}`;
      expect(old!.execution_snapshot.localMcp.tools).toEqual([]);
    });
    it('blocks another owner in the same tenant from reading/replacing/granting a device binding', async () => {
      const f = await fixture(),
        other = randomUUID();
      await db`insert into allrice_users(id,email,display_name,password_hash) values(${other},${`${other}@example.test`},'P17 different owner','not-login')`;
      await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${other},'admin')`;
      const context = {
        ...f.context,
        actor: { type: 'user' as const, id: other },
      };
      expect(await f.store.list(context, f.workspace)).toEqual([]);
      await expect(
        f.store.replace(context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          expectedRevision: 1,
          revoke: true,
        }),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
      await expect(
        f.store.create(context, {
          workspaceId: f.workspace,
          name: 'stolen device',
          deviceId: f.device.id,
          folderGrantId: f.grant,
          configuration: f.configuration,
        }),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
      expect(
        (await f.employeeBindings.list(context, f.workspace)).flatMap(
          (target) => target.bindings,
        ),
      ).toEqual([]);
      await expect(
        f.employeeBindings.bind(context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          employeeId: f.employee,
          employeeVersionId: f.version,
          expectedRevision: f.employeeGrant!.revision,
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    });
    it('rejects forged configuration digests before creating a binding', async () => {
      const f = await fixture();
      await expect(
        f.store.create(f.context, {
          workspaceId: f.workspace,
          name: 'tampered',
          deviceId: f.device.id,
          folderGrantId: f.grant,
          configuration: {
            ...f.configuration,
            source: {
              ...f.configuration.source,
              digest: digest('not the source'),
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'MCP_INVALID_SCHEMA' });
    });
    it('rejects unbound, cross-tenant and model-selected process authority before operation creation', async () => {
      const f = await createLocalMcpFixture(db, { bind: false });
      const unbound = await f.newRun();
      await expect(unbound.create()).rejects.toMatchObject({
        code: 'local_mcp_frozen_connection_denied',
      });
      const authorized = await fixture(),
        run = await authorized.newRun();
      await expect(
        run.create('local.mcp.discover', randomUUID(), {
          connectionId: f.connection.id,
        }),
      ).rejects.toMatchObject({ code: 'local_mcp_frozen_connection_denied' });
      for (const extra of [
        { deviceId: f.device.id },
        { path: '/tmp' },
        { credential: { value: 'forged' } },
        { tools: [localMcpFixtureTool] },
      ])
        await expect(
          run.create('local.mcp.discover', randomUUID(), {
            connectionId: authorized.connection.id,
            ...extra,
          }),
        ).rejects.toMatchObject({ name: 'ZodError' });
      await expect(
        authorized.store.freeze(
          { ...authorized.scope, organizationId: f.org },
          authorized.employee,
          authorized.version,
        ),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
      await expect(
        authorized.store.grant(f.context, {
          workspaceId: f.workspace,
          connectionId: authorized.connection.id,
          revisionId: randomUUID(),
          allowed: true,
          risk: 'read_only',
        }),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    });
    it('rejects an explicitly rejected approval and cannot reuse a discovery approval for a second operation', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        rejected = await run.create();
      await f.decide(rejected, 'rejected');
      expect(await f.claim()).toBeNull();
      const approved = await run.create();
      await f.decide(approved);
      const dispatched = await f.start();
      await f.complete(dispatched);
      const unapproved = await run.create();
      expect(unapproved.snapshot.status).toBe('waiting_user');
      expect(await f.claim()).toBeNull();
    });
    const mutations = {
      connection: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await f.store.replace(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          expectedRevision: 1,
          revoke: true,
        });
      },
      credentialRevision: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await f.store.replace(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          expectedRevision: 1,
          configuration: {
            ...f.configuration,
            credential: { id: randomUUID(), revision: 2 },
          },
        });
      },
      employeeBinding: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await f.employeeBindings.bind(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          employeeId: f.employee,
          employeeVersionId: f.version,
          expectedRevision: f.employeeGrant!.revision,
          enabled: false,
        });
      },
      member: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
      },
      folderGeneration: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_bridge_folder_grants set root_fingerprint=${'d'.repeat(64)} where id=${f.grant}`;
        const [grant] =
          await db`select runtime_generation from allrice_bridge_folder_grants where id=${f.grant}`;
        expect(grant!.runtime_generation).toBe(2);
      },
      device: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.device.id}`;
      },
      staleProfile: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp()-interval '5 minutes' where device_id=${f.device.id}`;
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      it(`rechecks ${name} revocation after dispatch before START`, async () => {
        const f = await fixture(),
          run = await f.newRun(),
          operation = await run.create();
        await f.decide(operation);
        const lease = await f.claim();
        expect(lease).not.toBeNull();
        await mutate(f);
        await expect(
          f.ledger().startOperation({
            scope: f.runtimeScope,
            operationId: lease!.snapshot.binding.attempt.operationId,
            leaseToken: lease!.leaseToken,
            attempt: lease!.snapshot.binding.attempt,
            receiptId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        const [row] =
          await db`select snapshot from allrice_runtime_operations where id=${operation.snapshot.binding.attempt.operationId}`;
        expect(row!.snapshot.status).toBe('dispatched');
      });
    }
    it('approval rejects credential rotation and renewal rechecks a later revoke', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        operation = await run.create();
      await mutations.credentialRevision(f);
      await expect(f.decide(operation)).rejects.toMatchObject({
        code: 'local_mcp_authority_changed',
      });
      expect(await f.claim()).toBeNull();
      const current = await f.newRun(),
        second = await current.create();
      await f.decide(second);
      const dispatched = await f.start();
      await f.store.replace(f.context, {
        workspaceId: f.workspace,
        connectionId: f.connection.id,
        expectedRevision: 2,
        revoke: true,
      });
      await expect(
        f.ledger().heartbeat({ ...dispatched.input, leaseMs: 30000 }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    });
    it('rejects canceled or expired worker authority despite a live device and approved operation', async () => {
      for (const expired of [true, false]) {
        const f = await fixture(),
          run = await f.newRun(),
          operation = await run.create();
        await f.decide(operation);
        const dispatched = await f.start();
        if (expired)
          await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 minute' where id=${run.job}`;
        else
          await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${run.job}`;
        await expect(
          f.ledger().heartbeat({ ...dispatched.input, leaseMs: 30000 }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        await expect(run.create()).rejects.toMatchObject({
          code: 'run_or_frozen_configuration_changed',
        });
      }
    });
    it('refuses a forged lease receipt or another tenant scope and never publishes incomplete discovery', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        operation = await run.create();
      const id = operation.snapshot.binding.attempt.operationId;
      await expect(f.store.acceptDiscovery(id)).rejects.toMatchObject({
        code: 'MCP_DISCOVERY_STALE',
      });
      await f.decide(operation);
      const dispatched = await f.start(),
        receipt = f.receiptFor(dispatched);
      await expect(
        f.ledger().recordReceipt({ ...receipt, leaseToken: randomUUID() }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(
        f.ledger().recordReceipt({
          ...receipt,
          scope: { ...f.runtimeScope, workspaceId: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'scope_mismatch' });
      expect((await f.store.list(f.context, f.workspace))[0]!.tools).toEqual(
        [],
      );
      await f.complete(dispatched);
      await f.store.acceptDiscovery(id);
      expect(
        (await f.store.list(f.context, f.workspace))[0]!.tools,
      ).toHaveLength(1);
    });
    it('keeps repeated discovery idempotent and rejects delayed older discovery after a newer result', async () => {
      const f = await fixture(),
        run = await f.newRun();
      const older = await run.create();
      await f.decide(older);
      await f.complete(await f.start(), [
        { ...localMcpFixtureTool, name: 'older.tool' },
      ]);
      const newer = await run.create();
      await f.decide(newer);
      await f.complete(await f.start(), [
        { ...localMcpFixtureTool, name: 'newer.tool' },
      ]);
      const newId = newer.snapshot.binding.attempt.operationId;
      await f.store.acceptDiscovery(newId);
      const first = (await f.store.list(f.context, f.workspace))[0]!.tools;
      await f.store.acceptDiscovery(newId);
      expect((await f.store.list(f.context, f.workspace))[0]!.tools).toEqual(
        first,
      );
      await expect(
        f.store.acceptDiscovery(older.snapshot.binding.attempt.operationId),
      ).rejects.toMatchObject({ code: 'MCP_DISCOVERY_STALE' });
      expect(
        (await f.store.list(f.context, f.workspace))[0]!.tools.map(
          (t) => t.name,
        ),
      ).toEqual(['newer.tool']);
    });
    it('revokes grants when discovery schema changes and requires a new explicit grant and new Run', async () => {
      const f = await fixture();
      await f.grantTool();
      const run = await f.newRun(),
        call = await run.create('local.mcp.call');
      await f.decide(call);
      const lease = await f.claim();
      const changed = await run.create();
      await f.decide(changed);
      await f.complete(await f.start(), [
        {
          ...localMcpFixtureTool,
          inputSchema: {
            type: 'object',
            properties: { limit: { type: 'integer' } },
            additionalProperties: false,
          },
        },
      ]);
      await f.store.acceptDiscovery(
        changed.snapshot.binding.attempt.operationId,
      );
      const tool = (await f.store.list(f.context, f.workspace))[0]!.tools[0]!;
      expect(tool.allowed).toBe(false);
      await expect(
        f.ledger().startOperation({
          scope: f.runtimeScope,
          operationId: lease!.snapshot.binding.attempt.operationId,
          leaseToken: lease!.leaseToken,
          attempt: lease!.snapshot.binding.attempt,
          receiptId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await f.store.grant(f.context, {
        workspaceId: f.workspace,
        connectionId: f.connection.id,
        revisionId: tool.revisionId,
        allowed: true,
        risk: 'read_only',
      });
      await expect(run.create('local.mcp.call')).rejects.toMatchObject({
        code: 'unavailable',
      });
      const next = await f.newRun();
      expect((await next.create('local.mcp.call')).snapshot.status).toBe(
        'waiting_user',
      );
    });
    it('invalid receipt catalog schemas cannot replace a previously valid catalog', async () => {
      const f = await fixture();
      await f.discover();
      const run = await f.newRun(),
        op = await run.create();
      await f.decide(op);
      await f.complete(await f.start(), [
        localMcpFixtureTool,
        localMcpFixtureTool,
      ]);
      await expect(
        f.store.acceptDiscovery(op.snapshot.binding.attempt.operationId),
      ).rejects.toMatchObject({ code: 'MCP_INVALID_SCHEMA' });
      expect(
        (await f.store.list(f.context, f.workspace))[0]!.tools,
      ).toHaveLength(1);
    });
    it('tool revoke after START stops lease renewal without changing the immutable Run catalog', async () => {
      const f = await fixture();
      await f.grantTool();
      const run = await f.newRun(),
        operation = await run.create('local.mcp.call');
      await f.decide(operation);
      const dispatched = await f.start();
      const tool = (await f.store.list(f.context, f.workspace))[0]!.tools[0]!;
      await f.store.grant(f.context, {
        workspaceId: f.workspace,
        connectionId: f.connection.id,
        revisionId: tool.revisionId,
        allowed: false,
        risk: 'read_only',
      });
      await expect(
        f.ledger().heartbeat({ ...dispatched.input, leaseMs: 30000 }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      const [old] =
        await db`select execution_snapshot from allrice_employee_runs where run_id=${run.run}`;
      expect(old!.execution_snapshot.localMcp.tools).toHaveLength(1);
      expect(
        (await f.store.freeze(f.scope, f.employee, f.version)).tools,
      ).toEqual([]);
    });
    it('removed and later restored tools do not recover an old explicit grant', async () => {
      const f = await fixture();
      await f.grantTool();
      await f.discover([]);
      const restored = await f.discover();
      expect(restored.connection.tools[0]).toMatchObject({
        available: true,
        allowed: false,
      });
      expect(
        (await f.store.freeze(f.scope, f.employee, f.version)).tools,
      ).toEqual([]);
    });
    it('rejects tool substitution and freezes exact argument bytes for worker/Bridge schema validation', async () => {
      const f = await fixture();
      await f.grantTool();
      const run = await f.newRun();
      await expect(
        run.create('local.mcp.call', randomUUID(), {
          connectionId: f.connection.id,
          tool: 'not.granted',
          arguments: {},
        }),
      ).rejects.toMatchObject({ code: 'local_mcp_frozen_tool_denied' });
      // Dynamic schema validation belongs to the Broker and the Bridge; this
      // trusted DB entry freezes arguments without silently dropping fields.
      const created = await run.create('local.mcp.call', randomUUID(), {
        connectionId: f.connection.id,
        tool: localMcpFixtureTool.name,
        arguments: { injected: true },
      });
      expect(created.payload.capability).toBe('local.mcp.call');
      if (created.payload.capability !== 'local.mcp.call')
        throw Error('call expected');
      expect(created.payload.arguments.toolArguments).toEqual({
        injected: true,
      });
      expect(created.snapshot.binding.inputDigest).toBe(
        digest(created.payload),
      );
      const stored = await f
        .ledger()
        .readOperationInput(
          f.runtimeScope,
          created.snapshot.binding.attempt.operationId,
        );
      expect(stored.bridgePayload).toEqual(created.payload);
      const [count] =
        await db`select count(*)::integer as n from allrice_runtime_operations where run_id=${run.run}`;
      expect(count!.n).toBe(1);
    });
    it('rejects concurrent stale configuration writes and never hides SQL failure as an empty catalog', async () => {
      const f = await fixture();
      const changes = await Promise.allSettled(
        [1, 2].map(() =>
          f.store.replace(f.context, {
            workspaceId: f.workspace,
            connectionId: f.connection.id,
            expectedRevision: 1,
            configuration: f.configuration,
          }),
        ),
      );
      expect(changes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(changes.find((x) => x.status === 'rejected')).toMatchObject({
        reason: { code: 'MCP_BINDING_CHANGED' },
      });
      expect(
        (await f.store.freeze(f.scope, f.employee, f.version)).connections,
      ).toHaveLength(1);
      // Keep the relation name/OID: removing it lets PostgreSQL legitimately
      // resolve the same name in a later schema (CI's populated public), then
      // retain that prepared relation even after our table is renamed back.
      // A missing selected column instead guarantees a real SQL error against
      // this isolated relation, without weakening the production catch policy.
      await db.unsafe(
        `alter table ${schema}.allrice_bridge_folder_grants rename column runtime_generation to p17_unavailable_runtime_generation`,
      );
      try {
        await expect(
          f.store.freeze(f.scope, f.employee, f.version),
        ).rejects.toMatchObject({ code: '42703' });
      } finally {
        await db.unsafe(
          `alter table ${schema}.allrice_bridge_folder_grants rename column p17_unavailable_runtime_generation to runtime_generation`,
        );
      }
      // The same pool must recover, not a replacement pool with cleared plans.
      expect(
        (await f.store.freeze(f.scope, f.employee, f.version)).connections,
      ).toHaveLength(1);
      const [fallback] = await db.unsafe<{ n: number }[]>(
        `select count(*)::integer as n from ${fallbackSchema}.allrice_bridge_folder_grants`,
      );
      expect(fallback?.n).toBe(0);
    });
    it('discovery after connection rotation is stale even with a genuine applied old receipt', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        operation = await run.create();
      await f.decide(operation);
      await f.complete(await f.start());
      await mutations.credentialRevision(f);
      await expect(
        f.store.acceptDiscovery(operation.snapshot.binding.attempt.operationId),
      ).rejects.toMatchObject({ code: 'MCP_DISCOVERY_STALE' });
      expect((await f.store.list(f.context, f.workspace))[0]!.tools).toEqual(
        [],
      );
    });
    for (const evidence of [
      { stopConfirmed: false },
      { resultKnown: false, tools: undefined },
      { callAttempted: true },
    ])
      it(`rejects non-authoritative discovery evidence ${JSON.stringify(evidence)}`, async () => {
        const f = await fixture(),
          run = await f.newRun(),
          operation = await run.create();
        await f.decide(operation);
        const dispatched = await f.start();
        await f
          .ledger()
          .recordReceipt(
            f.receiptFor(dispatched, [localMcpFixtureTool], evidence),
          );
        await expect(
          f.store.acceptDiscovery(
            operation.snapshot.binding.attempt.operationId,
          ),
        ).rejects.toMatchObject({ code: 'MCP_DISCOVERY_STALE' });
        expect((await f.store.list(f.context, f.workspace))[0]!.tools).toEqual(
          [],
        );
      });
    it('stale attempt facts never publish a catalog; exact receipts replay idempotently and changed replays conflict', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        operation = await run.create();
      await f.decide(operation);
      const dispatched = await f.start(),
        receipt = f.receiptFor(dispatched);
      const stale = await f.ledger().recordReceipt({
        ...receipt,
        receiptId: randomUUID(),
        attempt: { ...receipt.attempt, fence: receipt.attempt.fence + 1 },
      });
      expect(stale.disposition).toBe('stale');
      expect(stale.snapshot.status).toBe('running');
      await expect(
        f.store.acceptDiscovery(operation.snapshot.binding.attempt.operationId),
      ).rejects.toMatchObject({ code: 'MCP_DISCOVERY_STALE' });
      expect((await f.ledger().recordReceipt(receipt)).disposition).toBe(
        'applied',
      );
      expect((await f.ledger().recordReceipt(receipt)).disposition).toBe(
        'duplicate',
      );
      await expect(
        f.ledger().recordReceipt({
          ...receipt,
          evidence: {
            output: { ...receipt.evidence.output, stderr: 'changed replay' },
          },
        }),
      ).rejects.toMatchObject({ code: 'receipt_conflict' });
      await f.store.acceptDiscovery(
        operation.snapshot.binding.attempt.operationId,
      );
      expect(
        (await f.store.list(f.context, f.workspace))[0]!.tools,
      ).toHaveLength(1);
    });
    it('approval also rejects a revoked employee binding and cannot approve a task from an older active Run', async () => {
      const f = await fixture(),
        run = await f.newRun(),
        operation = await run.create();
      await mutations.employeeBinding(f);
      await expect(f.decide(operation)).rejects.toMatchObject({
        code: 'local_mcp_authority_changed',
      });
      const other = await fixture(),
        old = await other.newRun(),
        pending = await old.create();
      await other.newRun();
      await expect(other.decide(pending)).rejects.toMatchObject({
        code: 'local_mcp_authority_changed',
      });
      expect(await other.claim()).toBeNull();
    });
    it('cannot freeze an old device grant after a genuine directory authorization change', async () => {
      const f = await fixture();
      await mutations.folderGeneration(f);
      expect(await f.store.freeze(f.scope, f.employee, f.version)).toEqual({
        connections: [],
        tools: [],
      });
    });
  },
);
