import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localFileCapabilities, type RequestContext } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import {
  bridgeDeviceStatus,
  claimNextBridgeCommand,
  completeBridgeCommand,
  createBridgeFolderGrant,
  heartbeatBridgeDevice,
} from './bridge.ts';
import {
  enqueueLocalFileCommand,
  localFileTransferAuthority,
  readLocalFileCommand,
  storeLocalFileUpload,
} from './local-files.ts';
import {
  createLocalBinaryFileOperation,
  waitLocalCommandOperation,
} from './local-command-service.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { setRuntimePolicyControls } from './runtime-policy.ts';
import { updateWorkAutomation } from './work-automation.ts';
import { getStoredFile } from './data.ts';
import {
  executeLocalFile,
  inspectLocalFile,
} from '../../../apps/rice-bridge/src/local-files.js';
import { RuntimeBridgeOperationClient } from '../../../apps/rice-bridge/src/operation-client.js';
import { BridgeJournal } from '../../../apps/rice-bridge/src/journal.js';
import { createRuntimeBridgeHttpHandler } from '../../../apps/web/lib/bridge/operation-http.ts';
import * as storageRuntime from '../../../apps/web/lib/storage/runtime.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
suite(
  'MET164 PR3 existing commands, storage and real Run ledger in isolated PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      root: string;
    // Next routes have their own bundler typecheck; load the actual implementation
    // at runtime without pulling that bundler graph into this NodeNext project.
    type FileHandler = (
      request: Request,
      route: { params: Promise<{ kind: string; id: string }> },
    ) => Promise<Response>;
    let fileRoute: { GET: FileHandler; POST: FileHandler };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-local-files-db-')),
      );
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
      fileRoute = await vi.importActual(
        '../../../apps/web/app/api/v1/bridge/device/file-transfers/[kind]/[id]/route.ts',
      );
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function fixture() {
      const tools = localFileCapabilities.filter(
        (n) => n !== 'local.file.select',
      );
      const f = await createCloudExecutionFixture(database.db, root, {
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
              name: 'synthetic-file-handoff',
              description: 'Synthetic only',
              content: 'Synthetic only',
              checksum: checksum(Buffer.from('Synthetic only')),
              invocation: { modelInvocable: true, userInvocable: false },
              requiredToolRefs: tools,
            },
          ],
        },
      });
      const deviceId = randomUUID(),
        token = `synthetic-files-${randomUUID()}`,
        folder = join(root, deviceId, '目录 空格');
      await mkdir(folder, { recursive: true });
      await database.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${deviceId},${f.org},${f.workspace},${f.user},'Synthetic file Bridge','macos-x64',2,${localFileCapabilities},${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
      const grant = await createBridgeFolderGrant(token, {
        label: '目录 空格',
        rootFingerprint: createHash('sha256').update(folder).digest('hex'),
      });
      await heartbeatBridgeDevice(token, {
        protocolVersion: 2,
        capabilities: localFileCapabilities,
        environment: {
          version: 1,
          clientVersion: 'synthetic-file-regression',
          browser: 'unavailable',
          sandbox: 'unavailable',
          preview: 'unavailable',
          paused: false,
          readiness: localFileCapabilities.map((capability) => ({
            capability,
            state: 'ready',
            reason: 'ready',
            missing: [],
            versions: { bridge: 'synthetic-file-regression', binaryFiles: '1' },
            observedAt: new Date().toISOString(),
          })),
        },
      });
      await setRuntimePolicyControls(
        f.context,
        {
          version: 2,
          enabled: true,
          mode: 'execute',
          rules: tools.map((action) => ({ action, effect: 'allow' as const })),
        },
        1,
        database.db,
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 2, capability: 'computer', enabled: true },
        database.db,
      );
      return { ...f, deviceId, token, grant, folder };
    }
    const request = (
      f: Awaited<ReturnType<typeof fixture>>,
      action: string,
      extra: Record<string, unknown> = {},
    ) => ({
      workspaceId: f.workspace,
      deviceId: f.deviceId,
      folderGrantId: f.grant.id,
      idempotencyKey: randomUUID(),
      sessionId: f.session,
      action,
      ...extra,
    });
    it('inspect→import verifies real byte checksum/size, links the existing attachment and keeps ACK retries idempotent', async () => {
      const f = await fixture(),
        path = '中文 输入.xlsx',
        bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe, 0, 1]);
      await writeFile(join(f.folder, path), bytes);
      const expected = await inspectLocalFile(f.folder, path);
      const input = request(f, 'import', { path, expected });
      const queued = await enqueueLocalFileCommand(f.context, input);
      expect(await enqueueLocalFileCommand(f.context, input)).toMatchObject({
        id: queued.id,
        status: 'queued',
      });
      const command = (await claimNextBridgeCommand(f.token))!;
      expect(command.id).toBe(queued.id);
      const object = await storeLocalFileUpload({
        token: f.token,
        kind: 'command',
        id: command.id,
        leaseToken: command.leaseToken,
        version: expected,
        fileName: path,
        stream: stream(bytes),
        storage: f.storage,
      });
      const stored = await getStoredFile(f.context, object.objectId);
      expect(
        Buffer.from(
          await new Response(await f.storage.get(stored.object)).arrayBuffer(),
        ),
      ).toEqual(bytes);
      const output = {
        contractVersion: 1,
        status: 'uploaded',
        path,
        file: expected,
        object,
        platformUploaded: true,
        localSaved: false,
      };
      const receipt = {
        leaseToken: command.leaseToken,
        status: 'succeeded',
        output,
        summary: 'uploaded exact bytes',
      };
      expect(await completeBridgeCommand(f.token, command.id, receipt)).toEqual(
        { status: 'succeeded' },
      );
      expect(await completeBridgeCommand(f.token, command.id, receipt)).toEqual(
        { status: 'succeeded' },
      );
      const [link] =
        await database.db`select object_id from allrice_file_references where object_id=${object.objectId} and session_id=${f.session}`;
      expect(link?.object_id).toBe(object.objectId);
      expect(
        await readLocalFileCommand(f.context, f.workspace, command.id),
      ).toMatchObject({ status: 'succeeded', output });
      await expect(
        enqueueLocalFileCommand(f.context, {
          ...input,
          path: 'different.xlsx',
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(
        completeBridgeCommand(f.token, command.id, {
          ...receipt,
          output: {
            ...output,
            status: 'saved',
            platformUploaded: false,
            localSaved: true,
          },
        }),
      ).rejects.toThrow();
    });
    it('does not trust declared checksum/size or a StoragePort that acknowledges without consuming verified bytes', async () => {
      const f = await fixture(),
        expected = {
          checksum: checksum(Buffer.from('expected')),
          sizeBytes: 8,
          mediaType: 'application/pdf',
          version: checksum(Buffer.from('inode')),
        };
      const queued = await enqueueLocalFileCommand(
          f.context,
          request(f, 'import', { path: '输入.pdf', expected }),
        ),
        command = (await claimNextBridgeCommand(f.token))!;
      const upload = (storage = f.storage, bytes = Buffer.from('tampered')) =>
        storeLocalFileUpload({
          token: f.token,
          kind: 'command' as const,
          id: queued.id,
          leaseToken: command.leaseToken,
          version: expected,
          fileName: '输入.pdf',
          stream: stream(bytes),
          storage,
        });
      await expect(upload()).rejects.toThrow();
      const [row] =
        await database.db`select state from allrice_storage_objects where id=${command.payload.capability === 'local.file.import' ? command.payload.arguments.object.objectId : randomUUID()}`;
      expect(row?.state).toBe('deleted');
      const queued2 = await enqueueLocalFileCommand(
          f.context,
          request(f, 'select'),
        ),
        command2 = (await claimNextBridgeCommand(f.token))!;
      await expect(
        storeLocalFileUpload({
          token: f.token,
          kind: 'command',
          id: queued2.id,
          leaseToken: command2.leaseToken,
          version: expected,
          fileName: '输入.pdf',
          stream: stream(Buffer.from('expected')),
          storage: {
            put: async () => {},
            get: (object) => f.storage.get(object),
            delete: (object) => f.storage.delete(object),
            exists: (object) => f.storage.exists(object),
          },
        }),
      ).rejects.toThrow();
      const [ready] =
        await database.db`select count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and id<>${f.object.id} and state='ready'`;
      expect(ready?.n).toBe(0);
    });
    it('does not lend commands to legacy devices, stale folder generations or another Session owner', async () => {
      const f = await fixture(),
        q = await enqueueLocalFileCommand(
          f.context,
          request(f, 'inspect', { path: 'report.pdf' }),
        );
      await database.db`update allrice_bridge_devices set capabilities=array['local.fs.list'] where id=${f.deviceId}`;
      expect(await claimNextBridgeCommand(f.token)).toBeNull();
      await database.db`update allrice_bridge_devices set capabilities=${localFileCapabilities} where id=${f.deviceId}`;
      const c = (await claimNextBridgeCommand(f.token))!;
      await database.db`update allrice_bridge_folder_grants set root_fingerprint=${createHash('sha256').update('changed folder').digest('hex')} where id=${f.grant.id}`;
      await expect(
        localFileTransferAuthority(f.token, 'command', q.id, c.leaseToken),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      const other = randomUUID(),
        session = randomUUID(),
        membership = randomUUID();
      await database.db`insert into allrice_users(id,email,display_name,password_hash) values(${other},${`${other}@example.test`},'other fixture','not-login')`;
      await database.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${f.org},${f.workspace},${other},'admin')`;
      const [assigned] =
        await database.db`select employee_id,employee_version_id from allrice_employee_assignments where user_id=${f.user} and workspace_id=${f.workspace}`;
      const assignment = randomUUID();
      await database.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${f.org},${f.workspace},${assigned!.employee_id},${assigned!.employee_version_id},${other})`;
      await database.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${f.org},${f.workspace},${other},'other session',${assignment},${assigned!.employee_version_id})`;
      await expect(
        enqueueLocalFileCommand(
          f.context,
          request(f, 'select', { sessionId: session }),
        ),
      ).rejects.toThrow();
      const context: RequestContext = {
        ...f.context,
        actor: { type: 'user', id: other },
        memberships: [
          {
            id: membership,
            organizationId: f.org,
            workspaceId: f.workspace,
            userId: other,
            role: 'admin',
            active: true,
          },
        ],
      };
      await expect(
        readLocalFileCommand(context, f.workspace, q.id),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('cancels locally and reconciles physical bytes after unknown without replaying the old command', async () => {
      const f = await fixture(),
        bytes = Buffer.from('%PDF exact synthetic original'),
        object = await f.upload(bytes, 'application/pdf');
      const input = request(f, 'save', {
        path: '已保存.pdf',
        objectId: object.id,
        checksum: object.checksum,
      });
      const q = await enqueueLocalFileCommand(f.context, input),
        c = (await claimNextBridgeCommand(f.token))!;
      if (c.payload.capability !== 'local.file.save')
        throw Error('save expected');
      await executeLocalFile(f.folder, c.payload, {
        authorize: async () => true,
        transport: {
          download: async () => stream(bytes),
          upload: async () => {
            throw Error('no upload');
          },
        },
      });
      await database.db`update allrice_bridge_commands set timeout_at=clock_timestamp()-interval '1 second' where id=${q.id}`;
      expect(
        await readLocalFileCommand(f.context, f.workspace, q.id),
      ).toMatchObject({ status: 'unknown', output: null });
      expect(await enqueueLocalFileCommand(f.context, input)).toMatchObject({
        id: q.id,
        status: 'unknown',
      });
      expect(await claimNextBridgeCommand(f.token)).toBeNull();
      expect(await readFile(join(f.folder, '已保存.pdf'))).toEqual(bytes);
      const inspect = await enqueueLocalFileCommand(
          f.context,
          request(f, 'inspect', { path: '已保存.pdf' }),
        ),
        ic = (await claimNextBridgeCommand(f.token))!;
      if (ic.payload.capability !== 'local.file.inspect')
        throw Error('inspect expected');
      const output = await executeLocalFile(f.folder, ic.payload, {
        authorize: async () => true,
        transport: {
          download: async () => {
            throw Error('no read from platform');
          },
          upload: async () => {
            throw Error('no write');
          },
        },
      });
      await completeBridgeCommand(f.token, inspect.id, {
        leaseToken: ic.leaseToken,
        status: 'succeeded',
        summary: 'physical file verified',
        output,
      });
      expect(output.file.checksum).toBe(object.checksum);
      const canceled = await enqueueLocalFileCommand(
        f.context,
        request(f, 'select'),
      );
      expect(
        await readLocalFileCommand(f.context, f.workspace, canceled.id, true),
      ).toMatchObject({ status: 'canceled' });
      expect(await claimNextBridgeCommand(f.token)).toBeNull();
      const running = await enqueueLocalFileCommand(
          f.context,
          request(f, 'select'),
        ),
        rc = (await claimNextBridgeCommand(f.token))!;
      expect(
        await readLocalFileCommand(f.context, f.workspace, running.id, true),
      ).toMatchObject({ status: 'claimed', cancelRequested: true });
      await expect(
        localFileTransferAuthority(
          f.token,
          'command',
          running.id,
          rc.leaseToken,
        ),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      await completeBridgeCommand(f.token, running.id, {
        leaseToken: rc.leaseToken,
        status: 'canceled',
        summary: 'native picker closed',
      });
    });
    it('executes real Run file inspect/import/save through existing v2 HTTP+SQLite without a sandbox profile', async () => {
      const f = await fixture(),
        path = '模型 输入.docx',
        bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe]);
      await writeFile(join(f.folder, path), bytes);
      const http = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: bridgeDeviceStatus,
        ledgerForDevice: async (d) =>
          createGovernedBridgeOperationLedger(d, { database: database.db }),
      });
      vi.spyOn(storageRuntime, 'getStorageAdapter').mockReturnValue(f.storage);
      const server = createServer(async (incoming, outgoing) => {
        try {
          const request = new Request(`http://127.0.0.1${incoming.url}`, {
            method: incoming.method,
            headers: new Headers(
              Object.entries(incoming.headers).flatMap(([k, v]) =>
                v === undefined
                  ? []
                  : [
                      [k, Array.isArray(v) ? v.join(',') : v] as [
                        string,
                        string,
                      ],
                    ],
              ),
            ),
            ...(incoming.method === 'GET'
              ? {}
              : { body: Readable.toWeb(incoming), duplex: 'half' }),
          } as RequestInit);
          const file = /\/file-transfers\/(command|operation)\/([^?]+)/.exec(
            incoming.url ?? '',
          );
          let response: Response;
          if (file) {
            const route = {
              params: Promise.resolve({ kind: file[1]!, id: file[2]! }),
            };
            response = await (incoming.method === 'GET'
              ? fileRoute.GET(request, route)
              : fileRoute.POST(request, route));
          } else {
            const action =
              /\/operations\/(?:([^/]+)\/)?(next|start|receipts)$/.exec(
                incoming.url ?? '',
              );
            if (!action) throw Error('unknown synthetic route');
            response = await http(
              request,
              action[2] as 'next' | 'start' | 'receipts',
              action[1],
            );
          }
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          if (response.body)
            Readable.fromWeb(response.body as never).pipe(outgoing);
          else outgoing.end();
        } catch {
          outgoing.writeHead(500).end();
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('loopback missing');
      const origin = `http://127.0.0.1:${address.port}`,
        journal = await BridgeJournal.open({
          directory: join(root, `journal-${f.deviceId}`),
          server: origin,
          deviceId: f.deviceId,
        });
      const native = new RuntimeBridgeOperationClient({
        token: f.token,
        journal,
        config: {
          server: origin,
          deviceId: f.deviceId,
          deviceName: 'Synthetic',
          grants: [{ ...f.grant, rootPath: f.folder }],
        },
      });
      try {
        const inspect = await createLocalBinaryFileOperation(
          {
            context: f.execution,
            capability: 'local.file.inspect',
            arguments: { path },
            callId: 'inspect',
          },
          database.db,
        );
        expect(inspect.snapshot.status).toBe('ready');
        expect(await native.pollOnce()).toBe(true);
        expect(
          await waitLocalCommandOperation(inspect, undefined, database.db),
        ).toMatchObject({ status: 'succeeded' });
        const expected = await inspectLocalFile(f.folder, path),
          input = {
            context: f.execution,
            capability: 'local.file.import' as const,
            arguments: { path, expected },
            callId: 'import',
          };
        const imported = await createLocalBinaryFileOperation(
          input,
          database.db,
        );
        expect(await native.pollOnce()).toBe(true);
        const result = await waitLocalCommandOperation(
          imported,
          undefined,
          database.db,
        );
        expect(result.status).toBe('succeeded');
        const object = await getStoredFile(
          f.context,
          (result.evidence as { output: { object: { objectId: string } } })
            .output.object.objectId,
        );
        const saved = await createLocalBinaryFileOperation(
          {
            context: f.execution,
            capability: 'local.file.save',
            arguments: {
              path: '模型 副本.docx',
              objectId: object.object.id,
              checksum: object.object.checksum,
            },
            callId: 'save',
          },
          database.db,
        );
        expect(await native.pollOnce()).toBe(true);
        expect(
          await waitLocalCommandOperation(saved, undefined, database.db),
        ).toMatchObject({ status: 'succeeded' });
        expect(await readFile(join(f.folder, '模型 副本.docx'))).toEqual(bytes);
        expect(
          (await createLocalBinaryFileOperation(input, database.db)).snapshot
            .binding.attempt.operationId,
        ).toBe(imported.snapshot.binding.attempt.operationId);
        expect(await native.pollOnce()).toBe(false);
        const [count] =
          await database.db`select count(*)::int as n from allrice_bridge_runtime_profiles where device_id=${f.deviceId}`;
        expect(count?.n).toBe(0);
        const [cloud] =
          await database.db`select count(*)::int as n from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id where o.run_id=${f.run}`;
        expect(cloud?.n).toBe(0);
      } finally {
        await journal.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }, 30000);
  },
);
