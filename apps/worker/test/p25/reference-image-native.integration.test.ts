import { randomUUID } from 'node:crypto';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReferenceReadsSchema } from '@allrice/contracts';
import * as database from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { referenceToolFixture } from '../../../../packages/database/src/reference-tool.fixture.ts';
import {
  publishReference,
  listReferencePublications,
  changeReferencePublication,
} from '../../../../packages/database/src/reference-library.ts';
import { referenceReadPin } from '../../../../packages/database/src/reference-search.ts';
import {
  executeEmployeeReferenceTool,
  assertEmployeeContentContext,
  loadEmployeeRuntimeReferences,
} from '../../../../packages/database/src/employees/employee-runtime-content.ts';
import { executeRiceTool, riceToolDefinitions } from '../../src/tool-broker.js';
import { dshInboundToolHandler } from '../../src/harness/dsh/tool-bridge.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { p24Fixture } from '../p24/fixture.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('R4a real native image result, provider input and cold history', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let x: Awaited<ReturnType<typeof referenceToolFixture>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
    x = await referenceToolFixture(f);
    const controls = { version: 1, enabled: true, mode: 'execute', rules: [] };
    await f.db`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
      values(${x.context.organizationId},${x.context.workspaceId},1,${f.db.json(controls)})
      on conflict(organization_id,workspace_id) do update set version=excluded.version,controls=excluded.controls`;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  }, 30000);
  it('returns a durable image block, sends image input to the model, and preserves it after revoke plus process restart', async () => {
    const saved = await publishReference(
      x.publisher,
      {
        origin: 'upload',
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        fileName: 'diagram.png',
        mediaType: 'image/png',
        contentBase64: png,
        audience: { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(f.db),
    );
    await f.db`update allrice_knowledge_processing set state='unsupported' where revision_id=${saved.revisionId}`;
    const [reference] = await listReferencePublications(
      x.context,
      x.context.workspaceId!,
      saved.sourceId,
    );
    const pin = referenceReadPin(reference!);
    const run = await x.run(undefined, [saved.revisionId]);
    expect(
      await loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        run.worker,
      ),
    ).toEqual([]);
    const model = await p24Fixture(async (request, index) => {
      if (index === 1) {
        expect(JSON.stringify(request.messages)).not.toContain('image_url');
        return {
          nativeTool: {
            name: 'workspace_reference_read_image',
            arguments: pin,
          },
        };
      }
      expect(JSON.stringify(request.messages)).toContain('image_url');
      expect(JSON.stringify(request.messages)).toContain('data:image/');
      expect(JSON.stringify(request.messages)).toContain('diagram.png');
      return { text: 'Image content received with source R1.' };
    });
    const clients: DshProtocolClient[] = [];
    const notices: DshNotification[] = [];
    const calls: string[] = [];
    const sessionId = 'r4a-' + randomUUID();
    const profile = join(model.root, 'reference-image.cordis.yml');
    async function launch() {
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: profile,
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_OPENAI_COMPATIBLE_MODEL: 'r4a-synthetic',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      clients.push(client);
      client.subscribe((value) => notices.push(value));
      const broker = dshInboundToolHandler({
        tools: riceToolDefinitions.filter(
          (tool) => tool.name === 'workspace.reference.read_image',
        ),
        referenceImage: (call) => client.referenceImagePort(call),
        onToolCall: async (call, options) => {
          calls.push(call.id);
          return executeRiceTool({
            context: run.execution.context,
            capabilities: run.resolved.grantedCapabilities,
            storageRoot: '.unused-reference-image-test',
            sessionId: run.scope.sessionId,
            call,
            executeReferenceTool: (name, args, signal) =>
              executeEmployeeReferenceTool(
                run.scope,
                run.runtime.generationId,
                run.worker,
                name,
                args,
                signal,
                {
                  storage: runtimeFixtureStorage(f.db),
                  native: options!.referenceImage!,
                  call: {
                    id: call.id,
                    name: 'workspace.reference.read_image',
                    nativeSessionId: call.nativeSessionId!,
                  },
                },
              ),
          });
        },
      });
      client.setRequestHandler(async (method, params) => {
        if (method === 'allrice/run-authorize') {
          expect(params.runId).toBe(run.scope.runId);
          expect(params.nativeSessionId).toBe(sessionId);
          await assertEmployeeContentContext(
            run.scope,
            run.runtime.generationId,
            run.worker,
          );
          return { authorized: true };
        }
        return broker(method, params);
      });
      await client.initialize({
        cwd: model.root,
        provider: 'openai-compatible',
        model: 'r4a-synthetic',
        nativeTools: ['workspace.reference.read_image'],
        requireRunAdmission: true,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      return client;
    }
    try {
      await symlink(
        resolve(import.meta.dirname, '../../node_modules'),
        join(model.root, 'node_modules'),
        'dir',
      );
      // Synthetic route only. Production acceptance separately uses its unchanged default route.
      const config = await readFile(
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
        'utf8',
      );
      await writeFile(
        profile,
        config.replace(
          '        api: openai-completions\n',
          '        api: openai-completions\n        defaultInput: [text, image]\n',
        ),
      );
      const client = await launch();
      await client.beginRun(sessionId, run.scope.runId);
      await client.prompt(sessionId, 'Read the selected diagram.');
      await client.wait(sessionId);
      expect(model.requests).toHaveLength(2);
      expect(calls).toHaveLength(1);
      const [row] =
        await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
      const reads = ReferenceReadsSchema.parse(row!.reference_reads);
      expect(reads).toMatchObject([
        {
          readKind: 'image',
          call: { id: calls[0], nativeSessionId: sessionId },
          citation: {
            referenceLabel: 'R1',
            reference: expect.objectContaining(pin),
          },
        },
      ]);
      const imageReceipt = reads[0]!;
      if (imageReceipt.citation.type !== 'reference')
        throw Error('image receipt required');
      const attachment = imageReceipt.citation.locator.image;
      const results = notices
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event as { type: string; data: unknown })
        .filter((e) => e.type === 'tool/result');
      expect(JSON.stringify(results)).toContain(
        JSON.stringify({ type: 'image', attachment }),
      );
      const audits =
        await f.db`select metadata from allrice_audit_events where metadata->>'runId'=${run.scope.runId} and action='tool.execute' and decision='allowed'`;
      expect(
        audits.some(
          (a) =>
            a.metadata.nativeCallId === calls[0] &&
            a.metadata.referenceReceiptId === imageReceipt.receiptId,
        ),
      ).toBe(true);
      await client.endRun(sessionId);
      await client.close();
      await changeReferencePublication(x.publisher, saved.sourceId, {
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'delete',
      });
      const restored = await launch();
      await restored.recover(sessionId);
      await restored.beginRun(sessionId, run.scope.runId);
      await restored.prompt(
        sessionId,
        'Discuss the image already read; do not read new content.',
      );
      await restored.wait(sessionId);
      expect(model.requests).toHaveLength(3);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(model.requests[2]!.messages)).toContain(
        attachment.name,
      );
      await restored.endRun(sessionId);
      const [after] =
        await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(ReferenceReadsSchema.parse(after!.reference_reads)).toEqual(reads);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await model.close();
    }
  }, 60000);
});
