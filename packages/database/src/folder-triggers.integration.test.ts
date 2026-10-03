import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import {
  localFileCapabilities,
  LocalFilePayloadSchema,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import * as client from './core/client.ts';
import {
  createBridgeFolderGrant,
  heartbeatBridgeDevice,
  claimNextBridgeCommand,
  completeBridgeCommand,
  revokeBridgeFolderGrant,
} from './bridge.ts';
import {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
} from './execution/automation.ts';
import {
  receiveFolderTriggerEvent,
  processFolderTriggerEvents,
  listFolderTriggerHistory,
  folderTriggerOptions,
  readFolderTriggerRules,
} from './folder-triggers.ts';
import {
  readLocalFileCommand,
  storeLocalFileUpload,
  enqueueLocalFileCommand,
} from './local-files.ts';
import { inspectLocalFile } from '../../../apps/rice-bridge/src/local-files.js';
import { updateWorkAutomation, getWorkAutomation } from './work-automation.ts';
import { getStoredFile } from './data.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (b: Uint8Array) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;
const stream = (b: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(b);
      c.close();
    },
  });
suite(
  'folder rules preserve current ordinary authority, originals and one durable Run',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      root: string;
    beforeAll(async () => {
      database = await createAssistantFixtureDatabase();
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-folder-db-')),
      );
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 60_000);
    afterAll(async () => {
      vi.restoreAllMocks();
      await database?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function fixture() {
      const f = await createCloudExecutionFixture(database.db, root, {
        memberRole: 'member',
        localProcess: true,
        dsh: {
          provider: {
            provider: 'dsh',
            authMode: 'platform_subscription',
            route: 'openai-codex',
            model: 'gpt-5.6-luna',
            reasoningEffort: 'low',
            credentialReference: 'test:never-resolved',
            baseUrl: null,
          },
          prompt: {
            systemPrompt: 'Synthetic only',
            conversation: [],
            memories: [],
            userRequest: 'Synthetic only',
            imageAttachments: [],
          },
          skills: [
            {
              id: randomUUID(),
              name: 'synthetic-files',
              description: 'Synthetic only',
              content: 'Synthetic only',
              checksum: hash(Buffer.from('Synthetic only')),
              invocation: { modelInvocable: true, userInvocable: false },
              requiredToolRefs: ['local.file.import', 'workspace.file.read'],
            },
          ],
        },
      });
      const deviceId = randomUUID(),
        token = `synthetic-folder-${randomUUID()}`,
        folder = join(root, deviceId);
      await mkdir(folder);
      await database.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${deviceId},${f.org},${f.workspace},${f.user},'Synthetic folder Bridge','macos-x64',2,${localFileCapabilities},${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
      const grant = await createBridgeFolderGrant(token, {
        label: '财务收件',
        rootFingerprint: createHash('sha256').update(folder).digest('hex'),
      });
      await heartbeatBridgeDevice(token, {
        protocolVersion: 2,
        capabilities: [...localFileCapabilities],
        environment: {
          version: 1,
          clientVersion: 'synthetic-new-folder',
          browser: 'unavailable',
          sandbox: 'unavailable',
          preview: 'unavailable',
          paused: false,
          folderTriggerVersion: 1,
          readiness: localFileCapabilities.map((capability) => ({
            capability,
            state: 'ready',
            reason: 'ready',
            missing: [],
            versions: { bridge: 'synthetic-new-folder', binaryFiles: '1' },
            observedAt: new Date().toISOString(),
          })),
        },
      });
      const [a] = await database.db<
        { employee_assignment_id: string }[]
      >`select employee_assignment_id from allrice_chat_sessions where id=${f.session}`;
      // Published versions are immutable. Seed a normal new publication and move
      // the assignment to it instead of mutating the unrelated execution fixture.
      const manifest = employeeManifest({
        key: 'folder-fixture',
        name: 'Folder Fixture',
        description: 'Synthetic fixture only',
        toolNames: ['local.file.import', 'workspace.file.read'],
      });
      const versionId = randomUUID();
      await database.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
    select ${versionId},organization_id,workspace_id,employee_id,version+1,${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${database.db.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${database.db.json(manifest)},${database.db.json(manifest.provider)}
    from allrice_employee_versions where id=(select employee_version_id from allrice_employee_assignments where id=${a!.employee_assignment_id})`;
      await database.db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${a!.employee_assignment_id}`;
      const [g] = await database.db<
        { runtime_generation: number }[]
      >`select runtime_generation from allrice_bridge_folder_grants where id=${grant.id}`;
      const work = await getWorkAutomation(f.context, f.workspace);
      await updateWorkAutomation(f.context, f.workspace, {
        expectedRevision: work.revision,
        capability: 'computer',
        enabled: true,
      });
      const rule = await createAutomation(f.context, {
        workspaceId: f.workspace,
        name: '整理新报表',
        prompt: '读取附件并交付汇总',
        triggerType: 'folder',
        employeeAssignmentId: a!.employee_assignment_id,
        folder: {
          contractVersion: 1,
          deviceId,
          folderGrantId: grant.id,
          folderGrantVersion: g!.runtime_generation,
          relativePath: '.',
          extensions: ['pdf', 'xlsx', 'csv'],
          ignorePaths: ['成果'],
        },
      });
      const path = '季度 报表.csv',
        bytes = Buffer.from('项目,金额\n收入,100\n');
      await writeFile(join(folder, path), bytes);
      const expected = await inspectLocalFile(folder, path);
      const event = {
        eventId: randomUUID(),
        ruleId: rule.id,
        revision: rule.revision,
        grantId: grant.id,
        grantVersion: g!.runtime_generation,
        path,
        expected,
        observedAt: new Date().toISOString(),
      };
      return {
        ...f,
        deviceId,
        token,
        folder,
        rule,
        grant,
        event,
        bytes,
        assignmentId: a!.employee_assignment_id,
      };
    }
    async function importEvent(
      f: Awaited<ReturnType<typeof fixture>>,
      storage = f.storage,
    ) {
      await receiveFolderTriggerEvent(f.token, f.event);
      await processFolderTriggerEvents(16);
      const command = (await claimNextBridgeCommand(f.token))!;
      expect(command).toBeTruthy();
      const payload = LocalFilePayloadSchema.parse(command.payload);
      expect(payload.capability).toBe('local.file.import');
      const object = await storeLocalFileUpload({
        token: f.token,
        kind: 'command',
        id: command.id,
        leaseToken: command.leaseToken,
        version: f.event.expected,
        fileName: f.event.path,
        stream: stream(f.bytes),
        storage,
      });
      await completeBridgeCommand(f.token, command.id, {
        leaseToken: command.leaseToken,
        status: 'succeeded',
        output: {
          contractVersion: 1,
          status: 'uploaded',
          path: f.event.path,
          file: f.event.expected,
          object,
          platformUploaded: true,
          localSaved: false,
        },
        summary: 'uploaded exact bytes',
      });
      return { command, object };
    }
    async function delayedRevoke(
      f: Awaited<ReturnType<typeof fixture>>,
      during: () => Promise<unknown>,
    ) {
      const name = 'folder_revoke_' + randomUUID().replaceAll('-', '');
      await database.db.unsafe(
        `create function ${name}() returns trigger language plpgsql as $$ begin if new.id='${f.grant.id}'::uuid and new.revoked_at is not null then perform pg_sleep(0.4); end if; return new; end $$; create trigger ${name} before update on allrice_bridge_folder_grants for each row execute function ${name}()`,
      );
      const revoking = revokeBridgeFolderGrant(
        f.context,
        f.workspace,
        f.grant.id,
      );
      try {
        // The real revoke function owns the grant row before the competing
        // upload/claim starts. The trigger only provides deterministic timing.
        await vi.waitFor(
          async () => {
            const [waiting] = await database.db<
              { n: number }[]
            >`select count(*)::int as n from pg_stat_activity where wait_event='PgSleep' and query like '%allrice_bridge_folder_grants%'`;
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 2000, interval: 10 },
        );
        const result = await Promise.allSettled([revoking, during()]);
        expect(result[0].status).toBe('fulfilled');
        return result[1];
      } finally {
        await revoking.catch(() => {});
        await database.db.unsafe(
          `drop trigger ${name} on allrice_bridge_folder_grants; drop function ${name}()`,
        );
      }
    }
    it('grant revocation wins final ready without deadlocking an admitted upload', async () => {
      const f = await fixture();
      await receiveFolderTriggerEvent(f.token, f.event);
      await processFolderTriggerEvents(16);
      const command = (await claimNextBridgeCommand(f.token))!;
      let revokeResult:
        Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      const trigger = 'folder_upload_' + randomUUID().replaceAll('-', '');
      const storage = {
        get: f.storage.get.bind(f.storage),
        delete: f.storage.delete.bind(f.storage),
        exists: f.storage.exists.bind(f.storage),
        put: async (...args: Parameters<typeof f.storage.put>) => {
          await f.storage.put(...args);
          const name = trigger;
          await database.db.unsafe(
            `create function ${name}() returns trigger language plpgsql as $$ begin if new.id='${f.grant.id}'::uuid and new.revoked_at is not null then perform pg_sleep(0.4); end if; return new; end $$; create trigger ${name} before update on allrice_bridge_folder_grants for each row execute function ${name}()`,
          );
          const revoke = revokeBridgeFolderGrant(
            f.context,
            f.workspace,
            f.grant.id,
          );
          await vi.waitFor(
            async () => {
              const [waiting] = await database.db<
                { n: number }[]
              >`select count(*)::int as n from pg_stat_activity where wait_event='PgSleep' and query like '%allrice_bridge_folder_grants%'`;
              expect(waiting!.n).toBeGreaterThan(0);
            },
            { timeout: 2000, interval: 10 },
          );
          revokeResult = revoke.then(
            () => ({ ok: true as const }),
            (error) => ({ ok: false as const, error }),
          );
        },
      };
      await expect(
        storeLocalFileUpload({
          token: f.token,
          kind: 'command',
          id: command.id,
          leaseToken: command.leaseToken!,
          version: f.event.expected,
          fileName: f.event.path,
          stream: stream(f.bytes),
          storage,
        }),
      ).rejects.toThrow('authorization_denied');
      expect(await revokeResult).toEqual({ ok: true });
      await database.db.unsafe(
        `drop trigger ${trigger} on allrice_bridge_folder_grants; drop function ${trigger}()`,
      );
      expect(
        (await readLocalFileCommand(f.context, f.workspace, command.id)).status,
      ).toBe('canceled');
      const importPayload = LocalFilePayloadSchema.parse(command.payload);
      if (importPayload.capability !== 'local.file.import')
        throw Error('Expected actual import');
      const [ready] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_storage_objects where id=${importPayload.arguments.object.objectId} and state='ready'`;
      expect(ready!.n).toBe(0);
    });
    it('grant revocation wins a concurrent queued claim without a command/grant lock cycle', async () => {
      const f = await fixture();
      await receiveFolderTriggerEvent(f.token, f.event);
      await processFolderTriggerEvents(16);
      expect(
        await delayedRevoke(f, () => claimNextBridgeCommand(f.token)),
      ).toEqual({ status: 'fulfilled', value: null });
      await processFolderTriggerEvents(16);
      expect(
        (await listFolderTriggerHistory(f.context, f.workspace, f.rule.id))
          .events[0],
      ).toMatchObject({ state: 'blocked', runId: null });
    });
    it('rule renewal and a real heartbeat complete without reversing target/device locks', async () => {
      const f = await fixture();
      const [target] = await database.db<
        { metadata: { environment: unknown } }[]
      >`select metadata from allrice_execution_targets where target_key=${'bridge.' + f.deviceId}`;
      let release!: () => void, locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocking = database.db.begin(async (tx) => {
        await tx`select id from allrice_bridge_folder_grants where id=${f.grant.id} for update`;
        locked();
        await hold;
      });
      await lockReady;
      const renewal = readFolderTriggerRules(f.token);
      try {
        await vi.waitFor(
          async () => {
            const [waiting] = await database.db<
              { n: number }[]
            >`select count(*)::int as n from pg_stat_activity where wait_event='transactionid' and query like '%allrice_bridge_folder_grants%'`;
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 2000, interval: 10 },
        );
        const heartbeat = heartbeatBridgeDevice(f.token, {
          protocolVersion: 2,
          capabilities: [...localFileCapabilities],
          environment: target!.metadata.environment,
        });
        release();
        const [rules] = await Promise.all([renewal, heartbeat, blocking]);
        expect(rules.rules).toHaveLength(1);
        expect(
          (await readFolderTriggerRules(f.token)).rules[0]?.automationId,
        ).toBe(f.rule.id);
      } finally {
        release();
        await blocking;
        await renewal;
      }
    });
    it('keeps a claimed import authorized during its own busy heartbeat, and adopts the exact ready upload after a lost ACK', async () => {
      const f = await fixture();
      await receiveFolderTriggerEvent(f.token, f.event);
      await processFolderTriggerEvents(16);
      const command = (await claimNextBridgeCommand(f.token))!;
      const [target] = await database.db<
        {
          metadata: {
            environment: {
              readiness: {
                capability: string;
                state: string;
                reason: string;
              }[];
            };
          };
        }[]
      >`select metadata from allrice_execution_targets where target_key=${'bridge.' + f.deviceId}`;
      const environment = structuredClone(target!.metadata.environment);
      for (const r of environment.readiness) {
        r.state = 'busy';
        r.reason = 'busy';
      }
      await heartbeatBridgeDevice(f.token, {
        protocolVersion: 2,
        capabilities: [...localFileCapabilities],
        environment,
      });
      const upload = () =>
        storeLocalFileUpload({
          token: f.token,
          kind: 'command',
          id: command.id,
          leaseToken: command.leaseToken!,
          version: f.event.expected,
          fileName: f.event.path,
          stream: stream(f.bytes),
          storage: f.storage,
        });
      const first = await upload();
      expect(await upload()).toEqual(first);
      const [links] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_file_references where object_id=${first.objectId}`;
      expect(links!.n).toBe(1);
      const [objects] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_storage_objects where id=${first.objectId} and state='ready'`;
      expect(objects!.n).toBe(1);
      await updateAutomation(f.context, f.workspace, f.rule.id, {
        expectedRevision: f.rule.revision,
        status: 'paused',
      });
      await expect(upload()).rejects.toThrow();
    });
    it('ACKs an empty input as explicitly blocked, without importing bytes or creating a Session/Run', async () => {
      const f = await fixture();
      await writeFile(join(f.folder, f.event.path), Buffer.alloc(0));
      const event = {
        ...f.event,
        expected: await inspectLocalFile(f.folder, f.event.path),
      };
      expect(await receiveFolderTriggerEvent(f.token, event)).toMatchObject({
        acceptedEventId: event.eventId,
        state: 'blocked',
      });
      expect(await receiveFolderTriggerEvent(f.token, event)).toMatchObject({
        acceptedEventId: event.eventId,
        state: 'blocked',
      });
      await processFolderTriggerEvents(16);
      expect(
        (await listFolderTriggerHistory(f.context, f.workspace, f.rule.id))
          .events[0],
      ).toMatchObject({
        state: 'blocked',
        errorCode: 'EMPTY_INPUT',
        sessionId: null,
        runId: null,
      });
      expect(await claimNextBridgeCommand(f.token)).toBeNull();
    });
    it('adopts the already committed Run even when its ACK is lost and the rule is subsequently paused', async () => {
      const f = await fixture();
      await importEvent(f);
      await processFolderTriggerEvents(16);
      const before = (
        await listFolderTriggerHistory(f.context, f.workspace, f.rule.id)
      ).events[0]!;
      expect(before.runId).toBeTruthy();
      await database.db`update allrice_automation_folder_events set state='import_pending',run_id=null where id=${f.event.eventId}`;
      await updateAutomation(f.context, f.workspace, f.rule.id, {
        expectedRevision: f.rule.revision,
        status: 'paused',
      });
      await processFolderTriggerEvents(16);
      expect(
        (await listFolderTriggerHistory(f.context, f.workspace, f.rule.id))
          .events[0],
      ).toMatchObject({ state: 'queued', runId: before.runId });
      const [runs] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_employee_runs where session_id=${before.sessionId}`;
      expect(runs!.n).toBe(1);
    });
    it('durably ACKs duplicate events, rejects altered bytes and foreign rules', async () => {
      const f = await fixture();
      const first = await receiveFolderTriggerEvent(f.token, f.event);
      expect(await receiveFolderTriggerEvent(f.token, f.event)).toEqual(first);
      expect(
        await receiveFolderTriggerEvent(f.token, {
          ...f.event,
          eventId: randomUUID(),
        }),
      ).toMatchObject({ eventId: f.event.eventId });
      await expect(
        receiveFolderTriggerEvent(f.token, { ...f.event, path: '其他.csv' }),
      ).rejects.toThrow();
      const other = await fixture();
      await expect(
        receiveFolderTriggerEvent(other.token, f.event),
      ).rejects.toThrow();
      const [count] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_automation_folder_events where automation_id=${f.rule.id}`;
      expect(count!.n).toBe(1);
    });
    it('imports verified original bytes before admission, and reuses one Session and Run across lost ACKs', async () => {
      const f = await fixture();
      const { object } = await importEvent(f);
      expect((await getStoredFile(f.context, object.objectId)).state).toBe(
        'ready',
      );
      await processFolderTriggerEvents(16);
      await processFolderTriggerEvents(16);
      const h = await listFolderTriggerHistory(
        f.context,
        f.workspace,
        f.rule.id,
      );
      expect(h.events[0]).toMatchObject({ state: 'queued' });
      expect(h.events[0]!.runId).toBeTruthy();
      const [count] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_automation_runs where folder_event_id=${f.event.eventId}`;
      expect(count!.n).toBe(1);
      const [row] = await database.db<
        { reserved_session_id: string }[]
      >`select reserved_session_id from allrice_automation_folder_events where id=${f.event.eventId}`;
      const [sessions] = await database.db<
        { n: number }[]
      >`select count(*)::int as n from allrice_chat_sessions where id=${row!.reserved_session_id}`;
      expect(sessions!.n).toBe(1);
      expect(await readFile(join(f.folder, f.event.path))).toEqual(f.bytes);
    });
    it('pause after input begins wins the final ready transaction and prevents a Run', async () => {
      const f = await fixture();
      await receiveFolderTriggerEvent(f.token, f.event);
      await processFolderTriggerEvents(16);
      const command = (await claimNextBridgeCommand(f.token))!;
      const put = f.storage.put.bind(f.storage);
      const storage = {
        get: f.storage.get.bind(f.storage),
        delete: f.storage.delete.bind(f.storage),
        exists: f.storage.exists.bind(f.storage),
        put: async (...args: Parameters<typeof put>) => {
          await put(...args);
          await updateAutomation(f.context, f.workspace, f.rule.id, {
            expectedRevision: f.rule.revision,
            status: 'paused',
          });
        },
      };
      await expect(
        storeLocalFileUpload({
          token: f.token,
          kind: 'command',
          id: command.id,
          leaseToken: command.leaseToken,
          version: f.event.expected,
          fileName: f.event.path,
          stream: stream(f.bytes),
          storage,
        }),
      ).rejects.toThrow('authorization_denied');
      await processFolderTriggerEvents(16);
      const h = await listFolderTriggerHistory(
        f.context,
        f.workspace,
        f.rule.id,
      );
      expect(h.events[0]).toMatchObject({ state: 'blocked', runId: null });
    });
    it('current persisted computer OFF blocks automatic work and retains manual import semantics', async () => {
      const f = await fixture();
      await receiveFolderTriggerEvent(f.token, f.event);
      const old = await getWorkAutomation(f.context, f.workspace);
      await updateWorkAutomation(f.context, f.workspace, {
        expectedRevision: old.revision,
        capability: 'computer',
        enabled: false,
      });
      await processFolderTriggerEvents(16);
      expect(
        (await listFolderTriggerHistory(f.context, f.workspace, f.rule.id))
          .events[0],
      ).toMatchObject({ state: 'blocked', runId: null });
      const manual = await enqueueLocalFileCommand(f.context, {
        workspaceId: f.workspace,
        deviceId: f.deviceId,
        folderGrantId: f.grant.id,
        idempotencyKey: randomUUID(),
        sessionId: f.session,
        action: 'import',
        path: f.event.path,
        expected: f.event.expected,
      });
      expect(manual.status).toBe('queued');
    });
    it('rejects stale edits, scheduled/manual substitutes and output-directory events', async () => {
      const f = await fixture();
      await expect(
        updateAutomation(f.context, f.workspace, f.rule.id, {
          expectedRevision: 99,
          status: 'paused',
        }),
      ).rejects.toThrow();
      await expect(
        runAutomationNow(f.context, f.workspace, f.rule.id),
      ).rejects.toThrow();
      await expect(
        receiveFolderTriggerEvent(f.token, {
          ...f.event,
          eventId: randomUUID(),
          path: '成果/结果.csv',
        }),
      ).rejects.toThrow();
      const choices = await folderTriggerOptions(f.context, f.workspace);
      expect(choices.devices.find((d) => d.id === f.deviceId)).toMatchObject({
        ready: true,
      });
      await deleteAutomation(f.context, f.workspace, f.rule.id);
      expect(
        (
          await listAutomations(f.context, f.workspace, 'folder')
        ).automations.some((r) => r.id === f.rule.id),
      ).toBe(false);
      await expect(
        receiveFolderTriggerEvent(f.token, f.event),
      ).rejects.toThrow();
    });
  },
);
